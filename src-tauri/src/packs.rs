// 角色素材包：扫描内置 / 用户 / 外部目录，兼容原项目 videos/ 目录约定与 JSON。
// 完整官方分件包（core + extra1..6）合并后可能新增目录、多个 manifest、上千段动画；
// 这里按「元数据 actions 优先 + 目录自动发现补全 + 去重」处理，不依赖固定目录清单。
use crate::paths::Roots;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub const VIDEO_EXT: &[&str] = &["webm", "mp4", "m4v", "mov", "gif", "apng", "png", "webp"];
const CATS: &[&str] = &["idle", "turn", "idle_turn", "move", "click", "drag", "random", "events"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Clip {
    pub name: String,
    pub src: String,
    pub category: String,
    pub no_mirror: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Stride {
    pub stride: f64,
    pub curve: Option<Vec<f64>>,
}

/// 角色人格（pixup-pet-asset-v1 persona）
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Persona {
    #[serde(default, alias = "systemPrompt")]
    pub system_prompt: String,
    #[serde(default, alias = "selfTalk")]
    pub self_talk: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 点击音效配置（pixup-pet-asset-v1 audio）
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AudioCfg {
    #[serde(default)]
    pub click: String,
    #[serde(default, alias = "clickVolume")]
    pub click_volume: f64,
    #[serde(default, alias = "throttleMs")]
    pub throttle_ms: u64,
}

/// 媒体格式配置（pixup-pet-asset-v1 media）
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MediaCfg {
    #[serde(default)]
    pub formats: Vec<String>,
    #[serde(default, alias = "safariDir")]
    pub safari_dir: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CharacterPack {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub theme: String,
    pub format: String,
    pub canvas: [u32; 2],
    pub feet_y: u32,
    pub fps: u32,
    pub scale: f64,
    pub body_box: Option<[u32; 4]>,
    pub head_box: Option<[u32; 4]>,
    pub clips: BTreeMap<String, Vec<Clip>>,
    pub strides: BTreeMap<String, Stride>,
    pub no_mirror: Vec<String>,
    pub source: String,
    pub path: String,
    /// 清单 source.url（对象形式），供导出署名；无则为扫描来源
    #[serde(default)]
    pub source_url: String,
    /// 新格式能力字段（旧包为空）
    #[serde(default)]
    pub persona: Option<Persona>,
    #[serde(default)]
    pub audio: Option<AudioCfg>,
    #[serde(default)]
    pub media: Option<MediaCfg>,
    #[serde(default)]
    pub recipe: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ExternalEntry {
    pub id: String,
    pub path: String,
}

#[derive(Default, Deserialize)]
struct Meta {
    #[serde(alias = "feetY", alias = "feet_y")]
    feet_y: Option<u32>,
    #[serde(alias = "bodyBox", alias = "body_box")]
    body_box: Option<[u32; 4]>,
    #[serde(alias = "headBox", alias = "head_box")]
    head_box: Option<[u32; 4]>,
    #[serde(alias = "noMirror", alias = "no_mirror")]
    no_mirror: Option<Vec<String>>,
}

fn read_json(dir: &Path, names: &[&str]) -> Result<Option<Value>, String> {
    for n in names {
        let p = dir.join(n);
        if p.is_file() {
            let s = fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            let v: Value = serde_json::from_str(&s)
                .map_err(|e| format!("{} JSON 解析失败: {e}", p.display()))?;
            return Ok(Some(v));
        }
    }
    Ok(None)
}

// 官方分件包可能把 manifest 放在角色根或 videos/ 下，且多个分件各带一份。
// 返回 (JSON 所在目录, Value)，actions 里的相对路径以该目录为基准解析。
fn read_meta(root: &Path, videos: &Path) -> Result<Vec<(PathBuf, Value)>, String> {
    let mut out = Vec::new();
    let candidates = [
        root.join("config.json"),       // pixup-pet-asset-v1 统一清单优先
        root.join("character.json"),
        root.join("manifest.json"),
        videos.join("character.json"),
        videos.join("manifest.json"),
    ];
    for p in candidates {
        if !p.is_file() { continue; }
        let s = fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        let v: Value = serde_json::from_str(&s)
            .map_err(|e| format!("{} JSON 解析失败: {e}", p.display()))?;
        out.push((p.parent().unwrap_or(root).to_path_buf(), v));
    }
    Ok(out)
}

// 字段优先级：character.json > root/manifest.json > videos/character.json > videos/manifest.json
fn merge_values(list: &[(PathBuf, Value)]) -> Value {
    let mut m = Map::new();
    for (_, v) in list {
        if let Value::Object(o) = v {
            for (k, val) in o {
                m.entry(k.clone()).or_insert_with(|| val.clone());
            }
        }
    }
    Value::Object(m)
}

fn as_box(v: Option<&Value>) -> Option<[u32; 4]> {
    let a = v?.as_array()?;
    if a.len() != 4 { return None; }
    Some([
        a[0].as_u64()? as u32, a[1].as_u64()? as u32,
        a[2].as_u64()? as u32, a[3].as_u64()? as u32,
    ])
}

fn as_strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|i| i.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn parse_strides(v: &Value) -> BTreeMap<String, Stride> {
    let mut out = BTreeMap::new();
    if let Value::Object(m) = v {
        for (k, val) in m {
            let s = match val {
                Value::Number(n) => Stride { stride: n.as_f64().unwrap_or(120.0), curve: None },
                Value::Object(o) => Stride {
                    stride: o.get("stride").and_then(Value::as_f64).unwrap_or(120.0),
                    curve: o.get("curve").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_f64).collect()),
                },
                _ => continue,
            };
            out.insert(k.clone(), s);
        }
    }
    out
}

// 兼容官方/社区的多种动作映射写法：对象映射、{files:[...]}、数组条目。
fn parse_actions(v: &Value) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let put = |out: &mut BTreeMap<String, Vec<String>>, cat: &str, list: Vec<String>| {
        if !cat.is_empty() && !list.is_empty() {
            out.entry(cat.to_string()).or_default().extend(list);
        }
    };
    for key in ["actions", "clips", "categories", "animation_groups", "groups"] {
        let Some(val) = v.get(key) else { continue };
        match val {
            Value::Object(m) => for (cat, item) in m {
                let list = match item {
                    Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
                    Value::Object(o) => as_strings(o.get("files")).into_iter()
                        .chain(as_strings(o.get("clips"))).collect(),
                    _ => Vec::new(),
                };
                put(&mut out, cat, list);
            },
            Value::Array(a) => for item in a {
                if let Value::Object(o) = item {
                    let cat = o.get("category").or_else(|| o.get("cat")).and_then(Value::as_str).unwrap_or("");
                    let list = as_strings(o.get("files")).into_iter()
                        .chain(as_strings(o.get("clips"))).collect();
                    put(&mut out, cat, list);
                }
            },
            _ => {}
        }
    }
    out
}

fn is_video(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 素材包 id：只留 ASCII 字母数字/-/_，最长 48 字符（Windows 路径长度与可读性折中），
/// 非纯 ASCII 时补 6 位哈希保证稳定不撞名；CON/PRN 这类设备名会被拼掉。
pub fn safe_id(s: &str) -> String {
    const MAX: usize = 48;
    const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5",
        "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];
    if !s.is_empty() && s.len() <= MAX
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !RESERVED.contains(&s.to_ascii_lowercase().as_str())
    {
        return s.to_string();
    }
    let mut out: String = s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(MAX)
        .collect();
    if out.is_empty() { out = "pack".into(); }
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    out = format!("{out}-{:06x}", h & 0xffffff);
    out
}

// WebView2 在 Windows 只认 http://<scheme>.localhost 作为自定义协议源
pub const ORIGIN: &str = if cfg!(windows) { "http://pet.localhost" } else { "pet://localhost" };

fn url(root_token: &str, base: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(base).unwrap_or(file);
    let mut s = format!("{ORIGIN}/{root_token}");
    for c in rel.components() {
        let seg = c.as_os_str().to_string_lossy();
        s.push('/');
        s.push_str(&percent_encoding::utf8_percent_encode(&seg, percent_encoding::NON_ALPHANUMERIC).to_string());
    }
    s
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() { collect(&p, out); }
        else if is_video(&p) { out.push(p); }
    }
}

// 一次排序，不在每层递归重复 sort（分件合并后可达上千文件）。
fn collect_sorted(dir: &Path) -> Vec<PathBuf> {
    let mut v = Vec::new();
    collect(dir, &mut v);
    v.sort();
    v
}

fn apply_meta(pack: &mut CharacterPack, v: &Value) {
    let m: Meta = serde_json::from_value(v.clone()).unwrap_or_default();
    if let Some(x) = v.get("format").and_then(Value::as_str) { pack.format = x.into(); }
    if let Some(x) = v.get("id").and_then(Value::as_str) { pack.id = safe_id(x); }
    if let Some(x) = v.get("name").and_then(Value::as_str) { pack.name = x.into(); }
    if let Some(x) = v.get("prompt").and_then(Value::as_str) { pack.prompt = x.into(); }
    if let Some(x) = v.get("theme").and_then(Value::as_str) { pack.theme = x.into(); }
    if let Some(x) = v.get("source") {
        pack.source_url = x.get("url").and_then(Value::as_str)
            .or_else(|| x.as_str())
            .unwrap_or("").to_string();
    }
    if let Some(x) = v.get("persona") { pack.persona = serde_json::from_value(x.clone()).ok(); }
    if let Some(x) = v.get("audio") { pack.audio = serde_json::from_value(x.clone()).ok(); }
    if let Some(x) = v.get("media") { pack.media = serde_json::from_value(x.clone()).ok(); }
    if let Some(x) = v.get("recipe").and_then(Value::as_str) { pack.recipe = x.into(); }
    if let Some(a) = v.get("canvas").and_then(Value::as_array) {
        if a.len() == 2 { pack.canvas = [a[0].as_u64().unwrap_or(640) as u32, a[1].as_u64().unwrap_or(360) as u32]; }
    }
    if let Some(x) = v.get("fps").and_then(Value::as_u64) { pack.fps = x as u32; }
    if let Some(x) = v.get("scale").and_then(Value::as_f64) { pack.scale = x; }
    if let Some(x) = m.feet_y { pack.feet_y = x; }
    pack.body_box = as_box(v.get("bodyBox")).or(as_box(v.get("body_box"))).or(m.body_box);
    pack.head_box = as_box(v.get("headBox")).or(as_box(v.get("head_box"))).or(m.head_box);
    let mut nm = as_strings(v.get("noMirror"));
    if nm.is_empty() { nm = as_strings(v.get("no_mirror")); }
    if nm.is_empty() { nm = m.no_mirror.unwrap_or_default(); }
    pack.no_mirror = nm;
    if let Some(st) = v.get("strides").or_else(|| v.get("move_strides")) {
        pack.strides.extend(parse_strides(st));
    }
}

fn resolve_clip(
    base: &Path, root: &Path, videos: &Path, rel: &str,
    by_stem: &HashMap<String, Vec<PathBuf>>,
) -> Option<PathBuf> {
    let r = rel.trim().replace('\\', "/");
    let r = r.trim_start_matches("./").trim_start_matches('/');
    if r.is_empty() { return None; }
    for c in [base.join(r), root.join(r), videos.join(r)] {
        if c.is_file() { return Some(c); }
    }
    // 只写了动画名（省略目录/扩展名）时按 stem 回退
    let stem = Path::new(r).file_stem()?.to_string_lossy().to_string();
    by_stem.get(&stem).and_then(|v| v.first().cloned())
}

fn push_clip(
    pack: &mut CharacterPack, cat: &str, name: String, src: String,
    seen: &mut HashSet<(String, String)>,
) {
    if !seen.insert((cat.to_string(), src.clone())) { return; }
    pack.clips.entry(cat.to_string()).or_default().push(Clip {
        name, src, category: cat.to_string(), no_mirror: false,
    });
}

pub fn build(root: &Path, token: &str, source: &str) -> Result<CharacterPack, String> {
    let videos = if root.join("videos").is_dir() { root.join("videos") } else { root.to_path_buf() };
    let mut pack = CharacterPack {
        id: safe_id(root.file_name().unwrap_or_default().to_string_lossy().as_ref()),
        name: root.file_name().unwrap_or_default().to_string_lossy().to_string(),
        prompt: String::new(),
        theme: "#2f7fbf".into(),
        canvas: [640, 360],
        feet_y: 330,
        fps: 24,
        scale: 0.72,
        source: source.into(),
        path: root.to_string_lossy().to_string(),
        ..Default::default()
    };

    let metas = read_meta(root, &videos)?;
    if !metas.is_empty() { apply_meta(&mut pack, &merge_values(&metas)); }
    if let Some(v) = read_json(&videos, &["strides.json", "move_strides.json"])? {
        pack.strides.extend(parse_strides(&v));
    }
    if let Some(v) = read_json(&videos, &["text_clips.json"])? {
        let mut n = as_strings(v.get("noMirror"));
        if n.is_empty() { n = as_strings(v.get("no_mirror")); }
        pack.no_mirror.extend(n);
    }

    let all = collect_sorted(&videos);
    let mut by_stem: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for f in &all {
        if let Some(s) = f.file_stem() {
            by_stem.entry(s.to_string_lossy().to_string()).or_default().push(f.clone());
        }
    }
    let base = root.parent().unwrap_or(root);
    let mut seen: HashSet<(String, String)> = HashSet::new();

    // 1) 元数据显式动作映射优先（可跨多个 manifest 累积）。
    for (dir, v) in &metas {
        for (cat, list) in parse_actions(v) {
            for rel in list {
                let Some(f) = resolve_clip(dir, root, &videos, &rel, &by_stem) else { continue };
                let name = f.file_stem().unwrap_or_default().to_string_lossy().to_string();
                push_clip(&mut pack, &cat, name, url(token, base, &f), &mut seen);
            }
        }
    }

    // 2) 目录自动发现补全：actions 未列出的动画、以及完全无 JSON 的包。
    //    未知一级目录并入 random，并把目录名写进 name 前缀，让菜单按前缀分组。
    if let Ok(rd) = fs::read_dir(&videos) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() { continue; }
            let key = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            let known = CATS.contains(&key.as_str());
            let cats: Vec<&str> = match key.as_str() {
                "idle_turn" => vec!["idle", "turn"],
                k if CATS.contains(&k) => vec![k],
                _ => vec!["random"],
            };
            for f in collect_sorted(&p) {
                let stem = f.file_stem().unwrap_or_default().to_string_lossy().to_string();
                let name = if known { stem } else { format!("{key}-{stem}") };
                let src = url(token, base, &f);
                for c in &cats { push_clip(&mut pack, c, name.clone(), src.clone(), &mut seen); }
            }
        }
        for e in fs::read_dir(&videos).into_iter().flatten().flatten() {
            let f = e.path();
            if !f.is_file() || !is_video(&f) { continue; }
            let name = f.file_stem().unwrap_or_default().to_string_lossy().to_string();
            push_clip(&mut pack, "random", name, url(token, base, &f), &mut seen);
        }
    }

    // 3) no_mirror 统一结算 + idle 兜底
    let names = pack.no_mirror.clone();
    for list in pack.clips.values_mut() {
        for c in list.iter_mut() {
            c.no_mirror = names.iter().any(|n| !n.is_empty() && c.name.contains(n));
        }
    }
    if pack.clips.get("idle").map_or(true, Vec::is_empty) {
        if let Some(first) = pack.clips.values().find(|v| !v.is_empty()).cloned() {
            pack.clips.insert("idle".into(), first);
        }
    }
    Ok(pack)
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten()
        .map(|e| e.path()).filter(|p| p.is_dir()).collect();
    v.sort();
    v
}

pub fn scan(roots: &Roots, external: &[ExternalEntry]) -> Vec<CharacterPack> {
    let mut out = Vec::new();
    for d in subdirs(&roots.builtin) {
        if let Ok(p) = build(&d, "b", "builtin") { out.push(p); }
    }
    for d in subdirs(&roots.user) {
        if let Ok(p) = build(&d, "u", "user") { out.push(p); }
    }
    for e in external {
        let d = PathBuf::from(&e.path);
        if d.is_dir() {
            if let Ok(p) = build(&d, &format!("e-{}", e.id), "external") { out.push(p); }
        }
    }
    if out.is_empty() {
        if let Ok(p) = build(&roots.builtin, "b", "builtin") { out.push(p); }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    let mut seen = HashSet::new();
    let mut uniq = Vec::new();
    for mut p in out {
        if seen.contains(&p.id) {
            let base = p.id.clone();
            let mut n = 1;
            while seen.contains(&format!("{base}-{n}")) { n += 1; }
            p.id = format!("{base}-{n}");
        }
        seen.insert(p.id.clone());
        uniq.push(p);
    }
    uniq
}

pub fn load_external(roots: &Roots) -> Vec<ExternalEntry> {
    fs::read_to_string(roots.data.join("external.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<ExternalEntry>>(&s).ok())
        .unwrap_or_default()
}

pub fn save_external(roots: &Roots, list: &[ExternalEntry]) -> Result<(), String> {
    let p = roots.data.join("external.json");
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(list).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

const ZIP_MAX_ENTRIES: usize = 4096;
const ZIP_MAX_BYTES: u64 = 800 * 1024 * 1024;

fn extract_zip(zip_path: &Path, dst: &Path) -> Result<(), String> {
    let f = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut ar = zip::ZipArchive::new(f).map_err(|e| format!("ZIP 打开失败: {e}"))?;
    if ar.len() > ZIP_MAX_ENTRIES {
        return Err(format!("素材包条目过多（{} > {ZIP_MAX_ENTRIES}）", ar.len()));
    }
    let names: Vec<String> = (0..ar.len()).filter_map(|i| ar.by_index(i).ok().map(|x| x.name().to_string())).collect();
    let prefix = names.iter()
        .filter(|n| !n.ends_with('/'))
        .map(|n| n.split('/').next().unwrap_or(""))
        .reduce(|a, b| if a == b { a } else { "" })
        .filter(|s| !s.is_empty() && names.iter().all(|n| n.starts_with(&format!("{s}/"))))
        .map(|s| format!("{s}/"));
    let _ = fs::create_dir_all(dst);
    let mut written: u64 = 0;
    for i in 0..ar.len() {
        let mut e = ar.by_index(i).map_err(|e| e.to_string())?;
        let raw = e.name().replace('\\', "/");
        if raw.contains("\0") { continue; }
        let rel = prefix.as_deref().and_then(|p| raw.strip_prefix(p)).unwrap_or(&raw);
        if rel.is_empty() { continue; }
        let target = dst.join(rel);
        if Path::new(rel).components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) { continue; }
        if e.is_dir() { let _ = fs::create_dir_all(&target); continue; }
        if let Some(parent) = target.parent() { let _ = fs::create_dir_all(parent); }
        let mut w = fs::File::create(&target).map_err(|e| e.to_string())?;
        // 边写边计数：zip 头里的 size 可以伪造，只能按实际落盘字节兜底
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = e.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            written += n as u64;
            if written > ZIP_MAX_BYTES {
                let _ = fs::remove_dir_all(dst);
                return Err(format!("素材包解压后超过 {} MB，已中止", ZIP_MAX_BYTES / 1024 / 1024));
            }
            w.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn import(roots: &Roots, external: &mut Vec<ExternalEntry>, input: &str) -> Result<String, String> {
    let p = PathBuf::from(input);
    if !p.exists() { return Err("路径不存在".into()); }
    let clip_count = |pack: &CharacterPack| -> usize { pack.clips.values().map(Vec::len).sum() };

    if p.is_file() {
        if !p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("zip")).unwrap_or(false) {
            return Err("仅支持文件夹或 .zip 素材包".into());
        }
        // 与文件夹导入一致：同名不覆盖，换个后缀装（覆盖会连带删掉已装好的包）
        let base = safe_id(p.file_stem().unwrap_or_default().to_string_lossy().as_ref());
        let mut id = base.clone();
        let mut n = 1;
        while roots.user.join(&id).exists() { id = format!("{base}-{n}"); n += 1; }
        let dst = roots.user.join(&id);
        extract_zip(&p, &dst)?;
        return match build(&dst, "u", "user") {
            Ok(pack) if clip_count(&pack) > 0 => Ok(pack.id),
            Ok(_) => { let _ = fs::remove_dir_all(&dst); Err("压缩包里没有可用的视频素材".into()) }
            Err(e) => { let _ = fs::remove_dir_all(&dst); Err(e) }
        };
    }

    let probe = build(&p, "e-probe", "external")?;
    if clip_count(&probe) == 0 { return Err("目录里没有可用的视频素材（支持 idle/turn/move/click/drag/random 子目录）".into()); }
    let base = safe_id(p.file_name().unwrap_or_default().to_string_lossy().as_ref());
    let mut id = base.clone();
    let mut n = 1;
    while external.iter().any(|e| e.id == id) { id = format!("{base}-{n}"); n += 1; }
    external.push(ExternalEntry { id: id.clone(), path: p.to_string_lossy().to_string() });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_pack_scans_with_original_layout() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/characters/shenshen");
        let p = build(&root, "b", "builtin").unwrap();
        assert_eq!(p.id, "shenshen");
        assert!(p.clips.get("idle").map_or(false, |v| !v.is_empty()));
        assert!(p.clips.get("random").map_or(false, |v| v.len() > 50));
        assert!(p.clips.get("turn").map_or(false, |v| !v.is_empty()));
        assert!(p.clips.get("move").map_or(false, |v| v.len() >= 3));
        assert!(p.body_box.is_some() && p.head_box.is_some());
        assert!(!p.strides.is_empty());
        assert!(!p.no_mirror.is_empty());
        assert!(p.clips["idle"][0].src.starts_with(&format!("{ORIGIN}/b/shenshen/videos/")));
    }

    #[test]
    fn new_format_config_json_is_preferred_and_parsed() {
        let base = std::env::temp_dir().join(format!("pixup-pet-fmt-{}", std::process::id()));
        let root = base.join("mycat");
        let v = root.join("videos/idle");
        fs::create_dir_all(&v).unwrap();
        fs::write(v.join("待机.webm"), b"fake").unwrap();
        // 同时放旧 character.json 与新 config.json，验证新格式优先且新字段解析
        fs::write(root.join("character.json"), r#"{"id":"old","name":"旧"}"#).unwrap();
        fs::write(root.join("config.json"), r##"{
            "format":"pixup-pet-asset-v1","id":"mycat","name":"我的猫","theme":"#abc",
            "persona":{"systemPrompt":"你是猫","selfTalk":["喵"],"tags":["可爱"]},
            "audio":{"click":"sounds/click.wav","clickVolume":0.6,"throttleMs":120},
            "media":{"formats":["webm","mov"],"safariDir":"videos-mov"},
            "recipe":"recipe.md",
            "source":{"label":"x","url":"https://example.com/pet"},
            "actions":{"idle":["videos/idle/待机.webm"]}
        }"##).unwrap();
        let p = build(&root, "u", "user").unwrap();
        assert_eq!(p.format, "pixup-pet-asset-v1");
        assert_eq!(p.id, "mycat");
        assert_eq!(p.name, "我的猫");
        assert_eq!(p.persona.as_ref().unwrap().system_prompt, "你是猫");
        assert_eq!(p.persona.as_ref().unwrap().self_talk, vec!["喵"]);
        assert_eq!(p.audio.as_ref().unwrap().throttle_ms, 120);
        assert_eq!(p.media.as_ref().unwrap().safari_dir, "videos-mov");
        assert_eq!(p.source_url, "https://example.com/pet");
        assert_eq!(p.recipe, "recipe.md");
        assert_eq!(p.clips["idle"].len(), 1);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn all_nine_builtin_packs_are_discoverable() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/characters");
        let dirs = subdirs(&root);
        assert_eq!(dirs.len(), 9, "应内置 9 位角色");
        for d in &dirs {
            let p = build(d, "b", "builtin").unwrap();
            let n: usize = p.clips.values().map(Vec::len).sum();
            assert!(n > 0, "{} 没有可用动画", p.id);
            assert!(p.name.chars().any(|c| !c.is_ascii()), "{} 缺少中文名", p.id);
            assert!(p.clips.get("idle").map_or(false, |v| !v.is_empty()), "{} 缺少待机", p.id);
        }
    }

    // 模拟 core + extra1..6 合并后的结构：多分类、未知目录、videos/manifest.json 带 actions、
    // 以及 actions 未列出的散落动画。验证全部被发现且无重复。
    #[test]
    fn merged_official_packs_are_fully_discovered() {
        let base = std::env::temp_dir().join(format!("pixup-pet-merge-{}", std::process::id()));
        let root = base.join("shenshen");
        let v = root.join("videos");
        for d in ["idle", "move", "random", "events", "节日限定"] {
            fs::create_dir_all(v.join(d)).unwrap();
        }
        fs::create_dir_all(v.join("events/balance")).unwrap();
        fs::write(v.join("idle/待机.webm"), b"x").unwrap();
        fs::write(v.join("move/左转奔跑.webm"), b"x").unwrap();
        fs::write(v.join("random/吃饭.webm"), b"x").unwrap();
        fs::write(v.join("random/写代码.webm"), b"x").unwrap();
        fs::write(v.join("events/balance/平衡.webm"), b"x").unwrap();
        fs::write(v.join("节日限定/写福字.webm"), b"x").unwrap();
        fs::write(v.join("散落动画.webm"), b"x").unwrap();
        fs::write(v.join("manifest.json"), r#"{
            "body_box":[212,60,428,330],
            "head_box":[185,60,436,195],
            "actions":{"idle":["idle/待机.webm"],"move":["move/左转奔跑.webm"]},
            "no_mirror":["写代码"]
        }"#).unwrap();

        let p = build(&root, "b", "builtin").unwrap();
        let all: Vec<&Clip> = p.clips.values().flat_map(|x| x.iter()).collect();
        assert_eq!(p.body_box, Some([212, 60, 428, 330]));
        assert_eq!(p.clips["idle"].len(), 1, "actions 与目录扫描需去重");
        assert_eq!(p.clips["move"].len(), 1);
        assert!(p.clips["random"].iter().any(|c| c.name == "写代码" && c.no_mirror));
        assert!(p.clips["random"].iter().any(|c| c.name == "节日限定-写福字"), "未知目录需带前缀归入 random");
        assert!(p.clips["random"].iter().any(|c| c.name == "散落动画"), "根目录散落视频不可丢");
        assert!(p.clips["events"].iter().any(|c| c.name == "平衡"), "标准目录嵌套子目录需递归收集");
        let mut srcs: Vec<&str> = all.iter().map(|c| c.src.as_str()).collect();
        srcs.sort();
        let before = srcs.len();
        srcs.dedup();
        // idle_turn / 多分类允许同一 src 出现在不同 category，这里仅检查 random 桶内不重复
        let mut rsrc: Vec<&str> = p.clips["random"].iter().map(|c| c.src.as_str()).collect();
        rsrc.sort();
        rsrc.dedup();
        assert_eq!(rsrc.len(), p.clips["random"].len());
        assert!(before >= 7);
        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod import_tests {
    use super::*;

    #[test]
    fn custom_character_json_actions_are_mapped() {
        let base = std::env::temp_dir().join(format!("pixup-pet-pack-{}", std::process::id()));
        let root = base.join("mycat");
        let v = root.join("videos");
        fs::create_dir_all(v.join("idle")).unwrap();
        fs::write(v.join("idle/待机.webm"), b"fake").unwrap();
        fs::write(root.join("character.json"), r#"{
            "id":"mycat","name":"我的猫","canvas":[640,360],"bodyBox":[10,20,100,200],
            "actions":{"idle":["videos/idle/待机.webm"]}
        }"#).unwrap();
        let p = build(&root, "u", "user").unwrap();
        assert_eq!(p.id, "mycat");
        assert_eq!(p.name, "我的猫");
        assert_eq!(p.body_box, Some([10, 20, 100, 200]));
        assert_eq!(p.clips["idle"].len(), 1);
        assert!(p.clips["idle"][0].src.starts_with(&format!("{ORIGIN}/u/mycat/videos/")));
        let _ = fs::remove_dir_all(&base);
    }
}

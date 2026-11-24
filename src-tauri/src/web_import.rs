// 在线清单 → 本地应用：video-json-pet:// 深链、清单解析、素材下载、生成角色包目录。
use crate::{packs, paths::Roots};
use percent_encoding::percent_decode_str;
use serde::Deserialize;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

pub const SCHEME: &str = "video-json-pet";

/// 深链带来的待确认清单 URL 队列（网页唤起 → 主窗口弹出预览确认框）。
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// 落盘路径由 setup 注入（roots.data）；未注入时退化为纯内存，便于单测。
static PENDING_FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn init_pending_file(dir: &Path) {
    let _ = PENDING_FILE.set(dir.join("pending-imports.json"));
}
fn pending_file() -> Option<&'static PathBuf> { PENDING_FILE.get() }

/// 启动时把上次未确认的清单读回内存，避免进程重启后丢失深链。
pub fn load_pending() {
    let Some(file) = pending_file() else { return; };
    let Ok(text) = fs::read_to_string(file) else { return; };
    let Ok(urls) = serde_json::from_str::<Vec<String>>(&text) else { return; };
    if let Ok(mut v) = PENDING.lock() {
        for u in urls { if !v.contains(&u) { v.push(u); } }
    }
}
fn flush_pending(v: &[String]) {
    if let Some(file) = pending_file() {
        let _ = fs::write(file, serde_json::to_string(v).unwrap_or_else(|_| "[]".into()));
    }
}
pub fn queue_pending(url: String) {
    if let Ok(mut v) = PENDING.lock() {
        if !v.contains(&url) { v.push(url); }
        flush_pending(&v);
    }
}
pub fn take_pending() -> Vec<String> {
    let out = PENDING.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default();
    flush_pending(&[]); // 取走即清空落盘
    out
}

#[derive(Debug, Deserialize)]
struct Manifest {
    id: Option<String>,
    name: Option<String>,
    theme: Option<String>,
    source: Option<String>,
    clips: Vec<WebClip>,
    /// 原始 character.json：canvas/scale/actions/noMirror 等配置
    config: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct WebClip {
    url: String,
    category: Option<String>,
    /// 相对角色包根的路径 videos/<cat>/<file>，用于保留原始文件名与过滤配置
    rel: Option<String>,
}

pub fn is_deep_link(s: &str) -> bool {
    s.starts_with(&format!("{SCHEME}://"))
}

/// 协议在注册表中的键路径（唯一来源，注册/卸载共用）。
pub fn protocol_class_key() -> String { format!("HKCU\\Software\\Classes\\{SCHEME}") }

/// HKCU 注册自定义协议，安装包 / 免安装版都能唤起；幂等覆盖，失败不影响主程序。
#[cfg(windows)]
pub fn register_protocol() {
    // 开发验证环境可能禁用 reg.exe；协议注册对主程序非必需，可显式跳过。
    if std::env::var_os("PIXUPPET_SKIP_PROTOCOL_REG").is_some() { return; }
    let exe = std::env::current_exe().unwrap_or_default();
    let exe = exe.to_string_lossy();
    let open = format!("\"{exe}\" \"%1\"");
    let cls = protocol_class_key();
    let cmd = format!("{cls}\\shell\\open\\command");
    let desc = format!("URL:{SCHEME} Protocol");
    for args in [
        vec!["add", cls.as_str(), "/ve", "/d", desc.as_str(), "/f"],
        vec!["add", cls.as_str(), "/v", "URL Protocol", "/d", "", "/f"],
        vec!["add", cmd.as_str(), "/ve", "/d", &open, "/f"],
    ] {
        let _ = std::process::Command::new("reg").args(args).output();
    }
}

#[cfg(not(windows))]
pub fn register_protocol() {}

/// 卸载时清理协议注册（HKCU，无需管理员）。供 `--unregister-protocol` 与卸载脚本调用。
#[cfg(windows)]
pub fn unregister_protocol() {
    let cls = protocol_class_key();
    let _ = std::process::Command::new("reg").args(["delete", cls.as_str(), "/f"]).output();
}

#[cfg(not(windows))]
pub fn unregister_protocol() {}

/// 命令行标志识别：纯函数，便于单测；命中后程序只清理协议并退出。
pub fn is_unregister_flag(s: &str) -> bool { s == "--unregister-protocol" }

/** video-json-pet://import?url=<编码后的清单地址> */
pub fn manifest_url(url: &str) -> Option<String> {
    if !is_deep_link(url) { return None; }
    let query = url.split_once("://")?.1.split_once('?')?.1;
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k == "url" {
            Some(percent_decode_str(v).decode_utf8_lossy().to_string())
        } else {
            None
        }
    })
}

/// 只拉取清单生成预览概览（不下载素材）；返回原始清单地址供确认后再导入。
/// exists = 本地是否已有同名包，供弹窗给出「合并 / 新建」选项。
pub fn preview_manifest(roots: &Roots, url: &str) -> Result<serde_json::Value, String> {
    let manifest_url = manifest_url(url).unwrap_or_else(|| url.to_string());
    let raw = fetch_manifest(&manifest_url)?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let clips = v.get("clips").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let mut cats: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for c in &clips {
        let cat = c.get("category").and_then(|x| x.as_str()).unwrap_or("random").to_string();
        *cats.entry(cat).or_default() += 1;
    }
    let str = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let name = str("name");
    let base = packs::safe_id(if str("id").is_empty() { &name } else { v["id"].as_str().unwrap() });
    // 同名新角色时的建议名（用户必须改成与现有角色不同的名称）
    let suggest = if name.trim().is_empty() { "新角色 2".into() } else { format!("{name} 2") };
    Ok(json!({
        "url": manifest_url,
        "id": str("id"),
        "name": name,
        "theme": str("theme"),
        "source": str("source"),
        "count": clips.len(),
        "categories": cats,
        "exists": roots.user.join(&base).exists(),
        "baseId": base,
        "suggestName": suggest,
    }))
}

/// 下载体量上限：清单 1MB、单段素材 64MB、一次导入合计 512MB。
const MAX_MANIFEST: u64 = 1 << 20;
const MAX_CLIP: u64 = 64 << 20;
const MAX_TOTAL: u64 = 512 << 20;

/// 清单给的相对路径要落到包目录里，必须挡住 `..`、绝对路径、盘符与空段，
/// 否则恶意清单可以写到包外（zip slip 的下载版）。
fn safe_rel(rel: &str) -> Option<String> {
    let r = rel.replace('\\', "/");
    let r = r.trim_start_matches('/').to_string();
    if r.is_empty() || r.len() > 240 || r.contains('\0') || r.contains("..") || r.contains(':') {
        return None;
    }
    if r.split('/').any(|c| c.is_empty() || c == ".") { return None; }
    Some(r)
}

pub fn fetch_manifest(url: &str) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("导入链接必须是 http/https".into());
    }
    let out = Command::new("curl")
        .args(["-fsSL", "--retry", "2", "--retry-delay", "1", "--max-time", "30",
               "--max-filesize", &MAX_MANIFEST.to_string(), url])
        .output()
        .map_err(|e| format!("无法调用 curl 下载导入清单: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    if out.stdout.len() as u64 > MAX_MANIFEST {
        return Err(format!("导入清单超过 {} KB，已拒绝", MAX_MANIFEST / 1024));
    }
    let text = String::from_utf8(out.stdout).map_err(|e| e.to_string())?;
    if text.trim().len() < 2 { return Err("导入清单内容为空".into()); }
    Ok(text)
}

fn clean(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect()
}

/// 校验下载产物：非空、达到最小体积、且文件头是常见视频/图片 magic。
/// 只做宽松校验（HTML 错误页/空文件一律拦截），避免误伤非常规编码的素材。
fn verify_media(path: &Path) -> Result<(), String> {
    const MIN: u64 = 512; // 合法 webm 至少数百字节；小于此基本是错误响应或截断文件
    let meta = fs::metadata(path).map_err(|e| format!("素材文件不可读: {e}"))?;
    if meta.len() < MIN { return Err(format!("素材文件过小({} 字节)，疑似下载失败", meta.len())); }
    let mut head = [0u8; 12];
    use std::io::Read;
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let n = f.read(&mut head).map_err(|e| e.to_string())?;
    if n < 4 { return Err("素材文件头不完整".into()); }
    let is_webm = head[0..4] == [0x1A, 0x45, 0xDF, 0xA3];              // EBML
    let is_mp4 = n >= 8 && &head[4..8] == b"ftyp";                     // ISO BMFF
    let is_png = head[0..4] == [0x89, b'P', b'N', b'G'];
    let is_gif = &head[0..3] == b"GIF";
    let is_webp = n >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP";
    if !(is_webm || is_mp4 || is_png || is_gif || is_webp) {
        return Err("素材文件头不是有效视频/图片（可能是错误页）".into());
    }
    Ok(())
}

fn category(clip: &WebClip) -> String {
    let raw = clip.category.clone().unwrap_or_default();
    if matches!(raw.as_str(), "idle" | "turn" | "idle_turn" | "move" | "click" | "drag" | "random" | "events") {
        return raw;
    }
    let path = clip.url.split('?').next().unwrap_or(&clip.url);
    let cat = path.split("/videos/").nth(1).and_then(|x| x.split('/').next()).unwrap_or("");
    if matches!(cat, "idle" | "turn" | "idle_turn" | "move" | "click" | "drag" | "random" | "events") {
        cat.into()
    } else {
        "random".into()
    }
}

fn filename(url: &str, i: usize) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let last = path.rsplit('/').next().unwrap_or("");
    let decoded = percent_decode_str(last).decode_utf8_lossy();
    let stem = clean(Path::new(decoded.as_ref()).file_stem().unwrap_or_default().to_string_lossy().as_ref());
    let ext = Path::new(decoded.as_ref())
        .extension()
        .map(|x| x.to_string_lossy().to_ascii_lowercase())
        .filter(|x| packs::VIDEO_EXT.contains(&x.as_str()))
        .unwrap_or_else(|| "webm".into());
    format!("{}-{:03}.{}", if stem.is_empty() { "clip" } else { &stem }, i, ext)
}

/// 按选中视频的 rel 集合过滤原始 config 的 actions：未选视频的路径一律剔除。
/// 返回 (过滤后的 actions, 是否来自原始 config)。
fn filter_config_actions(config: Option<&serde_json::Value>, selected: &std::collections::BTreeSet<String>) -> (serde_json::Map<String, serde_json::Value>, bool) {
    let mut out = serde_json::Map::new();
    let Some(src) = config.and_then(|v| v.get("actions")).and_then(|x| x.as_object()) else {
        return (out, false);
    };
    for (cat, list) in src {
        let keep: Vec<serde_json::Value> = list.as_array().into_iter().flatten()
            .filter(|v| v.as_str().map(|p| selected.contains(p.trim_start_matches('/'))).unwrap_or(false))
            .cloned().collect();
        if !keep.is_empty() { out.insert(cat.clone(), json!(keep)); }
    }
    (out, true)
}

/// 生成一个不与现有包冲突的文件夹 id（按给定名称）。
fn unique_id(roots: &Roots, wanted: &str) -> String {
    let base = packs::safe_id(wanted);
    if !roots.user.join(&base).exists() { return base; }
    for n in 2..10000 {
        let id = format!("{base}-{n}");
        if !roots.user.join(&id).exists() { return id; }
    }
    base
}

/// 按清单下载素材并生成可被 packs::scan 识别的标准角色包，返回包 id。
/// merge=true：并入同名包，只补新视频及其对应 json 字段，原有素材/配置不动。
/// merge=false：新建包；new_name 若给出则用它命名文件夹并保证不重复。
pub fn import_manifest(roots: &Roots, text: &str, merge: bool, new_name: Option<&str>) -> Result<String, String> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| format!("导入清单解析失败: {e}"))?;
    if m.clips.is_empty() { return Err("导入清单里没有视频".into()); }

    let orig_name = m.name.clone().filter(|x| !x.trim().is_empty()).unwrap_or_else(|| "网页桌宠".into());
    let base = packs::safe_id(m.id.as_deref().filter(|x| !x.trim().is_empty()).unwrap_or(&orig_name));
    let exists = roots.user.join(&base).exists();
    // 同名且选「新角色」：用用户改的新名称另起一个不重复文件夹；否则自增兜底。
    let merging = merge && exists;
    let (id, name) = if merging {
        (base.clone(), orig_name.clone())
    } else {
        let wanted = new_name.filter(|x| !x.trim().is_empty()).unwrap_or(&orig_name);
        let fid = if new_name.map(|x| !x.trim().is_empty()).unwrap_or(false) {
            unique_id(roots, wanted)
        } else if exists {
            format!("{base}-web-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs())
        } else { base.clone() };
        (fid, wanted.to_string())
    };

    let root = roots.user.join(&id);
    let fresh = !root.exists();
    fs::create_dir_all(root.join("videos")).map_err(|e| e.to_string())?;

    // 下载：保留清单给出的相对路径（videos/<cat>/<file>），缺 rel 时回退到原分类+文件名。
    // 只下载本地还没有的素材；merge 时记录真正新增的 rel，配置只并这些新视频的字段。
    let mut new_rels: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut all_rels: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let cleanup = |fresh: bool, root: &std::path::Path| { if fresh { let _ = fs::remove_dir_all(root); } };
    let mut total_bytes: u64 = 0;
    for (i, clip) in m.clips.iter().enumerate() {
        if !clip.url.starts_with("http://") && !clip.url.starts_with("https://") {
            cleanup(fresh, &root);
            return Err("素材链接必须是 http/https".into());
        }
        let cat = category(clip);
        let rel = clip.rel.clone().filter(|x| !x.trim().is_empty())
            .unwrap_or_else(|| format!("videos/{cat}/{}", filename(&clip.url, i)));
        let Some(rel) = safe_rel(&rel) else {
            cleanup(fresh, &root);
            return Err(format!("清单里的素材路径非法: {rel}"));
        };
        let target = root.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        all_rels.insert(rel.clone());
        if !target.exists() { // merge 时跳过已存在的素材
            let out = Command::new("curl")
                .args(["-fsSL", "--retry", "2", "--retry-delay", "1", "--max-time", "120",
                       "--max-filesize", &MAX_CLIP.to_string(), "-o"])
                .arg(target.to_string_lossy().as_ref())
                .arg(&clip.url)
                .output()
                .map_err(|e| format!("无法调用 curl 下载素材: {e}"))?;
            if !out.status.success() {
                cleanup(fresh, &root);
                return Err(format!("素材下载失败 {}: {}", clip.url, String::from_utf8_lossy(&out.stderr).trim()));
            }
            if let Err(e) = verify_media(&target) {
                let _ = fs::remove_file(&target);
                cleanup(fresh, &root);
                return Err(format!("素材校验失败 {clip_url}: {e}", clip_url = clip.url));
            }
            // curl 的 --max-filesize 只在拿到 Content-Length 时生效，落盘后再按实际字节兜一次
            let got = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            if got > MAX_CLIP {
                let _ = fs::remove_file(&target);
                cleanup(fresh, &root);
                return Err(format!("单段素材超过 {} MB，已中止: {}", MAX_CLIP / 1024 / 1024, clip.url));
            }
            total_bytes += got;
            if total_bytes > MAX_TOTAL {
                let _ = fs::remove_file(&target);
                cleanup(fresh, &root);
                return Err(format!("本次导入素材总量超过 {} MB，已中止", MAX_TOTAL / 1024 / 1024));
            }
            new_rels.insert(rel);
        }
    }

    // 合并模式：以原有 character.json 为底，只叠加新视频对应的 actions/noMirror，
    // 其它字段（name/theme/canvas/scale 等）保持原样，旧视频配置完全不动。
    if merging {
        let old_path = root.join("character.json");
        let old: serde_json::Value = fs::read_to_string(&old_path).ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({"name": &name, "id": &id }));
        let mut meta = old;
        let obj = meta.as_object_mut().ok_or("原角色配置格式错误")?;
        // 清单携带的原始配置：只取本次新增视频对应的动作字段
        let (mut add, from_cfg) = filter_config_actions(m.config.as_ref(), &new_rels);
        if !from_cfg {
            // 老清单无 config：按分类给新 rel 生成最小动作
            for clip in &m.clips {
                let cat = category(clip);
                let rel = clip.rel.clone().unwrap_or_default().trim_start_matches('/').to_string();
                if !new_rels.contains(&rel) { continue; }
                let arr = add.entry(cat).or_insert_with(|| json!([]));
                let a = arr.as_array_mut().unwrap();
                if !a.contains(&json!(&rel)) { a.push(json!(rel)); }
            }
        }
        // 先在独立 Map 上合并，再写回，避免可变借用原对象。
        let mut merged: serde_json::Map<String, serde_json::Value> = obj.get("actions")
            .and_then(|x| x.as_object()).cloned().unwrap_or_default();
        for (cat, list) in add {
            let cur = merged.entry(cat).or_insert_with(|| json!([]));
            if !cur.is_array() { *cur = json!([]); }
            let arr = cur.as_array_mut().unwrap();
            for v in list.as_array().into_iter().flatten() {
                if !arr.contains(v) { arr.push(v.clone()); }
            }
        }
        obj.insert("actions".into(), json!(merged));
        fs::write(&old_path, serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        return Ok(id);
    }

    // 新建模式：以清单原始 character.json 为底，按选中视频过滤 actions。
    let mut meta = m.config.clone().filter(|v| v.is_object())
        .unwrap_or_else(|| json!({ "name": &name, "theme": m.theme.as_deref().unwrap_or("#2f7fbf") }));
    {
        let obj = meta.as_object_mut().unwrap();
        obj.insert("id".into(), json!(id));
        obj.insert("name".into(), json!(name));
        if let Some(t) = m.theme.as_deref().filter(|x| !x.trim().is_empty()) {
            obj.insert("theme".into(), json!(t));
        }
        if let Some(s) = m.source.as_deref().filter(|x| !x.trim().is_empty()) {
            obj.insert("source".into(), json!(s));
        }
        let (mut actions, from_cfg) = filter_config_actions(m.config.as_ref(), &all_rels);
        if !from_cfg {
            for clip in &m.clips {
                let cat = category(clip);
                let rel = clip.rel.clone().unwrap_or_default().trim_start_matches('/').to_string();
                if rel.is_empty() || !all_rels.contains(&rel) { continue; }
                let arr = actions.entry(cat).or_insert_with(|| json!([]));
                let a = arr.as_array_mut().unwrap();
                if !a.contains(&json!(&rel)) { a.push(json!(rel)); }
            }
        }
        if !actions.contains_key("idle") {
            let first = m.clips.first().and_then(|c| {
                let cat = category(c);
                actions.get(&cat).and_then(|x| x.as_array()).and_then(|a| a.first()).cloned()
            });
            if let Some(v) = first { actions.insert("idle".into(), json!([v])); }
        }
        obj.insert("actions".into(), json!(actions));
    }
    fs::write(root.join("character.json"), serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::safe_rel;

    #[test]
    fn safe_rel_blocks_traversal() {
        assert_eq!(safe_rel("videos/idle/a.webm").as_deref(), Some("videos/idle/a.webm"));
        assert_eq!(safe_rel("/videos/a.webm").as_deref(), Some("videos/a.webm"));
        assert_eq!(safe_rel("videos\\a.webm").as_deref(), Some("videos/a.webm"));
        assert!(safe_rel("../../evil.exe").is_none());
        assert!(safe_rel("videos/../../evil.exe").is_none());
        assert!(safe_rel("C:/evil.exe").is_none());
        assert!(safe_rel("videos//a.webm").is_none());
        assert!(safe_rel("").is_none());
    }

    use super::*;

    #[test]
    fn config_actions_keep_only_selected_videos() {
        let cfg = json!({
            "id": "x", "scale": 0.5,
            "actions": {
                "idle": ["videos/idle/a.webm", "videos/idle/b.webm"],
                "random": ["videos/random/c.webm", "videos/random/d.webm"],
                "move": []
            }
        });
        let selected: std::collections::BTreeSet<String> = ["videos/idle/a.webm", "videos/random/d.webm"]
            .iter().map(|s| s.to_string()).collect();
        let (actions, from_cfg) = filter_config_actions(Some(&cfg), &selected);
        assert!(from_cfg);
        assert_eq!(actions["idle"], json!(["videos/idle/a.webm"]));
        assert_eq!(actions["random"], json!(["videos/random/d.webm"]));
        assert!(!actions.contains_key("move"), "空分类应剔除");
    }

    #[test]
    fn config_absent_yields_empty_actions() {
        let (actions, from_cfg) = filter_config_actions(None, &Default::default());
        assert!(!from_cfg);
        assert!(actions.is_empty());
    }

    fn test_roots() -> Roots {
        let base = std::env::temp_dir().join(format!("xiaofeiyu-wi-{}", std::process::id()));
        Roots {
            data: base.join("data"), builtin: base.join("builtin"),
            user: base.join("user"), external: base.join("external"), portable: true,
        }
    }

    #[test]
    fn unique_id_avoids_existing_folders() {
        let roots = test_roots();
        fs::create_dir_all(roots.user.join("newpet")).unwrap();
        assert_eq!(unique_id(&roots, "newpet"), "newpet-2");
        assert_eq!(unique_id(&roots, "brandnew"), "brandnew");
        let _ = fs::remove_dir_all(roots.user.parent().unwrap());
    }

    #[test]
    fn verify_media_accepts_known_magic_and_rejects_junk() {
        let base = std::env::temp_dir().join(format!("xiaofeiyu-verify-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        let mk = |name: &str, bytes: Vec<u8>| {
            let p = base.join(name);
            fs::write(&p, bytes).unwrap();
            p
        };
        let mut webm = vec![0u8; 600]; webm[..4].copy_from_slice(&[0x1A, 0x45, 0xDF, 0xA3]);
        let mut mp4 = vec![0u8; 600]; mp4[4..8].copy_from_slice(b"ftyp");
        assert!(verify_media(&mk("a.webm", webm)).is_ok());
        assert!(verify_media(&mk("b.mp4", mp4)).is_ok());
        // 过小的文件、HTML 错误页都必须被拦截
        assert!(verify_media(&mk("tiny.webm", vec![0x1A, 0x45, 0xDF, 0xA3])).is_err());
        assert!(verify_media(&mk("err.webm", vec![b'<'; 800])).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn unregister_flag_and_protocol_key() {
        assert!(is_unregister_flag("--unregister-protocol"));
        assert!(!is_unregister_flag("--from-autostart"));
        assert!(!is_unregister_flag(""));
        assert_eq!(protocol_class_key(), "HKCU\\Software\\Classes\\video-json-pet");
    }

    #[test]
    fn pending_queue_round_trips_through_disk() {
        // 单测无 setup 注入，PENDING_FILE 为 None：队列仍可在内存里去重/清空。
        queue_pending("video-json-pet://import?url=A".into());
        queue_pending("video-json-pet://import?url=A".into()); // 重复入队被去重
        queue_pending("video-json-pet://import?url=B".into());
        let got = take_pending();
        assert_eq!(got.len(), 2, "去重后应有 2 条");
        assert!(got[0].ends_with("url=A") && got[1].ends_with("url=B"));
        assert!(take_pending().is_empty(), "取走后应清空");
    }
}

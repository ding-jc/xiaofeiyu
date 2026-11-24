// 统一素材格式（xiaofeiyu-asset-v1）的底层文件 I/O：目录/ZIP ↔ 内存字节树。
// 编解码/转换全在 Rust 进程内完成，字节不经过 base64 与 IPC，避免大素材卡顿。
// 大文件读写用 rayon 并行，进度按 (已完成, 总数) 回调，由命令层节流 emit。
use rayon::prelude::*;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

pub use crate::asset_kit::AssetTree as Tree;
/// 进度回调：(已完成数, 总数)。命令层据此节流后 emit 事件。
pub type Progress = dyn Fn(usize, usize) + Send + Sync;
#[cfg(test)]
fn noop(_: usize, _: usize) {}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if p.is_dir() { collect_files(&p, out)?; } else { out.push(p); }
    }
    Ok(())
}

/// ZIP 常带一层顶层目录，去掉它让清单回到树根。
fn strip_common_root(tree: &mut Tree) {
    let manifests = ["config.json", "config.jsonc", "character.json", "manifest.json"];
    if tree.keys().any(|p| !p.contains('/') && manifests.contains(&p.as_str())) { return; }
    let roots: HashSet<&str> = tree.keys()
        .filter_map(|p| p.split('/').next().filter(|s| !s.is_empty())).collect();
    if roots.len() != 1 { return; }
    let prefix = format!("{}/", roots.iter().next().unwrap());
    let stripped: Tree = tree.iter()
        .map(|(k, v)| (k.strip_prefix(&prefix).unwrap_or(k).to_string(), v.clone())).collect();
    *tree = stripped;
}

/// 目录或 ZIP → 内存字节树（并行读文件）。
pub fn read_tree(path: &Path, progress: &Progress) -> Result<Tree, String> {
    let raw: Vec<(String, Vec<u8>)> = if path.is_dir() {
        let mut files = Vec::new();
        collect_files(path, &mut files)?;
        let total = files.len();
        let done = AtomicUsize::new(0);
        files.par_iter().map(|p| {
            let buf = fs::read(p).map_err(|e| e.to_string())?;
            let rel = p.strip_prefix(path).unwrap_or(p).to_string_lossy().replace('\\', "/");
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(n, total);
            Ok((rel, buf))
        }).collect::<Result<Vec<_>, String>>()?
    } else if path.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("zip")).unwrap_or(false) {
        let f = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut ar = zip::ZipArchive::new(f).map_err(|e| format!("ZIP 打开失败: {e}"))?;
        let total = ar.len();
        let mut items = Vec::new();
        for i in 0..total {
            let mut e = ar.by_index(i).map_err(|e| e.to_string())?;
            if e.is_dir() { continue; }
            let name = e.name().replace('\\', "/");
            let name = name.split('/').skip_while(|s| s.is_empty()).collect::<Vec<_>>().join("/");
            let mut buf = Vec::new();
            e.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            items.push((name, buf));
            progress(i + 1, total);
        }
        items
    } else {
        return Err("仅支持目录或 .zip".into());
    };

    let mut out: Tree = raw.into_iter().collect();
    if out.is_empty() { return Err("素材包里没有文件".into()); }
    strip_common_root(&mut out);
    Ok(out)
}

/// 内存字节树 → 目录。clear=true 先清空（导入替换整包）；false 合并写入（dsh pet/ 下多宠共存）。
/// 串行校验路径防穿越，再并行写盘。
pub fn write_tree(dir: &Path, tree: &Tree, clear: bool, progress: &Progress) -> Result<usize, String> {
    if clear && dir.exists() { fs::remove_dir_all(dir).map_err(|e| e.to_string())?; }
    let mut jobs: Vec<(PathBuf, &Vec<u8>)> = Vec::with_capacity(tree.len());
    for (rel, bytes) in tree {
        let normalized = rel.replace('\\', "/");
        let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
        if parts.iter().any(|s| *s == "..") { return Err(format!("非法路径: {rel}")); }
        jobs.push((parts.iter().fold(dir.to_path_buf(), |p, s| p.join(s)), bytes));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let total = jobs.len();
    let done = AtomicUsize::new(0);
    jobs.par_iter().try_for_each(|(target, bytes)| -> Result<(), String> {
        if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        fs::write(target, bytes).map_err(|e| e.to_string())?;
        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
        progress(n, total);
        Ok(())
    })?;
    Ok(total)
}

/// 内存字节树 → ZIP（store 模式，路径统一 /）。prefix 为可选顶层目录（不克隆字节）。
pub fn zip_tree(target: &Path, tree: &Tree, prefix: Option<&str>, progress: &Progress) -> Result<(), String> {
    let total = tree.len();
    let done = AtomicUsize::new(0);
    let mut entries: Vec<(String, &Vec<u8>)> = Vec::with_capacity(tree.len());
    for (k, bytes) in tree {
        let name = k.replace('\\', "/");
        if name.split('/').any(|s| s == "..") { continue; }
        let name = match prefix {
            Some(p) if !p.is_empty() => format!("{}/{}", p.trim_end_matches('/'), name),
            _ => name,
        };
        entries.push((name, bytes));
        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
        progress(n, total);
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let f = fs::File::create(target).map_err(|e| e.to_string())?;
    let mut zw = zip::ZipWriter::new(f);
    let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in entries {
        zw.start_file(name, opts).map_err(|e| e.to_string())?;
        zw.write_all(bytes).map_err(|e| e.to_string())?;
    }
    zw.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// 本地 dsh 用户目录：$DSH_HOME/dsh-pet/，默认 ~/.dsh/dsh-pet/
pub fn dsh_user_root() -> PathBuf {
    if let Ok(h) = std::env::var("DSH_HOME") { if !h.is_empty() { return PathBuf::from(h).join("dsh-pet"); } }
    PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".dsh/dsh-pet")
}

/// 写入前预览路径
pub fn preview_dsh_plugin(root: &str) -> Value {
    let name = crate::asset_kit::dsh_root(root);
    let base = dsh_user_root().join("pet");
    json!({
        "dshHome": dsh_user_root().to_string_lossy(),
        "petDir": base.to_string_lossy(),
        "root": name,
        "dir": base.join(&name).to_string_lossy(),
        "config": base.join(format!("{name}-config.json")).to_string_lossy(),
        "animationDir": base.join(format!("{name}-animation")).to_string_lossy(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_roundtrip_dir_and_zip() {
        let base = std::env::temp_dir().join(format!("xiaofeiyu-tree-{}", std::process::id()));
        let src = base.join("src");
        fs::create_dir_all(src.join("videos/idle")).unwrap();
        fs::write(src.join("config.json"), b"{}").unwrap();
        fs::write(src.join("videos/idle/a.webm"), b"fake").unwrap();

        let tree = read_tree(&src, &noop).unwrap();
        assert_eq!(tree.len(), 2);
        assert_eq!(tree.get("videos/idle/a.webm").unwrap(), &b"fake".to_vec());

        let dst = base.join("dst");
        assert_eq!(write_tree(&dst, &tree, true, &noop).unwrap(), 2);
        assert_eq!(fs::read(dst.join("videos/idle/a.webm")).unwrap(), b"fake");

        let zip = base.join("out.zip");
        zip_tree(&zip, &tree, None, &noop).unwrap();
        let from_zip = read_tree(&zip, &noop).unwrap();
        assert_eq!(from_zip, tree);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn write_tree_rejects_traversal() {
        let base = std::env::temp_dir().join(format!("xiaofeiyu-evil-{}", std::process::id()));
        let mut tree = Tree::new();
        tree.insert("../../evil.txt".into(), b"x".to_vec());
        assert!(write_tree(&base, &tree, true, &noop).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn progress_reports_each_file() {
        let base = std::env::temp_dir().join(format!("xiaofeiyu-prog-{}", std::process::id()));
        let src = base.join("src");
        fs::create_dir_all(&src).unwrap();
        for i in 0..3 { fs::write(src.join(format!("f{i}.txt")), b"x").unwrap(); }
        let seen = std::sync::Arc::new(AtomicUsize::new(0));
        let seen2 = seen.clone();
        let t = read_tree(&src, &move |d, total| {
            assert_eq!(total, 3);
            seen2.store(d, Ordering::Relaxed);
        }).unwrap();
        assert_eq!(t.len(), 3);
        assert_eq!(seen.load(Ordering::Relaxed), 3);
        let _ = fs::remove_dir_all(&base);
    }
}

// 运行期目录：安装版写 app_data，绿色版写 exe 同级 data（由 portable.txt 判定）。
use std::{fs, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

// 历史 identifier 链：新→旧依次兜底，任一有数据就搬到当前 app_data_dir。
const LEGACY_IDENTIFIERS: &[&str] = &[
    "site.pixup.pet.wallpaper", // 改名为 site.pixup.pet 前的直接上代
    "cn.dsh.pet.wallpaper",     // 更早的 dsh 时代
];

/// 整体递归复制目录，单个文件失败（占用/权限）跳过，不阻断其余迁移。
fn copy_dir(src: &Path, dst: &Path) {
    if fs::create_dir_all(dst).is_err() { return; }
    let Ok(entries) = fs::read_dir(src) else { return; };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        match entry.file_type() {
            Ok(t) if t.is_dir() => copy_dir(&from, &to),
            Ok(t) if t.is_file() => { let _ = fs::copy(&from, &to); },
            _ => {}
        }
    }
}

/// identifier 升级后 app_data_dir 换路径，WebView 的 localStorage（EBWebView profile）随之搬家。
/// 首次启动若新目录尚无 profile，按新→旧顺序找历史目录整体复制过来，
/// 让坐标/偏好/WebView storage 无感迁移；每搬完一个就重查，填满即停。
fn migrate_legacy_appdata(app: &AppHandle) {
    let Ok(new_dir) = app.path().app_data_dir() else { return; };
    let filled = || new_dir.join("EBWebView").is_dir() || new_dir.join("config.json").exists();
    if filled() { return; }
    let Ok(root) = std::env::var("APPDATA") else { return; };
    for id in LEGACY_IDENTIFIERS {
        if filled() { return; }
        let old_dir = PathBuf::from(&root).join(id);
        if old_dir == new_dir || !old_dir.is_dir() { continue; }
        copy_dir(&old_dir, &new_dir);
    }
}

#[derive(Clone, Debug)]
pub struct Roots {
    pub data: PathBuf,
    pub builtin: PathBuf,
    pub user: PathBuf,
    pub external: PathBuf,
    pub portable: bool,
}

pub fn detect(app: &AppHandle) -> Roots {
    migrate_legacy_appdata(app);
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let portable = exe_dir.join("portable.txt").exists();
    let data = if portable {
        exe_dir.join("data")
    } else {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| exe_dir.join("data"))
    };

    let bundled = app
        .path()
        .resource_dir()
        .map(|p| p.join("characters"))
        .unwrap_or_default();
    let alt = app
        .path()
        .resource_dir()
        .map(|p| p.join("resources/characters"))
        .unwrap_or_default();
    let builtin = if bundled.is_dir() {
        bundled
    } else if alt.is_dir() {
        alt
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/characters")
    };

    let user = data.join("characters");
    let external = data.join("external");
    for d in [&data, &user, &external] {
        let _ = fs::create_dir_all(d);
    }
    Roots { data, builtin, user, external, portable }
}

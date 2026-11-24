// Tauri IPC：全局配置、每宠档案、本地数据、浮层、托盘、系统能力。
use crate::{config, packs, positions, store, AppState};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State};

// 窗口展示状态：浮层「前端已就绪」后才允许显示（避免透明窗以白屏闪现）；
// 托盘「隐藏桌宠」与前台全屏应用是全局暂停位，两者优先级高于显示开关。
static OVERLAY_READY: AtomicBool = AtomicBool::new(false);
static ALL_HIDDEN: AtomicBool = AtomicBool::new(false);
pub static FULLSCREEN: AtomicBool = AtomicBool::new(false);
/// 主窗每个新实例只在首次显示时居中；之后用户拖过的位置不再动。
static SETTINGS_CENTERED: AtomicBool = AtomicBool::new(false);

// 点击音效的全局节流时间戳（毫秒）。命中窗在原生层裁决本次点击是否放行，
// 节流状态收口到唯一的后端进程。
static LAST_CLICK_SOUND_MS: AtomicU64 = AtomicU64::new(0);
const CLICK_SOUND_THROTTLE_MS: u64 = 100;

/// 节流判定：距上次放行 >= 间隔则占用新时间戳并返回 true，否则 false。
fn claim_click_slot(last: u64, now: u64) -> Option<u64> {
    if now.saturating_sub(last) >= CLICK_SOUND_THROTTLE_MS { Some(now) } else { None }
}

/// 点击音效裁决：CAS 抢占 100ms slot，全局只放行一次。
/// 浮层命中窗在 WM_LBUTTONUP 本地直调。
pub fn claim_click_sound() -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut last = LAST_CLICK_SOUND_MS.load(Ordering::Relaxed);
    loop {
        match claim_click_slot(last, now) {
            None => return false,
            Some(next) => match LAST_CLICK_SOUND_MS.compare_exchange_weak(
                last, next, Ordering::AcqRel, Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => last = actual,
            },
        }
    }
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> config::Config {
    state.cfg.lock().map(|c| c.clone()).unwrap_or_default()
}

/// 纯逻辑：用权威 cfg 的坐标覆盖 incoming（仅同 id），新宠物保留 incoming 初始值。
fn merge_positions(auth: &config::Config, incoming: &mut config::Config) {
    for p in &mut incoming.pets {
        if let Some(old) = auth.pets.iter().find(|o| o.id == p.id) {
            p.x = old.x; p.y = old.y; p.ox = old.ox; p.oy = old.oy;
        }
    }
}

#[tauri::command]
pub fn set_config(app: AppHandle, state: State<'_, AppState>, value: Value) -> Result<(), String> {
    let mut cfg: config::Config = serde_json::from_value(value).map_err(|e| e.to_string())?;
    // 用内存权威坐标覆盖整份写回里可能陈旧的坐标（前端三份 cfg 副本互不知晓对方位置）。
    // config.json 本身已剥离坐标，落盘不受影响；内存与广播则保持最新坐标。
    if let Ok(auth) = state.cfg.lock() { merge_positions(&auth, &mut cfg); }
    config::save(&state.roots.data, &cfg)?;
    apply(&app, &cfg);
    if let Ok(mut g) = state.cfg.lock() { *g = cfg.clone(); }
    // 每宠档案同步落盘为 config-slot-N.json（与原项目数据目录布局一致）
    for p in &cfg.pets {
        if let Some(profile) = &p.profile {
            let _ = config::write_json(&store::slot_file(&state.roots.data, &p.id), profile);
        }
    }
    app.emit("config://changed", &cfg).map_err(|e| e.to_string())
}

// 坐标防抖：前端拖动松手只更新内存，延迟一段时间批量落盘；退出/关窗再强制 flush。
// 用单调递增的 seq 丢弃过期任务，保证只有最后一次变更真正写盘。
static POS_SEQ: AtomicU64 = AtomicU64::new(0);
const POS_DEBOUNCE: Duration = Duration::from_millis(1500);

/// 把内存里的权威坐标写入 positions.json。唯一的坐标落盘出口。
pub fn flush_positions(app: &AppHandle) {
    if let Some(st) = app.try_state::<AppState>() {
        let cfg = match st.cfg.lock() { Ok(g) => g.clone(), Err(e) => e.into_inner().clone() };
        let _ = positions::save(&st.roots.data, &positions::from_cfg(&cfg));
    }
}

/// 调度一次防抖落盘：新变更递增 seq，旧任务醒来发现 seq 已变就放弃。
fn schedule_pos_flush(app: &AppHandle) {
    let seq = POS_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let a = app.clone();
    thread::spawn(move || {
        thread::sleep(POS_DEBOUNCE);
        if POS_SEQ.load(Ordering::SeqCst) == seq { flush_positions(&a); }
    });
}

/// 纯逻辑：把 (id, layer, x, y) 更新写入 cfg，只改对应层的坐标，另一层原样保留。
fn apply_positions(cfg: &mut config::Config, updates: &[(String, String, f64, f64)]) {
    for (id, layer, x, y) in updates {
        if let Some(p) = cfg.pets.iter_mut().find(|p| &p.id == id) {
            if layer == "overlay" { p.ox = Some(*x); p.oy = Some(*y); }
            else { p.x = *x; p.y = *y; }
        }
    }
}

/// 上报桌宠坐标：只更新内存 cfg 并调度防抖落盘，不立即写盘、不广播。
/// 坐标是内存权威 + positions.json 镜像，磁盘写入集中在 flush_positions 一处。
#[tauri::command]
pub fn save_pet_positions(
    app: AppHandle,
    state: State<'_, AppState>,
    positions: Value,
) -> Result<(), String> {
    let list = positions.as_array().ok_or("positions 必须是数组")?;
    let updates: Vec<(String, String, f64, f64)> = list.iter().map(|item| {
        (
            item.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            item.get("layer").and_then(Value::as_str).unwrap_or("").to_string(),
            item.get("x").and_then(Value::as_f64).unwrap_or(-1.0),
            item.get("y").and_then(Value::as_f64).unwrap_or(-1.0),
        )
    }).collect();
    if let Ok(mut g) = state.cfg.lock() { apply_positions(&mut g, &updates); }
    schedule_pos_flush(&app);
    Ok(())
}

#[tauri::command]
pub fn get_data(state: State<'_, AppState>, name: String) -> Value {
    let custom = config::read_json(&store::data_file(&state.roots.data, &name));
    if !custom.is_null() { return custom; }
    store::builtin(&name)
}

#[tauri::command]
pub fn set_data(app: AppHandle, state: State<'_, AppState>, name: String, value: Value) -> Result<(), String> {
    config::write_json(&store::data_file(&state.roots.data, &name), &value)?;
    app.emit(&format!("data://{}", name), &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_slots(state: State<'_, AppState>) -> Value { store::list_slots(&state.roots.data) }

#[tauri::command]
pub fn save_slot(app: AppHandle, state: State<'_, AppState>, id: String, profile: Value) -> Result<(), String> {
    config::write_json(&store::slot_file(&state.roots.data, &id), &profile)?;
    app.emit("slot://changed", json!({ "id": id, "profile": profile })).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_slot(state: State<'_, AppState>, id: String) -> Result<(), String> {
    store::remove_slot(&state.roots.data, &id);
    Ok(())
}

#[tauri::command]
pub fn set_metrics(state: State<'_, AppState>, on: bool) {
    if let Ok(m) = state.metrics.read() { m.set(on); }
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
pub fn run_program(path: String, args: Option<Vec<String>>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_file() { return Err(format!("找不到程序：{}", path)); }
    let mut cmd = std::process::Command::new(p);
    if let Some(a) = args { cmd.args(a); }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_packs(state: State<'_, AppState>) -> Vec<packs::CharacterPack> {
    // 后台扫描未完成时阻塞等待（命令在 async 线程池，不卡 UI）：
    // 否则首帧拿到空包列表 → 前端 buildPets 误报「没有可用桌宠素材」。
    if let Some((lock, cv)) = crate::PACKS_READY.get() {
        if let Ok(done) = lock.lock() {
            if !*done {
                let _ = cv.wait_timeout(done, std::time::Duration::from_secs(10));
            }
        }
    }
    state.packs.read().map(|p| p.clone()).unwrap_or_default()
}

fn refresh(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let ext = state.external.read().map_err(|_| "external lock".to_string())?;
    let list = packs::scan(&state.roots, &ext);
    drop(ext);
    if let Ok(mut g) = state.packs.write() { *g = list.clone(); }
    app.emit("packs://changed", list).map_err(|e| e.to_string())
}

/// 转换长任务的进度发射器：按整数百分比节流，避免每个文件都跨 IPC 刷 UI。
/// 返回 (done, total) 回调；每次调用 emit `asset://progress`。
fn progress_emitter(app: &AppHandle, stage: &'static str) -> impl Fn(usize, usize) + Send + Sync {
    let app = app.clone();
    let last = AtomicU32::new(u32::MAX);
    move |done: usize, total: usize| {
        let pct = if total == 0 { 100 } else { (done * 100 / total).min(100) } as u32;
        if last.swap(pct, Ordering::Relaxed) != pct || pct == 100 {
            let _ = app.emit("asset://progress", json!({
                "stage": stage, "done": done, "total": total, "percent": pct,
            }));
        }
    }
}

/// 发一个纯阶段事件（转换阶段无文件进度，仅推进 UI 阶段条）。
fn emit_stage(app: &AppHandle, stage: &'static str) {
    let _ = app.emit("asset://progress", json!({ "stage": stage, "done": 1, "total": 1, "percent": 100 }));
}

/// 统一格式导入：Rust 内一步完成「读源 → 探测转换 → 落地用户包」，字节不跨 IPC。
/// 重活在 spawn_blocking 线程执行，UI 不卡；进度经 asset://progress 事件回报。
#[tauri::command]
pub async fn convert_import(app: AppHandle, state: State<'_, AppState>, path: String,
    name: Option<String>) -> Result<Value, String> {
    if !Path::new(&path).exists() { return Err("路径不存在".into()); }
    let user_root = state.roots.user.clone();
    let app2 = app.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        use crate::asset_kit::{detect_source, import_to_native};
        let tree = crate::asset_convert::read_tree(Path::new(&path), &progress_emitter(&app2, "read"))?;
        let src = detect_source(&tree);
        emit_stage(&app2, "convert");
        let r = import_to_native(tree, name.as_deref())?;
        let dst = user_root.join(&r.id);
        crate::asset_convert::write_tree(&dst, &r.tree, true, &progress_emitter(&app2, "write"))?;
        Ok::<_, String>(json!({
            "id": r.id, "name": r.name, "format": r.format, "label": src.label,
        }))
    }).await.map_err(|e| e.to_string())??;

    refresh(&app, &state)?;
    Ok(out)
}

/// 导出指定角色为 dsh-pet 格式 ZIP：Rust 内「读包 → 转换 → 打包」，ZIP 顶层带 <root>/ 目录。
#[tauri::command]
pub async fn export_dsh_zip(app: AppHandle, state: State<'_, AppState>, id: String,
    target: String, root: Option<String>) -> Result<Value, String> {
    let pack_path = {
        let packs = state.packs.read().map_err(|_| "packs lock".to_string())?;
        let pack = packs.iter().find(|p| p.id == id).ok_or("角色不存在")?;
        (PathBuf::from(&pack.path), pack.name.clone())
    };
    let app2 = app.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        use crate::asset_kit::{export_to_dsh, read_native_pack};
        let tree = crate::asset_convert::read_tree(&pack_path.0, &progress_emitter(&app2, "read"))?;
        let pack = read_native_pack(tree)?;
        emit_stage(&app2, "convert");
        let dsh = export_to_dsh(&pack, root.as_deref().or(Some(&pack_path.1)));
        crate::asset_convert::zip_tree(Path::new(&target), &dsh.tree, Some(&dsh.root), &progress_emitter(&app2, "zip"))?;
        Ok::<_, String>(json!({ "path": target, "root": dsh.root }))
    }).await.map_err(|e| e.to_string())??;
    Ok(out)
}

/// 一键写入本地 dsh 插件：写入前由前端展示路径确认；合并写入 pet/（clear=false，不清别的桌宠）。
#[tauri::command]
pub async fn write_dsh_pet(app: AppHandle, state: State<'_, AppState>, id: String,
    root: Option<String>) -> Result<Value, String> {
    let (pack_path, pack_name) = {
        let packs = state.packs.read().map_err(|_| "packs lock".to_string())?;
        let pack = packs.iter().find(|p| p.id == id).ok_or("角色不存在")?;
        (PathBuf::from(&pack.path), pack.name.clone())
    };
    let app2 = app.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        use crate::asset_kit::{export_to_dsh, plugin_files, read_native_pack};
        let tree = crate::asset_convert::read_tree(&pack_path, &progress_emitter(&app2, "read"))?;
        let pack = read_native_pack(tree)?;
        emit_stage(&app2, "convert");
        let dsh = export_to_dsh(&pack, root.as_deref().or(Some(&pack_name)));
        let pv = crate::asset_convert::preview_dsh_plugin(&dsh.root);
        let pet_dir = PathBuf::from(pv["petDir"].as_str().unwrap_or(""));
        // 只写 dsh 插件文件，不把源包原始结构带进 pet/（避免残留与多角色互相覆盖）
        let files = plugin_files(&dsh);
        crate::asset_convert::write_tree(&pet_dir, &files, false, &progress_emitter(&app2, "write"))?;
        Ok::<_, String>(json!({ "dir": pet_dir.to_string_lossy(), "root": dsh.root }))
    }).await.map_err(|e| e.to_string())??;
    Ok(out)
}

/// 预览一键写入本地 dsh 的目标路径
#[tauri::command]
pub fn preview_dsh_write(root: Option<String>) -> Result<Value, String> {
    Ok(crate::asset_convert::preview_dsh_plugin(root.as_deref().unwrap_or("pet")))
}

#[tauri::command]
pub fn import_pack(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Value, String> {
    // 网页下载的 .petimport.json：按清单逐段下载到本地，走同一条 packs 刷新链路。
    if Path::new(&path).extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("json")).unwrap_or(false) {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let id = crate::web_import::import_manifest(&state.roots, &text, false, None)?;
        refresh(&app, &state)?;
        return Ok(json!({ "id": id }));
    }
    let mut ext = state.external.write().map_err(|_| "external lock".to_string())?;
    let id = packs::import(&state.roots, &mut ext, &path)?;
    packs::save_external(&state.roots, &ext)?;
    drop(ext);
    refresh(&app, &state)?;
    Ok(json!({ "id": id }))
}

/// 浏览器深链 / 前端手动调用：按网页导入清单下载角色包。
pub fn import_web_url_core(app: &AppHandle, url: &str, merge: bool, new_name: Option<&str>) -> Result<String, String> {
    let state = app.try_state::<AppState>().ok_or("应用状态未就绪")?;
    // 深链 video-json-pet://import?url=... 先解出真实清单地址；前端手动导入也可直接传 http 清单。
    let manifest_url = crate::web_import::manifest_url(url).unwrap_or_else(|| url.to_string());
    let manifest = crate::web_import::fetch_manifest(&manifest_url)?;
    let id = crate::web_import::import_manifest(&state.roots, &manifest, merge, new_name)?;
    refresh(app, &state)?;
    Ok(id)
}

/// 深链唤起后前端第一步：只取出待确认清单 URL（纯内存、瞬间返回），好让弹框先显示 loading。
#[tauri::command]
pub fn take_pending_imports() -> Vec<String> {
    crate::web_import::take_pending()
}

/// 前端第二步：按单个 URL 拉清单概览（curl 在后台线程，不阻塞 UI），不下载素材。
#[tauri::command]
pub fn preview_import(state: State<'_, AppState>, url: String) -> Result<Value, String> {
    crate::web_import::preview_manifest(&state.roots, &url)
}

#[tauri::command]
pub fn import_web_url(app: AppHandle, url: String, merge: Option<bool>, new_name: Option<String>) -> Result<Value, String> {
    let id = import_web_url_core(&app, &url, merge.unwrap_or(false), new_name.as_deref())?;
    notify(app, "导入完成".into(), format!("已导入角色：{id}"));
    Ok(json!({ "id": id }))
}

#[tauri::command]
pub fn remove_pack(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let p = state.packs.read().map_err(|_| "packs lock".to_string())?;
        if let Some(pack) = p.iter().find(|x| x.id == id) {
            if pack.source == "user" {
                let dir = state.roots.user.join(Path::new(&pack.path).file_name().unwrap_or_default());
                if dir.starts_with(&state.roots.user) { let _ = std::fs::remove_dir_all(dir); }
            }
        }
    }
    let ext_path = {
        let p = state.packs.read().map_err(|_| "packs lock".to_string())?;
        p.iter().find(|x| x.id == id).map(|x| x.path.clone()).unwrap_or_default()
    };
    let mut ext = state.external.write().map_err(|_| "external lock".to_string())?;
    ext.retain(|e| e.id != id && e.path != ext_path);
    packs::save_external(&state.roots, &ext)?;
    drop(ext);
    refresh(&app, &state)
}

// 主界面窗口运行时创建：关闭即销毁（WebView 一并释放），下次打开再重建。
// 主窗 URL 带 ?view=settings，前端据此渲染，绝不回退到壁纸引擎。
fn show_settings(w: &tauri::WebviewWindow) {
    // 恢复在前：最小化时 outer_size 是占位小矩形，拿它居中会算歪。
    let _ = w.unminimize();
    // Windows 可能复用旧的最小化/层叠状态，不能只靠「离屏才归位」；
    // 每个新主窗首次显示都强制按主屏居中，之后尊重用户拖过的位置。
    if !SETTINGS_CENTERED.swap(true, Ordering::SeqCst) {
        center_on_primary(w);
    }
    let _ = w.show();
    // 短暂置顶把窗口抬到 WorkerW 壁纸层之上
    let _ = w.set_always_on_top(true);
    let _ = w.set_always_on_top(false);
    let _ = w.set_focus();
}

/// 前端首帧就绪（骨架已渲染）后才显示设置窗，杜绝 WebView 首屏白屏。
/// 必须 async：show_settings 的窗口操作内部 run_on_main_thread+recv，同步 command 跑在主线程会自锁。
#[tauri::command]
pub async fn settings_ready(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        show_settings(&w);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_settings(app: AppHandle, slot: Option<String>) -> Result<(), String> {
    let id = slot.unwrap_or_else(|| "0".into());
    let is_new = app.get_webview_window("settings").is_none();
    if is_new { SETTINGS_CENTERED.store(false, Ordering::SeqCst); }
    let w = match app.get_webview_window("settings") {
        Some(w) => w,
        None => tauri::WebviewWindowBuilder::new(
            &app,
            "settings",
            tauri::WebviewUrl::App("index.html?view=settings".into()),
        )
        .title("小肥鱼宠物")
        .inner_size(1120.0, 720.0)
        .min_inner_size(900.0, 560.0)
        .resizable(true)
        .visible(false)
        // 离屏出生：首帧绘制落在屏幕外，show_settings 就绪后归位居中。
        .position(crate::lifecycle::OFFSCREEN.0, crate::lifecycle::OFFSCREEN.1)
        .build()
        .map_err(|e| e.to_string())?,
    };
    let _ = app.emit("settings://slot", json!(id));
    // 建好即显示：index.html 内联了主窗首屏骨架，show 时立即呈现，
    // 无需等前端 settingsReady / 1.2s 兜底（那会把主窗拖慢 1.2s+）。
    show_settings(&w);
    Ok(())
}

// 待办独立窗：普通带标题栏的小窗，关闭即销毁，下次打开再建；和壁纸层完全解耦。
#[tauri::command]
pub fn open_todo(app: AppHandle) -> Result<(), String> {
    let w = match app.get_webview_window("todo") {
        Some(w) => w,
        None => tauri::WebviewWindowBuilder::new(
            &app,
            "todo",
            tauri::WebviewUrl::App("index.html?view=todo".into()),
        )
        .title("待办提醒")
        .inner_size(340.0, 480.0)
        .min_inner_size(300.0, 300.0)
        .resizable(true)
        .visible(false)
        .position(crate::lifecycle::OFFSCREEN.0, crate::lifecycle::OFFSCREEN.1)
        .build()
        .map_err(|e| e.to_string())?,
    };
    // 离屏出生：show 前归位居中（复用 settings 的幂等逻辑：仅当仍在离屏时归位）。
    recenter_if_offscreen(&w);
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

/// 按主显示器尺寸用 Physical 手算居中；Tauri 的 center() 在多缩放 / 工作区场景下会算偏。
fn center_on_primary(w: &tauri::WebviewWindow) {
    if let Ok(Some(m)) = w.app_handle().primary_monitor() {
        let sz = w.outer_size().unwrap_or(PhysicalSize::new(1120, 720));
        let x = m.position().x + (m.size().width.saturating_sub(sz.width) / 2) as i32;
        let y = m.position().y + (m.size().height.saturating_sub(sz.height) / 2) as i32;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
}

/// 窗口仍在离屏坐标时归位到主屏中央；已归位的不动（用户可能拖过）。
fn recenter_if_offscreen(w: &tauri::WebviewWindow) {
    if let Ok(p) = w.outer_position() {
        if p.x < crate::lifecycle::OFFSCREEN_EDGE || p.y < crate::lifecycle::OFFSCREEN_EDGE {
            center_on_primary(w);
        }
    }
}

#[tauri::command]
pub fn broadcast(app: AppHandle, cmd: String, payload: Value) -> Result<(), String> {
    app.emit("pet://command", json!({ "cmd": cmd, "payload": payload }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_monitors(app: AppHandle) -> Result<Vec<Value>, String> {
    let ms = app.available_monitors().map_err(|e| e.to_string())?;
    Ok(ms.iter()
        .map(|m| json!({
            "name": m.name().cloned().unwrap_or_default(),
            "x": m.position().x, "y": m.position().y,
            "width": m.size().width, "height": m.size().height,
            "scale": m.scale_factor(),
        }))
        .collect())
}

/// 浮层窗口矩形：所有显示器工作区（rcWork，扣掉任务栏）并集，四周内缩 2px。
/// 不用整屏：整屏置顶会被 Windows 判定为全屏应用，触发系统自动「勿扰模式」；
/// 内缩 2px 既避开全屏判定，又不影响桌宠贴边观感。返回物理像素 (x,y,w,h)。
#[cfg(windows)]
pub fn overlay_rect() -> Option<(i32, i32, u32, u32)> {
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
    let mut list: Vec<MONITORINFO> = Vec::new();
    unsafe extern "system" fn collect(_h: HMONITOR, _d: HDC, _r: *mut RECT, lp: LPARAM) -> windows::core::BOOL {
        let list = &mut *(lp.0 as *mut Vec<MONITORINFO>);
        let mut mi = MONITORINFO::default();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(_h, &mut mi).as_bool() { list.push(mi); }
        windows::core::BOOL(1)
    }
    unsafe { let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut list as *mut Vec<MONITORINFO> as isize)); }
    if list.is_empty() { return None; }
    const INSET: i32 = 2;
    let left = list.iter().map(|m| m.rcWork.left).min()? + INSET;
    let top = list.iter().map(|m| m.rcWork.top).min()? + INSET;
    let right = list.iter().map(|m| m.rcWork.right).max()? - INSET;
    let bottom = list.iter().map(|m| m.rcWork.bottom).max()? - INSET;
    Some((left, top, (right - left).max(1) as u32, (bottom - top).max(1) as u32))
}

#[cfg(not(windows))]
pub fn overlay_rect() -> Option<(i32, i32, u32, u32)> { Some((0, 0, 1280, 720)) }

/// 主线程命令（set_config 等）走这里：建窗/attach 内部 run_on_main_thread+recv，
/// 在主线程同步调用会自锁。整段挪到独立线程，主线程立即返回。
pub fn sync_windows_async(app: &AppHandle, cfg: &config::Config) {
    let (a, c) = (app.clone(), cfg.clone());
    std::thread::spawn(move || sync_windows(&a, &c));
}

/// 统一决定浮层窗口的显隐：配置显示开关 + 前端就绪 + 托盘隐藏 + 前台全屏。
/// 幂等，可在任意配置变更 / 托盘操作 / 全屏切换后调用。
/// 注意：配置由调用方传入——set_config 里 AppState 还是旧值，读 state 会慢一拍。
pub fn sync_windows(app: &AppHandle, cfg: &config::Config) {
    // 串行化：多个 async 线程并发进来时，避免同时判定「窗口不存在」而重复建窗。
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = match LOCK.lock() { Ok(g) => g, Err(e) => e.into_inner() };
    let hidden = ALL_HIDDEN.load(Ordering::Relaxed);

    // 浮层：前端要重新 ready，重建后 OVERLAY_READY 需重新置位。
    let overlay_want = OVERLAY_READY.load(Ordering::Relaxed)
        && cfg.overlay_visible
        && !hidden
        && !FULLSCREEN.load(Ordering::Relaxed);
    if overlay_want && app.get_webview_window("overlay").is_none() {
        let _ = crate::lifecycle::spawn(app, "overlay");
        OVERLAY_READY.store(false, Ordering::Relaxed);
    }
    if let Some(w) = app.get_webview_window("overlay") {
        let shown = w.is_visible().unwrap_or(false);
        // 浮层恒置顶（与命中的原生命中窗一致，后者无条件 HWND_TOPMOST + 300ms 兜底）。
        // 不再读 on_top 配置：否则渲染窗不置顶、命中窗却置顶，桌宠被其它窗口盖住。
        let _ = w.set_always_on_top(true);
        // 渲染窗恒鼠标穿透：只画不收事件。命中交给同原点的原生命中窗（overlay_hit），
        // 它按 mask 收鼠标再转发进来。region 不再裁剪渲染 → 边缘零格子。
        let _ = w.set_ignore_cursor_events(true);
        if overlay_want && !shown {
            // 宽限期内复活：取消在途销毁 + 恢复命中状态；真已销毁时由上面的 spawn 重建。
            crate::lifecycle::revive(app, "overlay");
            if let Some((x, y, cw, ch)) = overlay_rect() {
                let _ = w.set_position(PhysicalPosition::new(x, y));
                let _ = w.set_size(PhysicalSize::new(cw, ch));
                #[cfg(windows)]
                crate::overlay_hit::set_bounds(x, y, cw as i32, ch as i32);
            }
        } else if !overlay_want && shown {
            crate::lifecycle::destroy(app, "overlay");
        }
        #[cfg(windows)]
        {
            // set_always_on_top / show / set_size 会让 tao 重设样式，把边框位加回来；
            // 在最终态幂等剥一次，避免 DWM 合成失效的 Win10 露经典边框。
            if let Ok(h) = w.hwnd() {
                crate::win_input::strip_frame(h.0 as isize);
                crate::overlay_hit::set_input_host(h.0 as isize);
            }
            crate::overlay_hit::set_visible(overlay_want);
            crate::overlay_hit::set_enabled(overlay_want && !cfg.overlay_mouse_through);
        }
    }
}

/// 浮层前端启动完成：可以按配置显示（否则一直在等首帧渲染）。
#[tauri::command]
pub fn overlay_ready(app: AppHandle) {
    OVERLAY_READY.store(true, Ordering::Relaxed);
    let cfg = app.state::<AppState>().cfg.lock().map(|c| c.clone()).unwrap_or_default();
    sync_windows_async(&app, &cfg);
}


#[derive(Clone, serde::Deserialize)]
pub struct HitMaskPayload {
    pub cols: usize,
    pub rows: usize,
    pub bits: Vec<u8>,
}

/// 浮层逐像素遮罩：交给独立命中窗生成 HRGN（不裁剪渲染，故无边缘格子）。
#[tauri::command]
pub fn set_overlay_hit_mask(payload: HitMaskPayload) {
    #[cfg(windows)] crate::overlay_hit::set_mask(payload);
    #[cfg(not(windows))] let _ = payload;
}

/// 拖动期间命中窗整窗可命中：拖出宠物像素也能跟住光标，松手恢复 mask region。
#[tauri::command]
pub fn set_overlay_dragging(on: bool) {
    #[cfg(windows)] crate::overlay_hit::set_dragging(on);
    #[cfg(not(windows))] let _ = on;
}

#[tauri::command]
pub fn set_hidden(app: AppHandle, hidden: bool) -> Result<(), String> {
    // 坐标由 save_pet_positions 在拖动松手时即时写盘，磁盘即唯一真相源；
    // 隐藏/退出不需要任何广播等待。旧版 flush+ACK 位掩码只会引入竞态与时序问题。
    ALL_HIDDEN.store(hidden, Ordering::Relaxed);
    let c = app.state::<AppState>().cfg.lock().map(|x| x.clone()).unwrap_or_default();
    sync_windows_async(&app, &c);
    app.emit("pet://visible", !hidden).map_err(|e| e.to_string())
}

pub fn is_hidden() -> bool { ALL_HIDDEN.load(Ordering::Relaxed) }

#[tauri::command]
pub fn reset_config(app: AppHandle, state: State<'_, AppState>) -> Result<config::Config, String> {
    let c = config::Config::default();
    config::save(&state.roots.data, &c)?;
    // 坐标独立文件也重置，否则下次启动旧坐标会被灌回。
    let _ = positions::save(&state.roots.data, &positions::Positions::default());
    POS_SEQ.fetch_add(1, Ordering::SeqCst);
    apply(&app, &c);
    if let Ok(mut g) = state.cfg.lock() { *g = c.clone(); }
    app.emit("config://changed", &c).map_err(|e| e.to_string())?;
    Ok(c)
}

#[tauri::command]
pub fn show_data_dir(state: State<'_, AppState>) -> Result<(), String> {
    open::that(&state.roots.data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> { open::that(url).map_err(|e| e.to_string()) }

/// 全部显示器工作区并集（屏幕减任务栏），换算为浮层窗口内的逻辑（CSS）坐标：
/// 物理坐标 → 减窗口原点（各显示器最小值）→ 除以 scale_factor。
/// 桌宠物理边界要在任务栏上方回弹，多显示器拼接区域都支持。
#[tauri::command]
pub fn work_area(app: AppHandle, label: Option<String>) -> Result<Value, String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{LPARAM, RECT};
        use windows::Win32::Graphics::Gdi::{
            EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
        };
        // 用浮层窗口自己的 DPI：拿错 scale 会把工作区坐标算大，导致桌宠落地超出屏幕底部。
        let label = label.as_deref().unwrap_or("overlay");
        let scale = app.get_webview_window(label)
            .or_else(|| app.get_webview_window("overlay"))
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0) as f64;
        unsafe {
            let mut list: Vec<MONITORINFO> = Vec::new();
            unsafe extern "system" fn collect(
                _hmon: HMONITOR, _hdc: HDC, _rect: *mut RECT, lp: LPARAM,
            ) -> windows::core::BOOL {
                let list = &mut *(lp.0 as *mut Vec<MONITORINFO>);
                let mut mi = MONITORINFO::default();
                mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(_hmon, &mut mi).as_bool() { list.push(mi); }
                windows::core::BOOL(1)
            }
            let _ = EnumDisplayMonitors(
                None, None,
                Some(collect),
                LPARAM(&mut list as *mut Vec<MONITORINFO> as isize),
            );
            if list.is_empty() { return Err("未找到显示器".into()); }
            // 并集（任意位置的任务栏都会被对应显示器的工作区扣掉）
            let left = list.iter().map(|m| m.rcWork.left).min().unwrap_or(0);
            let top = list.iter().map(|m| m.rcWork.top).min().unwrap_or(0);
            let right = list.iter().map(|m| m.rcWork.right).max().unwrap_or(0);
            let bottom = list.iter().map(|m| m.rcWork.bottom).max().unwrap_or(0);
            // 窗口原点 = 各显示器物理原点最小值（浮层边界同款算法）
            let ox = list.iter().map(|m| m.rcMonitor.left).min().unwrap_or(0);
            let oy = list.iter().map(|m| m.rcMonitor.top).min().unwrap_or(0);
            let x = (left - ox) as f64 / scale;
            let y = (top - oy) as f64 / scale;
            let w = (right - left) as f64 / scale;
            let h = (bottom - top) as f64 / scale;
            return Ok(json!({ "x": x.floor(), "y": y.floor(), "w": w.ceil(), "h": h.ceil() }));
        }
    }
    #[allow(unreachable_code)]
    Err("work_area 不可用".into())
}

/// 退出：强制把内存权威坐标刷到 positions.json，再退出。
/// 不依赖前端 IPC（退出瞬间 WebView 可能已销毁、IPC 排不上队），Rust 自己同步写盘。
#[tauri::command]
pub fn quit(app: AppHandle) {
    flush_positions(&app);
    app.exit(0);
}

pub fn apply(app: &AppHandle, cfg: &config::Config) {
    let sample = cfg.flag("island_enabled", false)
        && (cfg.flag("island_show_cpu", false)
            || cfg.flag("island_show_mem", false)
            || cfg.flag("island_show_network", false));
    if let Ok(m) = app.state::<AppState>().metrics.read() { m.set(sample); }
    sync_windows_async(app, cfg);
}

pub fn handle_menu(app: &AppHandle, id: &str) {
    let emit = |cmd: &str| {
        let _ = app.emit("pet://command", json!({ "cmd": cmd, "payload": Value::Null }));
    };
    match id {
        "tray.show" => emit("toggle-visible"),
        "tray.through" => emit("toggle-through"),
        "tray.quiet" => emit("toggle-quiet"),
        "tray.todo" => { let _ = open_todo(app.clone()); },
        "tray.autostart" => emit("toggle-autostart"),
        "tray.quit" => quit(app.clone()),
        _ => {}
    }
}

#[cfg(test)]
mod position_tests {
    use super::*;
    use config::{Config, PetConfig};

    fn pet(id: &str) -> PetConfig {
        let mut p = PetConfig::default();
        p.id = id.into();
        p.x = 10.0; p.y = 20.0; p.ox = Some(30.0); p.oy = Some(40.0);
        p
    }

    #[test]
    fn overlay_update_only_touches_ox_oy() {
        let mut cfg = Config::default();
        cfg.pets = vec![pet("a")];
        apply_positions(&mut cfg, &[("a".into(), "overlay".into(), 100.0, 200.0)]);
        let p = &cfg.pets[0];
        assert_eq!((p.x, p.y), (10.0, 20.0), "壁纸层坐标不应被浮层上报改动");
        assert_eq!((p.ox, p.oy), (Some(100.0), Some(200.0)));
    }

    #[test]
    fn wallpaper_update_only_touches_x_y() {
        let mut cfg = Config::default();
        cfg.pets = vec![pet("a")];
        apply_positions(&mut cfg, &[("a".into(), "wallpaper".into(), 88.0, 99.0)]);
        let p = &cfg.pets[0];
        assert_eq!((p.x, p.y), (88.0, 99.0));
        assert_eq!((p.ox, p.oy), (Some(30.0), Some(40.0)), "浮层坐标不应被壁纸层上报改动");
    }

    #[test]
    fn unknown_id_is_ignored() {
        let mut cfg = Config::default();
        cfg.pets = vec![pet("a")];
        apply_positions(&mut cfg, &[("ghost".into(), "overlay".into(), 1.0, 2.0)]);
        assert_eq!((cfg.pets[0].ox, cfg.pets[0].oy), (Some(30.0), Some(40.0)));
    }

    #[test]
    fn merge_from_disk_keeps_real_positions_but_keeps_new_pet() {
        let mut disk = Config::default();
        disk.pets = vec![pet("a")];           // 磁盘：a 的真实坐标
        let mut incoming = Config::default();
        let mut a = pet("a");
        a.x = -1.0; a.y = -1.0; a.ox = None; a.oy = None; // 整份写回里 a 的坐标是旧/空值
        incoming.pets = vec![a, pet("new")];              // 另有一只新宠物
        merge_positions(&disk, &mut incoming);
        assert_eq!((incoming.pets[0].x, incoming.pets[0].y), (10.0, 20.0));
        assert_eq!((incoming.pets[0].ox, incoming.pets[0].oy), (Some(30.0), Some(40.0)));
        assert_eq!((incoming.pets[1].x, incoming.pets[1].y), (10.0, 20.0), "新宠物保留自身初始值");
    }
}

#[cfg(test)]
mod click_sound_tests {
    use super::*;

    #[test]
    fn first_click_always_allowed() {
        assert_eq!(claim_click_slot(0, 1000), Some(1000));
    }

    #[test]
    fn click_within_interval_is_throttled() {
        assert_eq!(claim_click_slot(1000, 1050), None, "50ms < 100ms 应被吞");
        assert_eq!(claim_click_slot(1000, 1099), None, "99ms < 100ms 应被吞");
    }

    #[test]
    fn click_at_interval_boundary_allowed() {
        assert_eq!(claim_click_slot(1000, 1100), Some(1100), "恰好 100ms 应放行");
    }

    #[test]
    fn clock_going_backwards_is_throttled() {
        // 系统时间回拨（NTP 校正）：saturating_sub 得 0，应吞而非放行
        assert_eq!(claim_click_slot(2000, 1500), None);
    }
}

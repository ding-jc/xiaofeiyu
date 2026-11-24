// 右键菜单：独立透明 webview 窗渲染（.modern-menu 样式 + 主窗口同一套 Lucide 图标）。
//
// Rust 只做三件事：把待渲染的菜单树交给页面、按页面量出来的矩形摆放窗口、等一个选中结果。
// 布局（含子菜单翻转、屏幕边界收拢）全部在页面里算，Rust 不重复实现一套几何。
//
// 窗口阴影关掉、无边框、尺寸恰好等于面板并集，所以透明区域不会被任何东西挡住。
#![cfg(windows)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::{
    Foundation::POINT,
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST},
};

#[derive(Clone, Copy, Serialize)]
pub struct WorkArea {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[derive(Clone, Serialize)]
pub struct Pending {
    seq: u64,
    items: Value,
    tray: bool,
    ax: f64,
    ay: f64,
    /// 锚点所在显示器的缩放：菜单窗建在主屏，跨屏时窗口自身 scale_factor 不是目标屏的
    sf: f64,
    work: WorkArea,
}

#[derive(Clone)]
pub struct Pick {
    path: Vec<usize>,
    id: Option<String>,
}

static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
type Waiter = tauri::async_runtime::Sender<Option<Pick>>;
static WAIT: OnceLock<Mutex<Option<Waiter>>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(1);
/// 已经上屏的是哪一次弹出（0 = 没有）；看门狗据此判断自己那一轮是否被接管。
static SHOWN_SEQ: AtomicU64 = AtomicU64::new(0);
/// 最近一次真正生效的窗口矩形，尺寸没变就不重复 set_size/set_position（避免悬停时抖）。
static LAST_RECT: OnceLock<Mutex<Option<(i32, i32, i32, i32)>>> = OnceLock::new();
fn last_rect() -> &'static Mutex<Option<(i32, i32, i32, i32)>> {
    LAST_RECT.get_or_init(|| Mutex::new(None))
}

fn pending_slot() -> &'static Mutex<Option<Pending>> { PENDING.get_or_init(|| Mutex::new(None)) }
fn wait_slot() -> &'static Mutex<Option<Waiter>> { WAIT.get_or_init(|| Mutex::new(None)) }

unsafe fn work_area_phys(ax: f64, ay: f64) -> (i32, i32, i32, i32) {
    let pt = POINT { x: ax as i32, y: ay as i32 };
    let mon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if GetMonitorInfoW(mon, &mut mi).as_bool() {
        (mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom)
    } else {
        (0, 0, 1920, 1080)
    }
}

fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("menu") { return Ok(w); }
    WebviewWindowBuilder::new(app, "menu", WebviewUrl::App("index.html?view=menu".into()))
        .title("")
        .inner_size(2.0, 2.0)
        .position(-30000.0, -30000.0) // 首次定位前先放到屏幕外，避免左上角闪一下
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

fn deliver(app: &AppHandle, p: Option<Pick>) {
    let Some(tx) = wait_slot().lock().ok().and_then(|mut g| g.take()) else { return };
    if tx.try_send(p).is_ok() {
        if let Some(w) = app.get_webview_window("menu") { let _ = w.hide(); }
    }
}

/// 弹菜单并等结果：tray=true 表示右对齐锚点、向上展开（托盘图标在屏幕底边）。
async fn show(app: &AppHandle, items: Value, at: (f64, f64), tray: bool, scale: f64) -> Result<Option<Pick>, String> {
    if items.as_array().map(|a| a.is_empty()).unwrap_or(true) { return Ok(None); }
    let sf = if scale > 0.0 { scale } else { 1.0 };
    let (l, t, r, b) = unsafe { work_area_phys(at.0, at.1) };
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let p = Pending {
        seq,
        items,
        tray,
        ax: at.0 / sf,
        ay: at.1 / sf,
        sf,
        work: WorkArea {
            left: l as f64 / sf,
            top: t as f64 / sf,
            right: r as f64 / sf,
            bottom: b as f64 / sf,
        },
    };
    if let Ok(mut g) = pending_slot().lock() { *g = Some(p); }
    let (tx, mut rx) = tauri::async_runtime::channel::<Option<Pick>>(1);
    if let Ok(mut g) = wait_slot().lock() { *g = Some(tx); }
    if let Ok(mut g) = last_rect().lock() { *g = None; }

    // 窗口在首次弹出时现建，页面加载完会自己拉 pending，所以事件丢了也不影响
    if let Err(e) = ensure_window(app) {
        if let Ok(mut g) = wait_slot().lock() { g.take(); }
        if let Ok(mut g) = pending_slot().lock() { g.take(); }
        return Err(e);
    }
    let _ = app.emit_to("menu", "menu://show", seq);

    // 看门狗：webview 崩了/没起来也要把调用方放出来，不能让托盘右键卡死。
    // 只对"仍然是自己这一轮、且始终没上屏"的情况收摊，避免把后一次弹出误杀。
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        let mine = pending_slot().lock().map(|g| g.as_ref().map(|p| p.seq) == Some(seq)).unwrap_or(false);
        if mine && SHOWN_SEQ.load(Ordering::Relaxed) != seq {
            deliver(&app2, None);
            if let Some(w) = app2.get_webview_window("menu") { let _ = w.destroy(); }
        }
    });

    let picked = rx.recv().await.flatten();
    // 期间又弹了一次：这一轮已被接管，别去关新一轮的窗
    let mine = pending_slot().lock().map(|g| g.as_ref().map(|x| x.seq) == Some(seq)).unwrap_or(false);
    if mine {
        if let Ok(mut g) = pending_slot().lock() { g.take(); }
        if let Ok(mut g) = wait_slot().lock() { g.take(); }
        if let Some(w) = app.get_webview_window("menu") { let _ = w.hide(); }
    }
    Ok(picked)
}

/// 页面加载后（或收到 menu://show 后）来取当前要渲染的菜单树。
#[command]
pub fn menu_pending() -> Option<Pending> {
    pending_slot().lock().ok().and_then(|g| g.clone())
}

/// 页面量好面板并集后回填：x/y/w/h 都是 CSS px，x/y 是窗口左上角在屏幕上的位置。
#[command]
pub fn menu_layout(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let Some(win) = app.get_webview_window("menu") else { return Err("菜单窗不存在".into()) };
    let sf = pending_slot().lock().ok()
        .and_then(|g| g.as_ref().map(|p| p.sf))
        .unwrap_or_else(|| win.scale_factor().unwrap_or(1.0));
    let rect = (
        (x * sf).round() as i32,
        (y * sf).round() as i32,
        (w.max(1.0) * sf).round() as i32,
        (h.max(1.0) * sf).round() as i32,
    );
    let unchanged = last_rect().lock().map(|g| *g == Some(rect)).unwrap_or(false);
    if !unchanged {
        let _ = win.set_size(tauri::LogicalSize::new(w.max(1.0), h.max(1.0)));
        let _ = win.set_position(tauri::PhysicalPosition::new(rect.0, rect.1));
        if let Ok(mut g) = last_rect().lock() { *g = Some(rect); }
    }
    if !win.is_visible().unwrap_or(false) {
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Ok(g) = pending_slot().lock() {
        if let Some(p) = g.as_ref() { SHOWN_SEQ.store(p.seq, Ordering::Relaxed); }
    }
    Ok(())
}

/// 选中：path 是原始数组下标路径（桌宠菜单用），id 是稳定字符串（托盘用）。
#[command]
pub fn menu_pick(app: AppHandle, path: Option<Vec<usize>>, id: Option<String>) {
    deliver(&app, Some(Pick { path: path.unwrap_or_default(), id }));
}

#[command]
pub fn menu_cancel(app: AppHandle) { deliver(&app, None); }

/// 桌宠右键菜单：items 是前端序列化的菜单树，返回选中项的原始下标路径。
#[command]
pub async fn native_menu_show(
    app: AppHandle,
    items: Value,
    x: f64,
    y: f64,
    layer: Option<String>,
) -> Result<Option<Vec<usize>>, String> {
    let src = app.get_webview_window(layer.as_deref().unwrap_or("overlay"))
        .or_else(|| app.get_webview_window("overlay"))
        .ok_or("桌宠窗口不存在")?;
    let pos = src.outer_position().map_err(|e| e.to_string())?;
    let sf = src.scale_factor().unwrap_or(1.0);
    let at = (pos.x as f64 + x * sf, pos.y as f64 + y * sf);
    let picked = show(&app, items, at, false, sf).await?;
    Ok(picked.map(|p| p.path).filter(|p| !p.is_empty()))
}

/// 托盘右键菜单：弹出位置右对齐到托盘图标并向上展开，返回选中项 id。
#[command]
pub async fn native_tray_menu_show(
    app: AppHandle,
    items: Value,
    x: i32,
    y: i32,
    scale: Option<f64>,
) -> Result<Option<String>, String> {
    let picked = show(&app, items, (x as f64, y as f64), true, scale.unwrap_or(1.0)).await?;
    Ok(picked.and_then(|p| p.id))
}

/// 给 lib.rs 的窗口事件用：菜单窗失焦（点了别处）或被销毁（Alt+F4 / 渲染进程出错被
/// 对账关掉）都视为取消，保证调用方一定拿到结果，不会一直挂着。
pub fn cancel(app: &AppHandle) {
    let waiting = wait_slot().lock().map(|g| g.is_some()).unwrap_or(false);
    if waiting { deliver(app, None); }
}

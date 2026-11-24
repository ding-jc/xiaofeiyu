// 浮层命中层：一张全透明置顶的原生 Win32 窗，铺满虚拟桌面。
// 只按桌宠 alpha mask 收鼠标（HRGN），透明区整棵窗口树退出命中、原生直达下层。
// 渲染窗恒带 WS_EX_TRANSPARENT 完全穿透、只管画（故渲染零裁剪、边缘无格子）；也正因如此
// Chromium 会丢弃 PostMessage 进来的鼠标消息——所以收到的鼠标不转发 WebView，而是 emit
// overlay://mouse 语义事件，前端合成 PointerEvent 派发给既有 .pet-hit，交互逻辑一行不改。
use crate::commands::HitMaskPayload;
use std::sync::{
    atomic::{AtomicBool, AtomicIsize, Ordering},
    OnceLock, RwLock,
};
use tauri::Emitter;
use windows::core::w;
use windows::Win32::{
    Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, HBRUSH, HGDIOBJ, RGN_OR, SetWindowRgn},
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        Controls::WM_MOUSELEAVE,
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, GetKeyState, ReleaseCapture, SetCapture, TrackMouseEvent,
            VK_CONTROL, VK_LBUTTON, VK_SHIFT, TRACKMOUSEEVENT, TME_LEAVE,
        },
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetMessageW,
            GetWindowRect, GetWindowLongPtrW, HICON, HCURSOR, LoadCursorW, PostMessageW,
            RegisterClassExW, SetCursor, SetTimer, SetWindowPos, ShowWindow,
            TranslateMessage, CS_DBLCLKS, HWND_TOPMOST, IDC_ARROW, MSG, SW_HIDE, SW_SHOWNOACTIVATE,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOOWNERZORDER,
            WM_CANCELMODE, WM_CAPTURECHANGED, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
            WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETCURSOR, WM_TIMER,
            WNDCLASSEXW, WINDOW_LONG_PTR_INDEX, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
        },
    },
};

#[derive(Default)]
struct Mask { cols: usize, rows: usize, bits: Vec<u8> }

static MASK: OnceLock<RwLock<Mask>> = OnceLock::new();
static HIT: AtomicIsize = AtomicIsize::new(0);   // 命中窗
static ENABLED: AtomicBool = AtomicBool::new(true); // false=整层穿透
static DRAG: AtomicBool = AtomicBool::new(false);   // 拖动中：整窗可命中，跟住光标
static CAPTURED: AtomicBool = AtomicBool::new(false); // 已 SetCapture：拖过其它窗口时鼠标消息仍归命中窗
static VISIBLE: AtomicBool = AtomicBool::new(false);
// 命中窗线程异步创建，sync 可能先到；缓存状态待建好后补应用。
static BOUNDS: std::sync::Mutex<(i32, i32, i32, i32)> = std::sync::Mutex::new((0, 0, 1, 1));
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn mask() -> &'static RwLock<Mask> { MASK.get_or_init(|| RwLock::new(Mask::default())) }
unsafe fn hwnd(v: isize) -> HWND { HWND(v as *mut core::ffi::c_void) }

/// region 重建请求：自定义消息，只能由命中窗线程（HWND 拥有者）执行。
/// 其它线程（IPC set_mask / set_enabled / heal_state 定时器）一律 PostMessage 投递后立即返回，
/// 杜绝跨线程 SetWindowRgn 等待造成的主线程死锁（AppHangB1）。
const WM_REBUILD_REGION: u32 = 0x8000 + 1; // WM_APP + 1

/// 从任意线程安全请求一次 region 重建。PostMessage 非阻塞， même 命中窗线程自己调用也
/// 只是入队、下一步消息循环处理，不会重入。
fn request_rebuild() {
    let raw = HIT.load(Ordering::Acquire);
    if raw == 0 { return; }
    unsafe { let _ = PostMessageW(Some(hwnd(raw)), WM_REBUILD_REGION, WPARAM(0), LPARAM(0)); }
}

// 命中窗必须有自己的箭头光标：hCursor=NULL 且不管 WM_SETCURSOR 时，
// 鼠标进入窗口会沿用主线程上一处留下的忙碌光标（沙漏/加载圈）。
// 系统光标由系统缓存，LoadCursorW 取的是共享句柄，无需自己缓存（HCURSOR 非 Send/Sync）。
unsafe fn arrow_cursor() -> HCURSOR { LoadCursorW(None, IDC_ARROW).unwrap_or_default() }

pub fn init(app: tauri::AppHandle) { let _ = APP.set(app); }

/// 命中窗线程：创建全透明窗后跑自己的消息循环（与 tao 主线程互不干扰）。
pub fn start() {
    std::thread::spawn(|| unsafe {
        let Ok(hmod) = GetModuleHandleW(None) else { return };
        let instance = HINSTANCE(hmod.0);
        let cls = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_DBLCLKS,
            lpfnWndProc: Some(hit_proc),
            hInstance: HINSTANCE(hmod.0),
            hIcon: HICON::default(),
            hCursor: arrow_cursor(),
            hbrBackground: HBRUSH::default(),
            lpszMenuName: windows::core::PCWSTR::null(),
            lpszClassName: w!("PixupPetHitLayer"),
            hIconSm: HICON::default(),
            ..Default::default()
        };
        RegisterClassExW(&cls);
        // 不用 WS_EX_LAYERED：alpha=0 的分层窗不参与 hit-test，鼠标会直达桌面收不到消息。
        // 普通空窗 + HRGN 限定形状即可，region 内命中、外穿透，且不渲染任何内容。
        let Ok(h) = CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            w!("PixupPetHitLayer"), w!(""), WS_POPUP,
            0, 0, 1, 1, None, None, Some(instance), None,
        ) else { return };
        let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        HIT.store(h.0 as isize, Ordering::Release);
        apply_cached();
        // WS_EX_TOPMOST 会被其它窗口置顶 / 焦点切换偶发清掉（表现为浮层被盖住时无法交互）。
        // 300ms 定时兜底：丢了就补压顶，开销仅一次 GetWindowLongPtr。
        let _ = SetTimer(Some(h), 1, 300, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

/// 保留签名供 commands.rs 调用：交互已改走 IPC，无需记录渲染窗 hwnd。
pub fn set_input_host(_host: isize) {}

/// 膨胀 mask → 行游程合并矩形 → HRGN → 命中窗 region。渲染窗从不参与裁剪。
// 只在命中窗线程调用（WM_REBUILD_REGION 消息 / apply_cached 启动时）。
// 绝不从其它线程直接调用：SetWindowRgn(fRedraw=true) 会同步 marshal 到拥有线程并等它 pump，
// 与命中窗线程自己的 region 重建互等即死锁（AppHangB1）。
unsafe fn rebuild_region() {
    let raw = HIT.load(Ordering::Acquire);
    if raw == 0 { return; }
    let h = hwnd(raw);
    let mut rect = RECT::default();
    if GetWindowRect(h, &mut rect).is_err() { return; }
    let w = rect.right - rect.left;
    let hh = rect.bottom - rect.top;
    if w <= 0 || hh <= 0 { return; }
    let base = if DRAG.load(Ordering::Relaxed) {
        // 拖动中光标必在宠物上：整窗可命中，拖出宠物像素也能跟住（松手恢复 mask）
        CreateRectRgn(0, 0, w, hh)
    } else if !ENABLED.load(Ordering::Relaxed) {
        CreateRectRgn(0, 0, 0, 0) // 整层穿透
    } else {
        let m = match mask().read() { Ok(v) => v, Err(_) => return };
        if m.cols == 0 || m.rows == 0 { CreateRectRgn(0, 0, 0, 0) }
        else {
            // 3x3 膨胀：region 边界落在宠物透明外围，命中判定略宽于可见像素，手感自然
            let mut grown = vec![0u8; m.cols * m.rows];
            for gy in 0..m.rows {
                for gx in 0..m.cols {
                    if m.bits[gy * m.cols + gx] == 0 { continue; }
                    for dy in -1isize..=1 {
                        for dx in -1isize..=1 {
                            let nx = gx as isize + dx;
                            let ny = gy as isize + dy;
                            if nx < 0 || nx >= m.cols as isize || ny < 0 || ny >= m.rows as isize { continue; }
                            grown[ny as usize * m.cols + nx as usize] = 1;
                        }
                    }
                }
            }
            let cw = w as f64 / m.cols as f64;
            let ch = hh as f64 / m.rows as f64;
            let rgn = CreateRectRgn(0, 0, 0, 0);
            for gy in 0..m.rows {
                let mut run: Option<usize> = None;
                for gx in 0..=m.cols {
                    let on = gx < m.cols && grown[gy * m.cols + gx] != 0;
                    if on {
                        if run.is_none() { run = Some(gx); }
                    } else if let Some(s) = run.take() {
                        let r = CreateRectRgn(
                            (s as f64 * cw) as i32,
                            (gy as f64 * ch) as i32,
                            (gx as f64 * cw).ceil() as i32,
                            ((gy + 1) as f64 * ch).ceil() as i32,
                        );
                        let _ = CombineRgn(Some(rgn), Some(rgn), Some(r), RGN_OR);
                        // CombineRgn 不接管 r，逐帧累积会耗尽 GDI 句柄（上限 10000）→
                        // CreateRectRgn 返回 NULL → region 清空 → 命中窗整屏命中锁死。
                        let _ = DeleteObject(HGDIOBJ(r.0));
                    }
                }
            }
            rgn
        }
    };
    // fRedraw=false：命中窗全透明、无可视内容，重绘无意义；更重要的是
    // SetWindowRgn(fRedraw=true) 会向拥有线程同步投递 WM_* 并等待其 pump，
    // 而本函数由命中窗线程自己调用（WM_REBUILD_REGION / apply_cached），
    // 与命中窗线程自己的 region 重建互相等待 → 死锁（AppHang）。false 直接改区域不泵消息。
    let _ = SetWindowRgn(h, Some(base), false);
}

pub fn set_mask(p: HitMaskPayload) {
    let cols = p.cols.clamp(1, 512);
    let rows = p.rows.clamp(1, 512);
    let mut bits = p.bits;
    bits.resize(cols * rows, 0);
    if let Ok(mut m) = mask().write() { *m = Mask { cols, rows, bits }; }
    request_rebuild();
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    request_rebuild();
}

pub fn set_dragging(on: bool) {
    if on == DRAG.swap(on, Ordering::Relaxed) { return; }
    request_rebuild();
}

/// 命中窗铺满虚拟桌面（与渲染窗同原点同尺寸）。
pub fn set_bounds(x: i32, y: i32, w: i32, h: i32) {
    if let Ok(mut b) = BOUNDS.lock() { *b = (x, y, w, h); }
    let raw = HIT.load(Ordering::Acquire);
    if raw == 0 { return; }
    unsafe {
        let _ = SetWindowPos(hwnd(raw), Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);
    }
}

pub fn set_visible(on: bool) {
    VISIBLE.store(on, Ordering::Relaxed);
    let raw = HIT.load(Ordering::Acquire);
    if raw == 0 { return; }
    unsafe {
        let _ = ShowWindow(hwnd(raw), if on { SW_SHOWNOACTIVATE } else { SW_HIDE });
        // show 时重新压顶：WS_EX_TOPMOST 会被某些系统操作清掉，丢了就穿到桌面下收不到鼠标
        if on { let _ = SetWindowPos(hwnd(raw), Some(HWND_TOPMOST), 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); }
    }
}

/// 命中窗线程建好后补应用 sync 先到的状态（幂等）。
unsafe fn apply_cached() {
    let (x, y, w, h) = BOUNDS.lock().map(|b| *b).unwrap_or((0, 0, 1, 1));
    let raw = HIT.load(Ordering::Acquire);
    let _ = SetWindowPos(hwnd(raw), Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);
    let _ = ShowWindow(hwnd(raw), if VISIBLE.load(Ordering::Relaxed) { SW_SHOWNOACTIVATE } else { SW_HIDE });
    if VISIBLE.load(Ordering::Relaxed) {
        let _ = SetWindowPos(hwnd(raw), Some(HWND_TOPMOST), 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    rebuild_region();
}

/// 光标物理屏幕坐标（本进程 DPI-aware，GetCursorPos 返回物理像素）。
/// 前端按 devicePixelRatio 换算成 CSS 坐标再做 elementFromPoint。
unsafe fn cursor_client(_h: HWND) -> (i32, i32) {
    let mut pt = POINT::default();
    if GetCursorPos(&mut pt).is_err() { return (0, 0); }
    (pt.x, pt.y)
}

/// 把鼠标语义 emit 给浮层前端：那里合成 PointerEvent 派发到既有 .pet-hit。
/// 不转发原生消息——渲染窗的 WS_EX_TRANSPARENT 会让 Chromium 丢弃一切 PostMessage 鼠标。
/// sound：仅 up 事件带，表示这次松手被命中窗裁决为「有效点击且允许播放音效」。
unsafe fn emit_mouse(h: HWND, kind: &str, button: i32, delta: f64, sound: bool) {
    let Some(app) = APP.get() else { return };
    let (x, y) = cursor_client(h);
    let shift = (GetKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0;
    let ctrl = (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
    let _ = app.emit("overlay://mouse", serde_json::json!({
        "type": kind, "x": x, "y": y, "button": button,
        "shift": shift, "ctrl": ctrl, "delta": delta, "sound": sound,
    }));
}

/// 兜底恢复置顶：系统偶发清掉 WS_EX_TOPMOST 后，命中窗会被普通窗口盖住、浮层失去交互。
/// 仅可见且启用时补压顶；region 为空（穿透）时无需处理。
unsafe fn keep_topmost(h: HWND) {
    if !VISIBLE.load(Ordering::Relaxed) || !ENABLED.load(Ordering::Relaxed) { return; }
    const WS_EX_TOPMOST: isize = 0x8;
    if GetWindowLongPtrW(h, WINDOW_LONG_PTR_INDEX(-20)) & WS_EX_TOPMOST == 0 {
        let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
}

/// 状态看门狗（WM_TIMER 每 300ms 触发）：修复鼠标捕获因事件丢失而永久卡死。
/// up/cancel 一旦丢包，CAPTURED 卡 true → 前端 dragging 卡住、body 不落盘。
/// 这里按物理实时态校验并强制复位。
unsafe fn heal_state(h: HWND) {
    // 物理左键已松开但 CAPTURED 仍 true（up/cancel 事件丢失），补发收尾。
    // 下次 down 因 CAPTURED 已 true 不再 SetCapture，拖过其它窗口会继续丢事件。
    // GetAsyncKeyState 读物理实时态，不依赖本窗口消息队列。
    if CAPTURED.load(Ordering::Relaxed) {
        let down = (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0;
        if !down { end_capture(h, false); }
    }
}

/// 释放左键捕获并收尾。系统级捕获丢失（Alt+Tab / 切窗口 / WM_CANCELMODE）时也要走这里：
/// 补发 up 让前端 endDrag，否则 body.dragging 卡住、坐标不落盘。
unsafe fn end_capture(h: HWND, sound: bool) {
    if CAPTURED.swap(false, Ordering::AcqRel) {
        let _ = ReleaseCapture();
        emit_mouse(h, "up", 0, 0.0, sound);
    }
}

unsafe extern "system" fn hit_proc(h: HWND, msg: u32, _w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        // 所有 region 重建都在这里、由 HWND 拥有线程串行执行（见 request_rebuild）。
        WM_REBUILD_REGION => { rebuild_region(); LRESULT(0) }
        WM_TIMER => { if _w.0 == 1 { keep_topmost(h); heal_state(h); } LRESULT(0) }
        // 每次命中判定都强制回箭头：系统/主线程若正忙，光标会在窗口间串成加载态。
        WM_SETCURSOR => { let _ = SetCursor(Some(arrow_cursor())); LRESULT(1) }
        WM_MOUSEMOVE => {
            let mut tme = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE,
                hwndTrack: h,
                dwHoverTime: 0,
            };
            let _ = TrackMouseEvent(&mut tme);
            emit_mouse(h, "move", 0, 0.0, false);
            LRESULT(0)
        }
        WM_MOUSELEAVE => { emit_mouse(h, "leave", 0, 0.0, false); LRESULT(0) }
        WM_LBUTTONDOWN => {
            // 按下即捕获：拖拽经过其它顶层窗口时，Windows 仍把 move/up 投递到本命中窗，
            // 否则消息随光标落到别人窗口，前端收不到 move → 拖拽卡住、坐标不落盘。
            if !CAPTURED.swap(true, Ordering::AcqRel) { let _ = SetCapture(h); }
            emit_mouse(h, "down", 0, 0.0, false);
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            // 音效裁决提前到唯一的真实点击源：命中窗收到 up 的瞬间本地 CAS。
            // DRAG 期间整窗可命中，松手是拖动结束不是点击，不裁决也不占用 slot。
            let drag = DRAG.load(Ordering::Relaxed);
            let sound = !drag && crate::commands::claim_click_sound();
            end_capture(h, sound);
            LRESULT(0)
        }
        // 系统取消捕获（Alt+Tab、切窗口、弹系统菜单等）：兜底收尾，避免拖拽状态卡死。
        WM_CANCELMODE | WM_CAPTURECHANGED => { end_capture(h, false); LRESULT(0) }
        WM_RBUTTONDOWN => { emit_mouse(h, "rdown", 2, 0.0, false); LRESULT(0) }
        WM_RBUTTONUP => { emit_mouse(h, "contextmenu", 2, 0.0, false); LRESULT(0) }
        WM_LBUTTONDBLCLK => {
            // CS_DBLCLKS 下，第二次按下系统只发 DBLCLK、不再发 WM_LBUTTONDOWN。
            // 前端靠 pointerdown 置 this.down，缺了它随后的 up 不会 tap→不响、不触发单击动作。
            // 补发 down 让 pointerdown→pointerup 配对完整；dblclick 仍照发，双击动作不受影响。
            emit_mouse(h, "down", 0, 0.0, false);
            emit_mouse(h, "dblclick", 0, 0.0, false);
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let delta = ((_w.0 >> 16) & 0xFFFF) as i16;
            emit_mouse(h, "wheel", 0, -(delta as f64 / 120.0) * 100.0, false);
            LRESULT(0)
        }
        _ => DefWindowProcW(h, msg, _w, l),
    }
}

// Windows 窗口工具：剥边框样式位、从任务栏缩略图隐藏、前台全屏检测。
// 供浮层渲染窗 / 菜单窗 / 全屏自愈使用；与已移除的壁纸输入转发无关。
use windows::{
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{
            GetAncestor, GetClassNameA, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect,
            GetWindowThreadProcessId, SetWindowLongPtrW, SetWindowPos,
            GA_ROOT, GWL_EXSTYLE, GWL_STYLE,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            WS_BORDER, WS_CAPTION, WS_DLGFRAME, WS_EX_TOOLWINDOW, WS_THICKFRAME,
        },
    },
};

unsafe fn hwnd(v: isize) -> HWND { HWND(v as *mut core::ffi::c_void) }
unsafe fn class_of(h: HWND) -> String {
    let mut buf = [0u8; 16];
    let n = GetClassNameA(h, &mut buf);
    if n <= 0 { return String::new(); }
    String::from_utf8_lossy(&buf[..n as usize]).into_owned()
}

/// 剥掉窗口的经典边框样式位。tao 的 decorations=false 只靠 DWM 视觉隐藏边框，
/// 样式位里仍留 WS_CAPTION/WS_THICKFRAME；DWM 合成失效的 Win10 上就会露出 Win7 边框。
pub fn strip_frame(h: isize) {
    if h == 0 { return; }
    unsafe {
        let hw = hwnd(h);
        let style = GetWindowLongPtrW(hw, GWL_STYLE);
        let frame = (WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME).0 as isize;
        let stripped = style & !frame;
        if stripped != style {
            SetWindowLongPtrW(hw, GWL_STYLE, stripped);
            let _ = SetWindowPos(hw, None, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
    }
}

/// 把透明浮层窗从任务栏缩略图 / Alt-Tab 中移除。WS_EX_TOOLWINDOW 是原生层保证（命中窗也用它）。
pub fn hide_from_taskbar(h: isize) {
    if h == 0 { return; }
    unsafe {
        let hw = hwnd(h);
        let ex = GetWindowLongPtrW(hw, GWL_EXSTYLE);
        let tool = WS_EX_TOOLWINDOW.0 as isize;
        if ex & tool == 0 {
            SetWindowLongPtrW(hw, GWL_EXSTYLE, ex | tool);
            let _ = SetWindowPos(hw, None, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
    }
}

/// 前台窗口是否盖满整块显示器（全屏应用）：为真时收起浮层并暂停桌宠，退出后恢复。
/// 桌面 / 任务栏 / 本进程窗口不算；普通最大化窗口留着任务栏，自然不满足。
pub fn foreground_fullscreen() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if HWND::is_invalid(&fg) { return false; }
        let root = GetAncestor(fg, GA_ROOT);
        let root = if HWND::is_invalid(&root) { fg } else { root };
        if matches!(class_of(root).as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") { return false; }
        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(root, Some(&mut pid));
        if pid == GetCurrentProcessId() { return false; }
        let mut rect = RECT::default();
        if GetWindowRect(root, &mut rect).is_err() { return false; }
        let mon = MonitorFromWindow(root, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO::default();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if !GetMonitorInfoW(mon, &mut mi).as_bool() { return false; }
        let m = mi.rcMonitor;
        let tol = 2;
        rect.left <= m.left + tol && rect.top <= m.top + tol
            && rect.right >= m.right - tol && rect.bottom >= m.bottom - tol
    }
}

// 重型窗口生命周期：关闭/隐藏时先停用输入拦截并 hide() WebView，进入宽限期；
// 宽限期内若被重新需要（全屏退出 / 托盘恢复 / 右键菜单），复活直接复用同一 WebView，
// 免去重建 + 重新加载前端 + 重新解码视频的开销与首帧闪现。宽限期满仍无人需要才
// detach 原生附着并真正 destroy，释放内存。
// detach/attach 走独立线程，避免插件 run_on_main_thread+recv 在主线程自锁。
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

/// 关闭后保留 WebView 的宽限期：这段时间内复活直接复用，期满才真正销毁。
const DESTROY_GRACE: Duration = Duration::from_secs(3);

/// 启动离屏坐标：tao 在 Windows 建原生窗时首帧会以初始坐标绘一帧带边框窗口，
/// 多窗并行创建即"多框连闪"。初始坐标放到虚拟桌面外让首帧落在屏幕外，各窗 show 前再归位
/// （浮层 sync_windows / 主窗 show_settings）。
pub const OFFSCREEN: (f64, f64) = (-30000.0, -30000.0);
/// 归位判定：离屏阈值（比 OFFSCREEN 绝对值小一档即可）。
pub const OFFSCREEN_EDGE: i32 = -20000;

/// 每个窗口的销毁序号：每次「请求延迟销毁」递增，线程唤醒时比对，序号变化说明已被复活，
/// 放弃本次销毁。用序号而非 bool 是为了让「隐藏→复活→再隐藏」的多轮交错不会误销毁。
static DESTROY_SEQ: OnceLock<Mutex<HashMap<&'static str, u64>>> = OnceLock::new();
fn seqs() -> &'static Mutex<HashMap<&'static str, u64>> {
    DESTROY_SEQ.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 纯逻辑：递增序号，返回新值。独立出来便于无 GUI 单测。
fn bump(map: &mut HashMap<&'static str, u64>, label: &'static str) -> u64 {
    let n = map.entry(label).or_insert(0);
    *n = n.wrapping_add(1);
    *n
}

/// 纯逻辑：序号是否仍然有效（未被后续复活打断）。
fn is_current(map: &HashMap<&'static str, u64>, label: &'static str, seq: u64) -> bool {
    map.get(label).copied() == Some(seq)
}

/// 取消某窗口所有在途的延迟销毁（复活时调用）。
pub fn cancel_destroy(label: &'static str) {
    if let Ok(mut m) = seqs().lock() { bump(&mut m, label); }
}

/// 停用输入拦截伴生状态：隐藏时立即做，避免隐藏窗继续吃桌面点击。
#[cfg(windows)]
fn suspend_input(label: &'static str) {
    match label {
        "overlay" => crate::overlay_hit::set_visible(false),
        _ => {}
    }
}
#[cfg(not(windows))]
fn suspend_input(_label: &'static str) {}

/// 恢复输入拦截伴生状态（宽限期内复活时做）。
/// overlay 恒恢复可见（命中窗 enabled 由 sync_windows 末尾统一裁决）。
#[cfg(windows)]
fn resume_input(label: &'static str) {
    match label {
        "overlay" => crate::overlay_hit::set_visible(true),
        _ => {}
    }
}
#[cfg(not(windows))]
fn resume_input(_label: &'static str) {}

/// 请求延迟销毁：停用输入拦截 + 隐藏 WebView + 排一个宽限期后的真销毁任务。
/// 宽限期内任何 cancel_destroy（复活）都会让该任务作废。
pub fn destroy(app: &AppHandle, label: &'static str) {
    suspend_input(label);
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.hide();
    }
    let seq = match seqs().lock() {
        Ok(mut m) => bump(&mut m, label),
        Err(e) => bump(&mut e.into_inner(), label),
    };
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DESTROY_GRACE);
        let still = seqs().lock().map(|m| is_current(&m, label, seq)).unwrap_or(false);
        if still {
            destroy_now(&a, label);
        }
    });
}

/// 宽限期内复活：取消在途销毁 + 显示 WebView + 恢复输入拦截状态。
/// 返回是否复用了仍存在的窗口（false 表示窗口已真销毁，调用方需走重建链路）。
pub fn revive(app: &AppHandle, label: &'static str) -> bool {
    cancel_destroy(label);
    let Some(w) = app.get_webview_window(label) else { return false };
    resume_input(label);
    if !w.is_visible().unwrap_or(false) {
        // 兜底：离屏出生的窗若 show 入口漏了归位，这里补一次到主显示器，
        // 保证不会永远停在虚拟桌面外。正常路径已被各 show 入口提前归位，此判断不触发。
        #[cfg(windows)]
        if let Ok(p) = w.outer_position() {
            if p.x < OFFSCREEN_EDGE || p.y < OFFSCREEN_EDGE {
                if let Ok(Some(m)) = app.primary_monitor() {
                    let x = m.position().x;
                    let y = m.position().y;
                    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
        }
        let _ = w.show();
    }
    true
}

/// 立即销毁并重设伴生原生状态。用于：宽限期届满、以及需要同步释放的场合。
pub fn destroy_now(app: &AppHandle, label: &'static str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.destroy();
    }
    #[cfg(windows)]
    if label == "overlay" {
        crate::overlay_hit::set_visible(false);
    }
}

/// 窗口不存在则重建（参数对齐 tauri.conf.json）。重窗显示路径在 show 前调用。
/// 开头先 cancel：万一有旧的在途销毁任务，避免它在新窗建好后醒来误删。
pub fn spawn(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(static_label) = label_of(label) {
        cancel_destroy(static_label);
    }
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }
    let b = match label {
        "overlay" => WebviewWindowBuilder::new(
            app,
            label,
            WebviewUrl::App("index.html?view=overlay".into()),
        )
        .title("overlay")
        .always_on_top(true),
        _ => return Err("未知窗口".into()),
    };
    b.transparent(true)
        .no_redirection_bitmap(true)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .visible(false)
        // 离屏出生：首帧绘制落在屏幕外，杜绝启动瞬间的带边框窗口闪现；show 前由各调用方归位。
        .position(OFFSCREEN.0, OFFSCREEN.1)
        .build()
        .map_err(|e| e.to_string())?;
    if label == "overlay" {
        // 建窗即设工作区尺寸（避开任务栏/不全屏），让 WebView 首帧 innerWidth 就正确，
        // 前端据视口落位不会被默认小窗 534x400 夹坏，也不触发 Windows 勿扰模式。
        // 此时窗口仍 visible=false 且离屏，set_size 不会闪现。
        if let (Some(w), Some((x, y, cw, ch))) = (app.get_webview_window(label), crate::commands::overlay_rect()) {
            let _ = w.set_position(PhysicalPosition::new(x, y));
            let _ = w.set_size(PhysicalSize::new(cw, ch));
            #[cfg(windows)]
            crate::overlay_hit::set_bounds(x, y, cw as i32, ch as i32);
        }
    }
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window(label) {
        if let Ok(h) = w.hwnd() {
            crate::win_input::strip_frame(h.0 as isize);
            crate::win_input::hide_from_taskbar(h.0 as isize);
        }
    }
    Ok(())
}

/// 把运行时 &str label 映射到静态 label（供序号表的 &'static str key 使用）。
fn label_of(label: &str) -> Option<&'static str> {
    match label {
        "overlay" => Some("overlay"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_bump_and_current() {
        let mut m = HashMap::new();
        let s1 = bump(&mut m, "overlay");
        assert_eq!(s1, 1);
        assert!(is_current(&m, "overlay", s1));
        // 复活：递增序号 → 旧任务作废
        let s2 = bump(&mut m, "overlay");
        assert_eq!(s2, 2);
        assert!(!is_current(&m, "overlay", s1));
        assert!(is_current(&m, "overlay", s2));
    }

    #[test]
    fn seq_rehide_after_revive_is_current_again() {
        let mut m = HashMap::new();
        let s1 = bump(&mut m, "overlay");       // 隐藏
        bump(&mut m, "overlay");                // 复活
        let s3 = bump(&mut m, "overlay");       // 再次隐藏
        assert!(!is_current(&m, "overlay", s1));
        assert!(is_current(&m, "overlay", s3));
    }

    #[test]
    fn seq_labels_are_independent() {
        let mut m = HashMap::new();
        let over = bump(&mut m, "overlay");
        let settings = bump(&mut m, "settings");
        assert_eq!(over, 1);
        assert_eq!(settings, 1);
        bump(&mut m, "overlay");
        assert!(!is_current(&m, "overlay", over));
        assert!(is_current(&m, "settings", settings));
    }

    #[test]
    fn grace_is_positive() {
        assert!(DESTROY_GRACE.as_millis() >= 500);
    }
}

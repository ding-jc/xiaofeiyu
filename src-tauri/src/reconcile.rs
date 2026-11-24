// 崩溃自愈：渲染进程被结束后 WebView2 跳到内建错误页；加载钩子当场关窗，
// 托盘左右键再做一次同步对账，按配置状态重建错误/丢失的窗口。无常驻轮询。
use crate::{commands, AppState};
use std::sync::OnceLock;
use tauri::{webview::PageLoadEvent, AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();
pub fn init(app: AppHandle) { let _ = APP.set(app); }

fn is_error(url: &str) -> bool {
    url.starts_with("chrome-error:") || url.contains("chromewebdata")
}

/// 页面加载钩子：错误页出现即关掉该窗。在独立线程销毁，避免在 webview 回调里重入。
pub fn on_page_load(label: &str, url: &str, event: PageLoadEvent) {
    if !matches!(event, PageLoadEvent::Finished) || !is_error(url) { return; }
    let Some(app) = APP.get() else { return };
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || close(&app, &label));
}

/// 关窗并清伴生原生状态，不重建（重建交给托盘对账）。
fn close(app: &AppHandle, label: &str) {
    #[cfg(windows)]
    if label == "overlay" {
        crate::overlay_hit::set_visible(false);
        crate::overlay_hit::set_enabled(false);
    }
    if let Some(w) = app.get_webview_window(label) { let _ = w.destroy(); }
}

/// 托盘交互对账：核对配置状态与窗口实际渲染，错误页/丢失即重建。
pub fn reconcile(app: &AppHandle) {
    let mut reopen_settings = false;
    for label in ["overlay", "settings"] {
        let Some(w) = app.get_webview_window(label) else { continue };
        let bad = w.url().ok().map(|u| is_error(u.as_str())).unwrap_or(false);
        if !bad { continue; }
        if label == "settings" { reopen_settings = w.is_visible().unwrap_or(false); }
        close(app, label);
    }
    let cfg = app.state::<AppState>().cfg.lock().map(|c| c.clone()).unwrap_or_default();
    commands::sync_windows_async(app, &cfg);
    // 主界面原本开着却崩了：对账可重建（左键的 open_settings 再调一次是幂等的）。
    if reopen_settings {
        let a = app.clone();
        tauri::async_runtime::spawn(async move { let _ = commands::open_settings(a, None).await; });
    }
}

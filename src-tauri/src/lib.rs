// 小肥鱼宠物：置顶透明浮层渲染所有桌宠，原生命中窗逐像素交互 + 素材包协议。
mod asset_convert;
mod asset_kit;
mod assets;
mod commands;
mod config;
mod lifecycle;
#[cfg(windows)]
mod menu_window;
mod metrics;
#[cfg(windows)]
mod overlay_hit;
mod packs;
mod paths;
mod positions;
mod reconcile;
mod store;
mod tray;
mod web_import;
#[cfg(windows)]
mod win_input;

use std::{
    sync::{atomic::Ordering, Condvar, Mutex, OnceLock, RwLock},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// 素材包扫描完成信号：setup 期间 AppState 已就绪但包列表可能为空，
/// 后台扫完再通知。get_config 不再被 packs::scan 阻塞。
pub static PACKS_READY: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();

pub struct AppState {
    pub roots: paths::Roots,
    pub cfg: Mutex<config::Config>,
    pub external: RwLock<Vec<packs::ExternalEntry>>,
    pub packs: RwLock<Vec<packs::CharacterPack>>,
    pub metrics: RwLock<metrics::Metrics>,
}

/// 网页 video-json-pet:// 深链：清单 URL 入队 → 唤起主窗口 → 通知前端弹出预览确认框。
/// 真正的下载导入由前端确认后调用 import_web_url 完成，不在后台偷偷进行。
fn handle_web_links(app: &AppHandle, links: Vec<String>) {
    let mut any = false;
    for url in links {
        if let Some(manifest) = web_import::manifest_url(&url) {
            web_import::queue_pending(manifest);
            any = true;
        }
    }
    if !any { return; }
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = commands::open_settings(h.clone(), None).await;
        // 主窗口可能是刚建的，前端 init 时会主动 take_pending；这里再 emit 一次兜底已打开的窗口。
        let _ = h.emit("import://pending", ());
    });
}

/// 静态窗已从 config 移除（避免启动时 WebView2 全屏透明窗连闪两帧）：
/// 浮层窗与主窗完全并行创建，均 hidden，由前端引擎 ready 后再显形。
fn bootstrap_layers(app: &AppHandle) {
    let c = app.state::<AppState>().cfg.lock().map(|x| x.clone()).unwrap_or_default();
    let want_overlay = c.overlay_visible;
    if want_overlay {
        let h = app.clone();
        let _ = crate::lifecycle::spawn(&h, "overlay");
    }
}

/// 前台全屏检测：全屏应用（游戏 / 视频 / 演示）覆盖整块显示器时通知前端休眠整个桌宠层，
/// 并收起置顶浮层（否则它会盖在全屏应用上）；退出全屏再恢复。只在状态变化时广播。
fn fullscreen_watch(h: AppHandle) {
    thread::spawn(move || {
        let mut last = false;
        loop {
            thread::sleep(Duration::from_millis(1200));
            #[cfg(windows)]
            let on = crate::win_input::foreground_fullscreen();
            #[cfg(not(windows))]
            let on = false;
            if on == last { continue; }
            last = on;
            commands::FULLSCREEN.store(on, Ordering::Relaxed);
            let c = h.state::<AppState>().cfg.lock().map(|x| x.clone()).unwrap_or_default();
            commands::sync_windows_async(&h, &c);
            let _ = h.emit("pet://fullscreen", serde_json::json!({ "on": on }));
        }
    });
}

pub fn run() {
    // 卸载辅助入口：`app.exe --unregister-protocol` 清理 HKCU 协议注册后立即退出，
    // 不初始化任何 GUI。NSIS 卸载器与免安装版卸载说明都调用它。
    if std::env::args().skip(1).any(|a| web_import::is_unregister_flag(&a)) {
        web_import::unregister_protocol();
        return;
    }
    tauri::Builder::default()
        // 单实例：第二个进程启动时直接把已有实例的主窗口拉起来（延迟销毁后可能不存在，open_settings 会重建）。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let links: Vec<String> = args.iter().filter(|a| web_import::is_deep_link(a)).cloned().collect();
            if !links.is_empty() {
                handle_web_links(app, links);
                return;
            }
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = commands::open_settings(h, None).await;
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // 开机自启的注册表项带这个标记；setup 据此判断本次是否自启，决定要不要弹主界面。
            Some(vec!["--from-autostart"]),
        ))
        // 渲染进程崩溃 → WebView2 跳到 chrome-error 错误页；加载钩子当场关掉该窗，
        // 重建交给托盘交互的对账，避免错误页一直盖在屏幕上。
        .on_page_load(|webview, payload| {
            reconcile::on_page_load(webview.label(), payload.url().as_str(), payload.event());
        })
        .register_asynchronous_uri_scheme_protocol("pet", |ctx, req, responder| {
            assets::handle(ctx.app_handle(), req, responder)
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::save_pet_positions,
            commands::get_data,
            commands::set_data,
            commands::list_slots,
            commands::save_slot,
            commands::delete_slot,
            commands::set_metrics,
            commands::notify,
            commands::run_program,
            commands::list_packs,
            commands::import_pack,
            commands::import_web_url,
            commands::take_pending_imports,
            commands::preview_import,
            commands::convert_import,
            commands::export_dsh_zip,
            commands::write_dsh_pet,
            commands::preview_dsh_write,
            commands::remove_pack,
            commands::open_settings,
            commands::settings_ready,
            commands::open_todo,
            commands::broadcast,
            commands::get_monitors,
            commands::set_overlay_hit_mask,
            commands::set_overlay_dragging,
            commands::overlay_ready,
            commands::set_hidden,
            commands::quit,
            commands::open_url,
            commands::reset_config,
            commands::show_data_dir,
            commands::work_area,
            #[cfg(windows)]
            menu_window::native_menu_show,
            #[cfg(windows)]
            menu_window::native_tray_menu_show,
            #[cfg(windows)]
            menu_window::menu_pending,
            #[cfg(windows)]
            menu_window::menu_layout,
            #[cfg(windows)]
            menu_window::menu_pick,
            #[cfg(windows)]
            menu_window::menu_cancel,
        ])
        .setup(|app| {
            let roots = paths::detect(app.handle());
            let mut cfg = config::load(&roots.data);
            // 首次运行把老 config.json 里的坐标抽成独立 positions.json，之后它不存坐标。
            positions::migrate_from_config(&roots.data, &cfg);
            // 从 positions.json 读回权威坐标覆盖到内存 cfg，供各层 WebView 启动落位。
            let saved = positions::load(&roots.data);
            positions::apply(&saved, &mut cfg);
            let external = packs::load_external(&roots);
            let m = metrics::Metrics::start(app.handle().clone());
            // AppState 先用空包列表立即就绪：setup 里同步扫 196 段视频会拖慢状态注册，
            // 前端首轮 IPC 全部超时重试（boot.ts 1.2s×N）才见到界面。扫描挪到后台线程。
            app.manage(AppState {
                roots: roots.clone(),
                cfg: Mutex::new(cfg),
                external: RwLock::new(external.clone()),
                packs: RwLock::new(Vec::new()),
                metrics: RwLock::new(m),
            });
            PACKS_READY.get_or_init(|| (Mutex::new(false), Condvar::new()));
            web_import::register_protocol();
            // 深链队列落盘：先加载上次未确认的清单，再并入本次命令行带来的深链。
            web_import::init_pending_file(&roots.data);
            web_import::load_pending();
            let links: Vec<String> = std::env::args().filter(|a| web_import::is_deep_link(a)).collect();
            let from_web_link = !links.is_empty();
            if from_web_link { handle_web_links(app.handle(), links); }
            let bg = app.handle().clone();
            thread::spawn(move || {
                let list = packs::scan(&roots, &external);
                if let Some(st) = bg.try_state::<AppState>() {
                    if let Ok(mut p) = st.packs.write() { *p = list; }
                }
                if let Some((lock, cv)) = PACKS_READY.get() {
                    if let Ok(mut done) = lock.lock() { *done = true; }
                    cv.notify_all();
                }
            });
            tray::build(app.handle())?;
            reconcile::init(app.handle().clone());
            #[cfg(windows)] {
                // 窗全部运行时创建：建窗处（lifecycle::spawn）已统一剥边框 / 隐藏缩略图。
                overlay_hit::init(app.handle().clone());
                overlay_hit::start();
            }

            fullscreen_watch(app.handle().clone());

            // 存量用户的自启项是老版本注册的、不带参数标记；用当前 args 重写一次，
            // 这样升级后自启也会带 --from-autostart，下次开机就不会误弹主界面。
            {
                use tauri_plugin_autostart::ManagerExt;
                let a = app.autolaunch();
                if a.is_enabled().unwrap_or(false) { let _ = a.enable(); }
            }

            // 全部并行启动（用户要求）：主窗 / 浮层各自独立创建，互不等待。
            // 开机自启跳过主窗；深链启动时 handle_web_links 已异步开主窗，这里不重复。
            let from_autostart = std::env::args().any(|a| a == "--from-autostart");
            if !from_autostart && !from_web_link {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = commands::open_settings(h, None).await;
                });
            }
            // 桌宠浮层独立线程启动，与主窗互不等待。
            {
                let h = app.handle().clone();
                thread::spawn(move || {
                    bootstrap_layers(&h);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if window.label() == "overlay" {
                // tao 在 show / always_on_top / resize 时会重设样式，把被 DWM 隐藏的边框位加回来。
                // 每次窗口事件都幂等剥一遍，保证合成失效的 Win10 上也不露经典边框。
                if matches!(event, WindowEvent::Resized(_) | WindowEvent::Focused(_)) {
                    if let Ok(h) = window.hwnd() { win_input::strip_frame(h.0 as isize); }
                }
            }
            #[cfg(windows)]
            if window.label() == "menu" {
                // 菜单窗恰好等于面板尺寸，失焦就是点了别处；被销毁（Alt+F4、渲染进程
                // 出错被对账关掉）也一样要放行等待中的调用方。
                if matches!(event, WindowEvent::Focused(false) | WindowEvent::Destroyed) {
                    menu_window::cancel(&window.app_handle());
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {                // 关窗即保存：坐标只防抖写盘，关窗/退出时强制把内存坐标刷到磁盘。
                commands::flush_positions(&window.app_handle());
                // 重型窗点 X 走延迟销毁：先隐藏，宽限期内再打开直接复用同一 WebView，
                // 期满才 detach 原生附着并真销毁。settings 是普通应用窗，保持默认关闭即销毁。
                match window.label() {
                    "overlay" => {
                        crate::lifecycle::destroy(&window.app_handle(), "overlay");
                        api.prevent_close();
                    }
                    // settings / todo 不 prevent_close，默认关闭即销毁。
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run xiaofeiyu");
}

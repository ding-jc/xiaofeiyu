// 系统托盘：左键开主界面，右键弹系统原生菜单（Win32 popup menu）。
// 菜单项按当前配置实时生成，开关类项用 √ 勾选态表示；与设置实时同步。
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};
use tauri_plugin_autostart::ManagerExt;

/// 菜单项：id 与 commands::handle_menu 分支对应；checked 决定是否画 √。
fn item(id: &str, label: &str, icon: &str, checked: bool) -> serde_json::Value {
    serde_json::json!({
        "id": id, "type": "action", "label": label, "icon": icon,
        "checked": checked, "checkIcon": "check",
    })
}

fn build_items(app: &AppHandle) -> serde_json::Value {
    let hidden = crate::commands::is_hidden();
    let (through, quiet) = app.state::<crate::AppState>().cfg.lock()
        .map(|c| (c.overlay_mouse_through, c.quiet_until > now()))
        .unwrap_or((false, false));
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    serde_json::json!([
        item("tray.show", if hidden { "显示桌宠" } else { "隐藏桌宠" }, "hide", !hidden),
        item("tray.through", "鼠标穿透", "pin", through),
        item("tray.quiet", "免打扰", "pause", quiet),
        { "id": "", "type": "separator", "label": "" },
        item("tray.autostart", "开机自启", "autostart", autostart),
        item("tray.todo", "待办提醒", "todo", false),
        { "id": "", "type": "separator", "label": "" },
        item("tray.quit", "退出", "exit", false),
    ])
}

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let handle = app.clone();
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("小肥鱼宠物")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |_tray, ev| match ev {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                // 先对账：崩溃窗口当场关掉、丢失的层按配置重建，再开主界面。
                let h = handle.clone();
                crate::reconcile::reconcile(&h);
                // open_settings 是 async：必须 spawn 执行，直接调用只会构造 Future 并丢弃。
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::open_settings(h, None).await;
                });
            }
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } => {
                // 右键先对账，保证弹菜单时桌宠层健康。
                crate::reconcile::reconcile(&handle);
                let scale = handle.primary_monitor().ok().flatten()
                    .map(|m| m.scale_factor()).unwrap_or(1.0);
                let p = rect.position.to_physical::<i32>(scale);
                let items = build_items(&handle);
                let h = handle.clone();
                // 系统原生菜单：弹在托盘图标上方，点击后直接按 id 分发动作。
                // native_tray_menu_show 内部模态等点击，必须 spawn 异步执行。
                #[cfg(windows)]
                tauri::async_runtime::spawn(async move {
                    if let Ok(Some(id)) = crate::menu_window::native_tray_menu_show(
                        h.clone(), items, p.x, p.y, Some(scale),
                    ).await {
                        crate::commands::handle_menu(&h, &id);
                    }
                });
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// 保留 Wry 泛型约束占位，避免 tauri 版本差异下 tray builder 类型推断歧义。
#[allow(dead_code)]
type _TrayBack = Wry;

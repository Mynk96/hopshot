//! Hopshot desktop core.
//!
//! Rust owns the logic; the React UI is thin (CLAUDE.md rule 3). The module tree mirrors
//! ARCHITECTURE §3 — most modules are placeholders until their phase in BUILD_PLAN.md.
//!
//! This file owns app setup, plugins, the tray menu and the activation policy
//! (ARCHITECTURE §3 layout).

pub mod capture;
pub mod clipboard;
pub mod cloud;
pub mod commands;
pub mod crypto;
pub mod hotkeys;
pub mod license;
pub mod limits;
pub mod platform;
pub mod secrets;
pub mod settings;
pub mod shelf;

use std::borrow::Cow;

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{http, AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::limits::Plan;
use crate::settings::Settings;

/// Tauri window label for the Settings window (ARCHITECTURE §5.1).
const SETTINGS_WINDOW: &str = "settings";

/// Tray menu item ids. They are matched in [`on_menu_event`], so they live next to it.
mod menu_id {
    pub const CAPTURE_AREA: &str = "capture_area";
    pub const CAPTURE_SCREEN: &str = "capture_screen";
    pub const SHOW_SHELF: &str = "show_shelf";
    pub const SEND_LAST: &str = "send_last";
    pub const PAIR_PHONE: &str = "pair_phone";
    pub const SETTINGS: &str = "settings";
    pub const BUY: &str = "buy";
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered, per the plugin's own documentation.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Launching Hopshot again is how people ask for the shelf when they've
            // forgotten the hotkey.
            log::info!("a second instance was launched; showing the shelf");
            shelf::show(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            // Hopshot is a tray app: starting it with the login session is the point, and
            // it opens no window, so there is nothing to suppress on launch.
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(hotkeys::Conflicts::default())
        .manage(capture::frames::FrozenFrames::default())
        .register_uri_scheme_protocol("frame", serve_frame)
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_settings,
            commands::start_capture,
            commands::overlay_pending,
            commands::overlay_commit,
            commands::overlay_commit_full,
            commands::overlay_cancel,
            commands::permissions_status,
            commands::permissions_open_settings,
            commands::show_shelf,
            commands::hide_shelf,
            commands::resize_shelf,
            commands::shelf_has_vibrancy,
            commands::list_items,
            commands::delete_item,
            commands::pin_item,
            commands::copy_item,
            commands::prepare_drag,
            commands::drag_finished,
            commands::save_item_as,
            commands::reveal_item,
            commands::send_drop,
            commands::delete_drop,
            commands::plan_state,
            commands::license_status,
            commands::license_buy,
            commands::license_move_here,
            commands::license_remove_computer,
            commands::paired_phones,
            commands::send_to_phones,
            commands::set_shelf_wide,
            commands::vault_status,
            commands::pair_phone,
            commands::list_devices,
            commands::revoke_device,
            commands::delete_cloud_data,
            commands::get_launch_at_login,
            commands::set_launch_at_login,
            commands::get_plan,
            commands::open_plans,
            commands::open_settings,
        ])
        .setup(|app| {
            let handle = app.handle();

            // Before anything else: on macOS this is what keeps Hopshot out of the Dock.
            platform::apply_activation_policy(handle);

            // The shelf store comes first. Its window is declared in tauri.conf.json, so the
            // webview boots in parallel with this function and can call `list_items` before
            // setup finishes — and a command that reaches `state::<Store>()` too early takes
            // the whole process down rather than returning an error.
            if let Err(error) = shelf::setup(handle) {
                log::error!("the shelf store could not start: {error}");
            }

            let settings = settings::load(handle)?;
            hotkeys::apply(handle, &settings);
            build_tray(handle, &settings)?;
            capture::prewarm_overlays(handle);
            cloud::client::log_endpoints();
            setup_shelf(handle);

            // PRD F4.3/F4.5: reconnect to the vault so items from a paired phone arrive
            // without the user doing anything. A no-op until a phone has been paired.
            cloud::live::ensure_running(handle);

            /*
             * PRD F8.1: the trial starts on first launch and is recorded server-side, so a
             * reinstall cannot mint a fresh one. On a thread because it is a network call and
             * nothing in setup may block on one.
             */
            let trial_handle = handle.clone();
            std::thread::spawn(move || license::refresh_trial(&trial_handle));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hopshot");
}

/// Prepare the shelf window before it is ever shown.
///
/// On macOS the window has to become an `NSPanel` while it is still hidden — converting a
/// visible window drops it — which is why this runs at setup rather than on first show.
fn setup_shelf<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(shelf::SHELF_WINDOW) else {
        log::error!("the shelf window is missing from tauri.conf.json");
        return;
    };

    #[cfg(target_os = "macos")]
    platform::make_shelf_non_activating(&window);

    // Whether the OS gave the window a real backdrop decides whether the shelf may draw
    // itself as glass at all (DESIGN §7). The shelf webview reads this through
    // `shelf_has_vibrancy` on mount.
    app.manage(shelf::Vibrancy(platform::configure_shelf(&window)));
}

/// Serve a frozen frame to its overlay over `frame://localhost/{monitorId}`.
///
/// The bytes never touch disk: the overlay has to paint within the 300 ms budget, and a
/// 4K BMP round-tripped through the filesystem would not make it.
fn serve_frame<R: Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    let not_found = || {
        http::Response::builder()
            .status(http::StatusCode::NOT_FOUND)
            .body(Cow::Borrowed(&[][..]))
            .unwrap_or_default()
    };

    // "/3?v=7" → 3. The query is only a cache-buster.
    let monitor_id = request
        .uri()
        .path()
        .trim_start_matches('/')
        .parse::<u32>()
        .ok();

    let Some(monitor_id) = monitor_id else {
        log::warn!("frame:// request with no monitor id: {}", request.uri());
        return not_found();
    };

    let Some(bytes) = ctx
        .app_handle()
        .state::<capture::frames::FrozenFrames>()
        .display_bytes(monitor_id)
    else {
        // Normal if the overlay repaints after a cancel; the frames are already dropped.
        log::debug!("frame:// asked for monitor {monitor_id}, which is no longer frozen");
        return not_found();
    };

    http::Response::builder()
        .header(http::header::CONTENT_TYPE, "image/bmp")
        // The nonce makes each URL unique, so caching would only waste memory.
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| not_found())
}

/// Build the menu-bar / tray item and its menu (DESIGN S1).
///
/// The accelerators shown next to the items come from the live settings, so a custom
/// hotkey is reflected in the menu rather than the menu lying about ⌘⇧2.
fn build_tray<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> tauri::Result<()> {
    let menu = build_menu(app, settings, license::current_plan(app))?;

    let mut tray = TrayIconBuilder::with_id("hopshot")
        .tooltip("Hopshot")
        .menu(&menu)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if !platform::SHOW_SHELF_ON_LEFT_CLICK {
                return;
            }
            // Only react to a completed left click, not to every move and press.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                shelf::show(tray.app_handle());
            }
        });

    // The bundled app icon stands in until there is a real monochrome template asset
    // (DESIGN S1 asks for one on macOS).
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    let tray = tray.build(app)?;
    platform::configure_tray(&tray);

    Ok(())
}

/// The menu from DESIGN S1. `plan` decides the two conditional rows.
fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Settings,
    plan: Plan,
) -> tauri::Result<Menu<R>> {
    let capture_area = MenuItem::with_id(
        app,
        menu_id::CAPTURE_AREA,
        "Capture area",
        true,
        Some(settings.capture_hotkey.as_str()),
    )?;
    let capture_screen = MenuItem::with_id(
        app,
        menu_id::CAPTURE_SCREEN,
        "Capture full screen",
        true,
        settings.full_screen_hotkey.as_deref(),
    )?;
    let show_shelf = MenuItem::with_id(
        app,
        menu_id::SHOW_SHELF,
        "Show shelf",
        true,
        Some(settings.shelf_hotkey.as_str()),
    )?;
    let send_last = MenuItem::with_id(
        app,
        menu_id::SEND_LAST,
        "Send last to phone",
        true,
        None::<&str>,
    )?;

    // DESIGN S1 marks this row with a SYNC badge when the plan doesn't include sync. A
    // native menu has nowhere to put a badge, so the label carries it.
    let pair_label = if plan.includes_sync() {
        "Pair phone…"
    } else {
        "Pair phone… (Sync)"
    };
    let pair_phone = MenuItem::with_id(app, menu_id::PAIR_PHONE, pair_label, true, None::<&str>)?;

    let settings_item = MenuItem::with_id(
        app,
        menu_id::SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    let separator = PredefinedMenuItem::separator(app)?;
    // A predefined Quit keeps the native ⌘Q behaviour on macOS.
    let quit = PredefinedMenuItem::quit(app, Some("Quit Hopshot"))?;

    let menu = Menu::new(app)?;
    menu.append_items(&[
        &capture_area,
        &capture_screen,
        &show_shelf,
        &send_last,
        &separator,
        &pair_phone,
        &settings_item,
    ])?;

    // Prices are the PRD §7 list prices. Launch pricing is decided server-side, so this
    // label moves to the plan payload in Phase 4 rather than growing more constants here.
    match plan {
        Plan::Trial | Plan::Expired => {
            let buy = MenuItem::with_id(
                app,
                menu_id::BUY,
                "Buy Hopshot — $19",
                true,
                None::<&str>,
            )?;
            menu.append(&buy)?;
        }
        Plan::Lifetime => {
            let add_sync = MenuItem::with_id(
                app,
                menu_id::BUY,
                "Add Sync — $24/yr",
                true,
                None::<&str>,
            )?;
            menu.append(&add_sync)?;
        }
        // Nothing left to sell.
        Plan::Sync => {}
    }

    menu.append_items(&[&separator, &quit])?;
    Ok(menu)
}

/// Tray menu items are wired straight to the owning modules, exactly like the commands in
/// `commands.rs`, so the menu and the UI can never drift apart.
fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        menu_id::CAPTURE_AREA => capture::start(app, capture::Mode::Region),
        menu_id::CAPTURE_SCREEN => capture::start(app, capture::Mode::Screen),
        menu_id::SHOW_SHELF => shelf::show(app),
        menu_id::SEND_LAST => shelf::send_last_to_phone(app),
        menu_id::PAIR_PHONE => {
            // Settings -> Devices is where pairing lives (DESIGN S7); the tray item is a
            // shortcut to it. It used to call a stub that only wrote a log line, so the
            // menu item appeared to do nothing at all.
            if let Err(error) = show_settings_window(app) {
                log::error!("could not open Settings to pair: {error}");
            }
            let _ = app.emit("settings:tab", "devices");
        }
        menu_id::BUY => license::open_checkout(app, license::current_plan(app)),
        menu_id::SETTINGS => {
            if let Err(error) = show_settings_window(app) {
                log::error!("could not open Settings: {error}");
            }
        }
        other => log::warn!("unhandled tray menu id: {other}"),
    }
}

/// Show and focus the Settings window (ARCHITECTURE §5.1: the one normal window).
///
/// It is declared hidden in `tauri.conf.json` and created at startup, so this only has to
/// reveal it. On macOS an accessory app still has to be activated explicitly for the window
/// to come to the front.
pub fn show_settings_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(SETTINGS_WINDOW) else {
        log::error!("the {SETTINGS_WINDOW} window is missing from tauri.conf.json");
        return Ok(());
    };
    reveal(&window)
}

fn reveal<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    window.show()?;
    window.unminimize()?;
    window.set_focus()?;
    Ok(())
}

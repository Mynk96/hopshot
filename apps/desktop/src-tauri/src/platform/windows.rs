//! Windows: WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW on the shelf, per-monitor DPI handling
//! (CLAUDE.md "Known platform gotchas").
//!
//! Phase 1.2 covers the capture overlay; the shelf window styles arrive in Phase 1.3.

use tauri::image::Image;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Runtime, WebviewWindow};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use crate::capture::permissions::ScreenAccess;

/// Windows tray convention: a left click runs the primary action and a right click opens
/// the menu. For Hopshot the primary action is showing the shelf.
pub const SHOW_SHELF_ON_LEFT_CLICK: bool = true;

/// Windows has no activation-policy equivalent. Hopshot stays out of the taskbar simply by
/// opening no window at startup; the Settings window is the only one that gets a button
/// (ARCHITECTURE §5.1).
pub fn apply_activation_policy<R: Runtime>(_app: &AppHandle<R>) {}

/// The tray takes the full-colour app icon on Windows (DESIGN S1).
pub fn tray_icon<R: Runtime>(app: &AppHandle<R>) -> Option<Image<'static>> {
    app.default_window_icon().cloned()
}

/// Keep the menu on right click so the left click stays free for the shelf.
pub fn configure_tray<R: Runtime>(tray: &TrayIcon<R>) {
    if let Err(error) = tray.set_show_menu_on_left_click(false) {
        log::warn!("could not reserve the left click for the shelf: {error}");
    }
}

/// WS_EX_TOOLWINDOW, always-on-top, no taskbar entry.
///
/// Tauri's `skip_taskbar(true)` hides the window through `ITaskbarList::DeleteTab` and
/// leaves the extended style alone — verified by reading `GWL_EXSTYLE` off a live overlay,
/// which came back without `WS_EX_TOOLWINDOW`. The style matters beyond the taskbar: it
/// also keeps the overlay out of the Alt-Tab list, which a full-screen capture surface has
/// no business appearing in. So it is set explicitly here.
pub fn configure_overlay<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(error) = window.set_always_on_top(true) {
        log::warn!("overlay could not stay on top: {error}");
    }
    add_ex_style(window, WS_EX_TOOLWINDOW, "WS_EX_TOOLWINDOW");
}

/// OR extra bits into a window's extended style and make them take effect.
fn add_ex_style<R: Runtime>(window: &WebviewWindow<R>, bits: u32, what: &str) {
    let Ok(handle) = window.hwnd() else {
        log::warn!("{}: no HWND yet, {what} not applied", window.label());
        return;
    };

    // SAFETY: `handle` is a live top-level window owned by this process; these calls read
    // and write its extended style word and then ask the frame to be recalculated.
    unsafe {
        // windows-sys models HWND as a raw pointer, not a newtype.
        let hwnd: HWND = handle.0 as HWND;
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = current | (bits as isize);

        if current != wanted {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted);
            // A style word written with SetWindowLongPtrW is not live until the frame is
            // recalculated; without this the change reads back as if it never happened.
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }

        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & (bits as isize) != (bits as isize) {
            log::warn!(
                "{}: {what} did not stick (ex-style {current:#x})",
                window.label()
            );
        }
    }
}

/// Bring the overlay to the front as it is shown. On Windows a topmost window is already
/// above everything except other topmost windows, so showing it is enough.
pub fn raise_overlay<R: Runtime>(_window: &WebviewWindow<R>) {}

/// The shelf must never take focus from the app the user is capturing into (PRD F2.1).
///
/// `WS_EX_NOACTIVATE` is what makes clicking the shelf leave the browser focused;
/// `WS_EX_TOOLWINDOW` keeps it out of the taskbar and Alt-Tab.
pub fn configure_shelf<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    add_ex_style(
        window,
        WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
        "WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW",
    );

    // DESIGN S3 wants a translucent panel. Acrylic is Windows 11; on Windows 10 the same
    // call either no-ops or looks wrong, so the UI falls back to an opaque surface there.
    //
    // The return value is what makes that fallback real. The window is `transparent: true`,
    // so if no backdrop is applied the panel's `rgba(24,24,28,.78)` composites straight onto
    // the user's wallpaper and `backdrop-filter` cannot help — Chromium samples only the
    // backdrop inside the page, never the desktop behind the window. The shelf asks for this
    // via `shelf_has_vibrancy` and switches to `--surface-solid` (DESIGN §7).
    match window_vibrancy::apply_acrylic(window, Some((24, 24, 28, 180))) {
        Ok(()) => true,
        Err(error) => {
            log::info!("acrylic unavailable ({error}); the shelf falls back to a solid surface");
            false
        }
    }
}

/// macOS needs a plugin to turn the shelf into an NSPanel. Windows gets the same behaviour
/// from window styles, so this is an empty plugin that keeps the builder chain identical.
pub fn panel_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("nspanel").build()
}

/// Show the shelf without activating it. The window style already prevents focus, so there
/// is nothing extra to do once Tauri has shown it.
pub fn raise_shelf<R: Runtime>(_window: &WebviewWindow<R>) {}

/// Windows has no screen-recording permission — any process can read the screen.
pub fn screen_access() -> ScreenAccess {
    ScreenAccess::Granted
}

/// Nothing to open: see [`screen_access`].
pub fn open_screen_settings() {}

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
    // The app hands out a borrow; `to_owned` copies the pixels so the icon can outlive it.
    app.default_window_icon().cloned().map(Image::to_owned)
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

/* ── Catch other screenshots (PRD F1.7, docs/designs/catch-screenshots.md) ── */

/// Where Win+Shift+S (Snipping Tool auto-save) and Win+PrtScn save: the Screenshots known
/// folder, which follows a moved or OneDrive-redirected folder. `KF_FLAG_DONT_VERIFY`
/// returns the path even before Windows has created the folder, and nothing here creates
/// it. Falls back to Pictures\Screenshots.
pub fn screenshot_folder() -> (std::path::PathBuf, Option<String>) {
    use windows_sys::Win32::UI::Shell::{FOLDERID_Pictures, FOLDERID_Screenshots};

    if let Some(path) = known_folder(&FOLDERID_Screenshots) {
        return (path, None);
    }
    if let Some(pictures) = known_folder(&FOLDERID_Pictures) {
        return (pictures.join("Screenshots"), None);
    }
    let fallback = std::env::var_os("USERPROFILE")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
        .join("Pictures")
        .join("Screenshots");
    (fallback, Some("Can't find your Screenshots folder.".to_string()))
}

fn known_folder(id: &windows_sys::core::GUID) -> Option<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DONT_VERIFY};

    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: `id` is a valid GUID, a null token means the current user, and `raw` receives
    // a CoTaskMemAlloc'd, NUL-terminated string that is freed below on every path.
    let hr = unsafe {
        SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY as u32, std::ptr::null_mut(), &mut raw)
    };
    let path = if hr >= 0 && !raw.is_null() {
        // SAFETY: on success `raw` points at a NUL-terminated UTF-16 string.
        let len = unsafe { (0..).take_while(|&i| *raw.add(i) != 0).count() };
        // SAFETY: `len` code units were just read from the same allocation.
        let units = unsafe { std::slice::from_raw_parts(raw, len) };
        Some(std::path::PathBuf::from(std::ffi::OsString::from_wide(units)))
    } else {
        None
    };
    // SAFETY: freeing null is allowed; otherwise this is the allocation the call returned.
    unsafe { CoTaskMemFree(raw as *const core::ffi::c_void) };
    path
}

/// Everything saved into the Screenshots folder is a screenshot; Windows has no flag.
pub fn is_os_screenshot(_path: &std::path::Path) -> bool {
    true
}

/// Nothing to wait for on Windows.
pub const SCREENSHOT_FLAG_MAY_LAG: bool = false;

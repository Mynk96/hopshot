//! macOS: ActivationPolicy::Accessory, NSPanel shelf, NSScreenSaverWindowLevel overlay,
//! CGPreflightScreenCaptureAccess (CLAUDE.md "Known platform gotchas").

use std::process::Command;

use core_graphics::access::ScreenCaptureAccess;
use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
use tauri::image::Image;
use tauri::tray::TrayIcon;
use tauri::{ActivationPolicy, AppHandle, Runtime, WebviewWindow};

use crate::capture::permissions::ScreenAccess;

/// A left click on a status-bar item opens its menu — that is the macOS convention, and
/// there is no other way to reach the menu from a trackpad without a secondary click.
pub const SHOW_SHELF_ON_LEFT_CLICK: bool = false;

/// `NSScreenSaverWindowLevel`. AppKit derives it from `CGWindowLevelForKey`, which objc2
/// does not re-export as a constant, so the value is spelled out: it is the documented
/// level that sits above the menu bar and the Dock.
const NS_SCREEN_SAVER_WINDOW_LEVEL: isize = 1000;

/// `NSFloatingWindowLevel` — above normal windows, nowhere near the overlay.
const NS_FLOATING_WINDOW_LEVEL: isize = 3;

/// Hopshot lives in the menu bar, so it has no Dock icon and no app menu of its own
/// (ARCHITECTURE §5.1).
pub fn apply_activation_policy<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.set_activation_policy(ActivationPolicy::Accessory) {
        // Worth saying out loud: the app still works, it just grew a Dock icon.
        log::error!("could not switch to the accessory activation policy: {error}");
    }
}

/// A monochrome template image for the menu bar (DESIGN S1). The coloured app icon cannot be
/// used here: marked as a template, macOS keeps only its alpha channel, and an opaque square
/// icon becomes a solid white block.
pub fn tray_icon<R: Runtime>(_app: &AppHandle<R>) -> Option<Image<'static>> {
    match Image::from_bytes(include_bytes!("../../icons/tray-template.png")) {
        Ok(icon) => Some(icon),
        Err(error) => {
            log::warn!("the menu-bar template icon would not load: {error}");
            None
        }
    }
}

/// Template images let macOS tint the icon for light and dark menu bars and invert it while
/// the menu is open (DESIGN S1).
pub fn configure_tray<R: Runtime>(tray: &TrayIcon<R>) {
    if let Err(error) = tray.set_icon_as_template(true) {
        log::warn!("could not mark the tray icon as a template: {error}");
    }
    if let Err(error) = tray.set_show_menu_on_left_click(true) {
        log::warn!("could not set the menu to open on left click: {error}");
    }
}

/// Raise the overlay above everything, including the menu bar and full-screen apps.
///
/// Tauri's `always_on_top` only reaches `NSFloatingWindowLevel`, which sits *below* the
/// menu bar — so a capture started over a full-screen app would come up behind it. The
/// screen-saver level plus `canJoinAllSpaces | fullScreenAuxiliary` is what makes the
/// overlay appear on whichever Space is in front (CLAUDE.md "Known platform gotchas").
pub fn configure_overlay<R: Runtime>(window: &WebviewWindow<R>) {
    with_ns_window(window, "configure", |ns_window| {
        ns_window.setLevel(NS_SCREEN_SAVER_WINDOW_LEVEL);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    });
}

/// Bring the overlay forward without activating Hopshot — an accessory app that activated
/// here would steal focus from whatever the user is capturing.
pub fn raise_overlay<R: Runtime>(window: &WebviewWindow<R>) {
    with_ns_window(window, "raise", |ns_window| {
        ns_window.orderFrontRegardless();
    });
}

/// Run an AppKit mutation against the window's `NSWindow`, on the main thread.
///
/// AppKit is not thread-safe and captures are triggered from a global-shortcut callback,
/// which is not the main thread — so every call hops across first.
fn with_ns_window<R: Runtime>(
    window: &WebviewWindow<R>,
    what: &'static str,
    f: impl FnOnce(&NSWindow) + Send + 'static,
) {
    let window = window.clone();
    let label = window.label().to_string();

    let dispatched = window.clone().run_on_main_thread(move || {
        match window.ns_window() {
            Ok(ptr) if !ptr.is_null() => {
                // SAFETY: Tauri hands back the window's live NSWindow, and this closure runs
                // on the main thread, which is where AppKit requires it to be used. The
                // reference does not outlive the closure.
                let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
                f(ns_window);
            }
            Ok(_) => log::warn!("{label}: ns_window() was null, cannot {what} the overlay"),
            Err(error) => log::warn!("{label}: ns_window() failed, cannot {what}: {error}"),
        }
    });

    if let Err(error) = dispatched {
        log::warn!("could not reach the main thread to {what} the overlay: {error}");
    }
}

/// The shelf must never take focus from the app the user is dragging into (PRD F2.1).
///
/// Only an `NSPanel` can be non-activating — `NSWindowStyleMaskNonactivatingPanel` is
/// rejected on a plain `NSWindow`, and `NSWindow` has no other way to refuse key status
/// without subclassing. `tauri-nspanel` converts the window in place (CLAUDE.md "macOS
/// shelf must not steal focus").
///
/// Returns whether the OS actually gave the window a backdrop. See the Windows twin for why
/// the caller needs to know (DESIGN §7: fall back to `--surface-solid`). On macOS this is
/// also the "Reduce transparency" case.
pub fn configure_shelf<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    // DESIGN S3: a translucent HUD panel.
    let vibrancy = match window_vibrancy::apply_vibrancy(
        window,
        window_vibrancy::NSVisualEffectMaterial::HudWindow,
        None,
        None,
    ) {
        Ok(()) => true,
        Err(error) => {
            log::info!("vibrancy unavailable ({error}); the shelf falls back to a solid surface");
            false
        }
    };

    with_ns_window(window, "configure the shelf", |ns_window| {
        // Visible on every Space, and alongside — not behind — a full-screen app.
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        // Above normal windows but far below the capture overlay.
        ns_window.setLevel(NS_FLOATING_WINDOW_LEVEL);
    });

    vibrancy
}

// The shelf's panel class. It may become key — clicking a card should let ↑/↓, Enter and
// Esc reach it (DESIGN §7) — but never main, and the non-activating style mask below means
// becoming key does not activate Hopshot or take the front app's focus away.
//
// In a module of its own because the macro brings its own `use` lines (NSWindow and
// friends), which would collide with this file's imports.
mod shelf_panel {
    tauri_nspanel::tauri_panel! {
        panel!(ShelfPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })
    }
}
use shelf_panel::ShelfPanel;

/// Register the plugin that keeps track of converted panels. Must be added to the builder
/// before [`make_shelf_non_activating`] runs.
pub fn panel_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_nspanel::init()
}

/// Convert the shelf window into a non-activating `NSPanel`.
///
/// Separate from [`configure_shelf`] because it must happen once, at setup, before the
/// window is ever shown — converting a visible window drops it.
pub fn make_shelf_non_activating<R: Runtime>(window: &WebviewWindow<R>) {
    use tauri_nspanel::objc2_app_kit::NSWindowStyleMask;
    use tauri_nspanel::WebviewWindowExt;

    let panel = match window.to_panel::<ShelfPanel<R>>() {
        Ok(panel) => panel,
        Err(error) => {
            log::error!(
                "the shelf could not become an NSPanel ({error}); it will steal focus on click"
            );
            return;
        }
    };

    // NSWindowStyleMaskNonactivatingPanel. Clicking the shelf now routes events to it
    // without making Hopshot the active app, so the browser keeps focus. Added to, not
    // replacing, the existing mask so Tauri's borderless/transparent setup survives.
    if let Err(error) = panel.add_style_mask(NSWindowStyleMask::NonactivatingPanel) {
        log::error!("the shelf panel refused the non-activating style ({error:?})");
    }
    // Releasing on close would free the panel behind Tauri's back.
    panel.set_released_when_closed(false);
    // A panel hides itself when its app deactivates by default — and Hopshot is never the
    // active app while the shelf is in use, so it would vanish the moment it appeared.
    panel.set_hides_on_deactivate(false);
}

/// Order the shelf forward without activating Hopshot.
pub fn raise_shelf<R: Runtime>(window: &WebviewWindow<R>) {
    with_ns_window(window, "raise the shelf", |ns_window| {
        ns_window.orderFrontRegardless();
    });
}

/// Screen Recording permission. Without it `xcap` silently returns wallpaper-only images,
/// so this is checked before the overlay opens (ARCHITECTURE §5.2).
///
/// `CGPreflightScreenCaptureAccess` cannot distinguish "denied" from "never asked"; both
/// come back `false`. Treating that as denied is the safe reading — the toast routes the
/// user to [`open_screen_settings`], which raises the system prompt on a first run.
pub fn screen_access() -> ScreenAccess {
    if ScreenCaptureAccess.preflight() {
        ScreenAccess::Granted
    } else {
        ScreenAccess::Denied
    }
}

/// Ask for the permission, then open the pane in System Settings.
///
/// `request()` raises the system prompt the first time and is a no-op afterwards, so the
/// Settings deep-link is what helps a user who has already denied it once.
pub fn open_screen_settings() {
    if ScreenCaptureAccess.request() {
        return;
    }

    let pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    if let Err(error) = Command::new("open").arg(pane).spawn() {
        log::warn!("could not open the Screen Recording settings pane: {error}");
    }
}

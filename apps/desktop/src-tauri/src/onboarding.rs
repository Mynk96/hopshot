//! First-launch onboarding (DESIGN S8, PRD US-12).
//!
//! Hopshot is a menu-bar app with no Dock icon and no window of its own, so without this a
//! fresh install shows nothing at all and reads as broken. The window walks the user through
//! the Screen Recording permission (macOS) and a first capture.
//!
//! The window is created on demand rather than declared in tauri.conf.json: a declared window
//! is destroyed by its close button and could not be shown again. Closing it counts as done,
//! the same as pressing Finish, so it never reappears on every launch.

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::settings::{self, Settings};

pub const ONBOARDING_WINDOW: &str = "onboarding";

/// DESIGN S8: 560×600.
const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 600.0;

/// Show the onboarding if this install has not finished it yet. Called once at startup.
/// Returns whether the onboarding window is now open.
pub fn show_if_needed<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> bool {
    if settings.onboarded {
        return false;
    }
    match show(app) {
        Ok(()) => true,
        Err(error) => {
            log::error!("could not open the onboarding window: {error}");
            false
        }
    }
}

/// Open the onboarding window, or bring it forward if it is already open.
pub fn show<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(ONBOARDING_WINDOW) {
        window.show()?;
        window.unminimize()?;
        return window.set_focus();
    }

    let window =
        WebviewWindowBuilder::new(app, ONBOARDING_WINDOW, WebviewUrl::App("index.html".into()))
            .title("Welcome to Hopshot")
            .inner_size(WIDTH, HEIGHT)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .center()
            .focused(true)
            .build()?;

    // The red close button is a valid way to say "I've got it"; record it like Finish.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { .. } = event {
            mark_done(&handle);
        }
    });

    window.set_focus()
}

/// The Finish button: record it and close the window.
pub fn finish<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    mark_done(app);
    if let Some(window) = app.get_webview_window(ONBOARDING_WINDOW) {
        window.close()?;
    }
    Ok(())
}

fn mark_done<R: Runtime>(app: &AppHandle<R>) {
    let mut patch = Map::new();
    patch.insert("onboarded".to_string(), Value::Bool(true));
    if let Err(error) = settings::patch(app, patch) {
        // Not fatal: the worst case is that the onboarding shows once more next launch.
        log::warn!("could not record that onboarding is done: {error}");
    }
}

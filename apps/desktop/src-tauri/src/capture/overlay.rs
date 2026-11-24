//! Per-monitor overlay windows and the `frame://` custom protocol.
//!
//! One frameless, transparent, always-on-top window per monitor (ARCHITECTURE §5.1),
//! created up front and kept hidden so a capture only has to position and show them.
//!
//! Windows are placed in **physical** pixels. ARCHITECTURE §5.2 says logical, but Tauri
//! converts a `LogicalPosition` using the scale factor of the monitor the window is
//! currently on — which, for a window that has not moved yet, is the wrong monitor in a
//! mixed-DPI setup. Physical coordinates have no such ambiguity, and the crop keeps using
//! each monitor's own scale factor either way.

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use thiserror::Error;

use crate::capture::crop::{LogicalRect, MonitorBounds};
use crate::capture::frames::{Frame, FrozenFrames};
use crate::platform;

#[derive(Debug, Error)]
pub enum OverlayError {
    #[error("the overlay window could not be opened: {0}")]
    Window(#[from] tauri::Error),
}

/// Payload of the `overlay:start` event (ARCHITECTURE §5.4).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStart {
    pub monitor_id: u32,
    /// Where the overlay should load the frozen frame from.
    pub frame_url: String,
    /// CSS px, so the UI can size its canvas without asking the window.
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    /// Highlightable windows on this monitor, front-to-back, in CSS px (PRD F1.6). Rects
    /// only: titles and app names never reach the overlay.
    pub windows: Vec<LogicalRect>,
    /// Open in window mode (tray "Capture window") rather than region mode.
    pub start_in_window_mode: bool,
}

/// `overlay-{monitorId}` — the label from ARCHITECTURE §5.1.
pub fn label_for(monitor_id: u32) -> String {
    format!("overlay-{monitor_id}")
}

/// The URL the overlay loads its frozen frame from.
///
/// Tauri serves custom schemes as `http://frame.localhost/…` on Windows and
/// `frame://localhost/…` on macOS, so the URL is built here rather than in the UI — which
/// is also why `overlay:start` carries it (ARCHITECTURE §5.4).
///
/// `nonce` busts the webview's cache; without it the second capture shows the first frame.
pub fn frame_url(monitor_id: u32, nonce: u64) -> String {
    if cfg!(target_os = "windows") {
        format!("http://frame.localhost/{monitor_id}?v={nonce}")
    } else {
        format!("frame://localhost/{monitor_id}?v={nonce}")
    }
}

/// Create any overlay window that doesn't exist yet and move them all onto their monitors.
///
/// Called at startup with whatever monitors are attached, and again before each capture so
/// that plugging in a display between captures works.
pub fn ensure_windows<R: Runtime>(
    app: &AppHandle<R>,
    monitors: &[(u32, MonitorBounds)],
) -> Result<(), OverlayError> {
    for (monitor_id, bounds) in monitors {
        let label = label_for(*monitor_id);

        let window = match app.get_webview_window(&label) {
            Some(window) => window,
            None => build_window(app, &label)?,
        };

        // Physical placement, per the module docs.
        window.set_position(PhysicalPosition::new(
            (bounds.logical_x * bounds.scale_factor).round() as i32,
            (bounds.logical_y * bounds.scale_factor).round() as i32,
        ))?;
        window.set_size(PhysicalSize::new(
            bounds.physical_width,
            bounds.physical_height,
        ))?;

        platform::configure_overlay(&window);
    }

    Ok(())
}

/// Create the overlay windows before they are needed, so a capture only has to show them
/// (ARCHITECTURE §5.1). Called once at startup.
pub fn prewarm<R: Runtime>(
    app: &AppHandle<R>,
    monitors: &[(u32, MonitorBounds)],
) -> Result<(), OverlayError> {
    ensure_windows(app, monitors)?;
    log::info!("pre-created {} overlay window(s)", monitors.len());
    Ok(())
}

/// The `(id, bounds)` pairs for a set of frozen frames.
pub fn monitors_of(frames: &[Frame]) -> Vec<(u32, MonitorBounds)> {
    frames.iter().map(|f| (f.monitor_id, f.bounds)).collect()
}

fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<WebviewWindow<R>, OverlayError> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Hopshot capture")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        // A real size is only applied in ensure_windows; this just avoids a 0x0 webview.
        .inner_size(1.0, 1.0)
        .build()?;

    Ok(window)
}

/// Build the `overlay:start` payload for one frozen monitor.
///
/// `show_all` and `capture::pending` both build it from the held frame, so an overlay that
/// missed the event gets exactly the same windows and mode.
pub fn start_payload(frame: &Frame, nonce: u64, window_mode: bool) -> OverlayStart {
    OverlayStart {
        monitor_id: frame.monitor_id,
        frame_url: frame_url(frame.monitor_id, nonce),
        width: frame.bounds.logical_width,
        height: frame.bounds.logical_height,
        scale_factor: frame.bounds.scale_factor,
        windows: frame.windows.clone(),
        start_in_window_mode: window_mode,
    }
}

/// Show every overlay and tell each one which frame to draw.
///
/// The event is emitted before `show()` so the webview has the URL in hand as it becomes
/// visible, rather than flashing an empty transparent window first.
pub fn show_all<R: Runtime>(
    app: &AppHandle<R>,
    monitors: &[(u32, MonitorBounds)],
    nonce: u64,
    window_mode: bool,
) -> Result<(), OverlayError> {
    for (monitor_id, _) in monitors {
        let label = label_for(*monitor_id);
        let Some(window) = app.get_webview_window(&label) else {
            log::warn!("{label} vanished before it could be shown");
            continue;
        };

        let Some(payload) = app
            .state::<FrozenFrames>()
            .with(*monitor_id, |frame| start_payload(frame, nonce, window_mode))
        else {
            log::warn!("{label} has no frozen frame to show");
            continue;
        };
        // `Emitter::emit` broadcasts to every webview, even when called on one window, so
        // with two monitors each overlay would keep whichever payload arrived last and draw
        // the other monitor's frame. The target has to be named. The overlay subscribes with
        // its own window label so the filter has something to match.
        if let Err(error) = app.emit_to(
            EventTarget::webview_window(&label),
            "overlay:start",
            &payload,
        ) {
            log::warn!("{label} did not receive overlay:start: {error}");
        }

        window.show()?;
        platform::raise_overlay(&window);
    }

    // Focus one overlay so Esc/F/Enter reach the UI without a click first.
    if let Some(first) = monitors
        .first()
        .and_then(|(id, _)| app.get_webview_window(&label_for(*id)))
    {
        let _ = first.set_focus();
    }

    Ok(())
}

/// Hide every overlay window. Safe to call when none are open.
pub fn hide_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            if let Err(error) = window.hide() {
                log::warn!("{label} would not hide: {error}");
            }
            // Shrink the hidden window so it can't hold a 4K-sized surface between captures.
            let _ = window.set_size(LogicalSize::new(1.0, 1.0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_with_windows(monitor_id: u32, windows: Vec<LogicalRect>) -> Frame {
        Frame {
            monitor_id,
            bounds: MonitorBounds::from_physical(0, 0, 200, 100, 2.0),
            image: image::RgbaImage::new(1, 1),
            display_bytes: Vec::new(),
            windows,
        }
    }

    /// `pending()` and `show_all` both call this, so an overlay for a freshly plugged-in
    /// monitor gets the same windows and mode as the others.
    #[test]
    fn the_payload_carries_only_this_monitor_s_windows_and_the_mode() {
        let rect = LogicalRect {
            x: 1.0,
            y: 2.0,
            width: 30.0,
            height: 40.0,
        };
        let frames = FrozenFrames::default();
        frames.replace(vec![
            frame_with_windows(1, vec![rect]),
            frame_with_windows(2, Vec::new()),
        ]);

        let one = frames
            .with(1, |frame| start_payload(frame, 9, true))
            .expect("monitor 1 is held");
        assert_eq!(one.windows, vec![rect]);
        assert!(one.start_in_window_mode);
        assert_eq!(one.width, 100.0);
        assert_eq!(one.height, 50.0);

        let two = frames
            .with(2, |frame| start_payload(frame, 9, false))
            .expect("monitor 2 is held");
        assert!(two.windows.is_empty());
        assert!(!two.start_in_window_mode);
    }

    #[test]
    fn the_payload_uses_the_overlay_s_camel_case_names() {
        let json = serde_json::to_value(start_payload(&frame_with_windows(3, Vec::new()), 1, true))
            .expect("serializes");
        assert_eq!(json["startInWindowMode"], serde_json::json!(true));
        assert!(json["windows"].is_array());
    }

    #[test]
    fn labels_match_the_architecture_scheme() {
        assert_eq!(label_for(3), "overlay-3");
    }

    #[test]
    fn frame_urls_are_cache_busted() {
        let first = frame_url(1, 7);
        let second = frame_url(1, 8);
        assert_ne!(first, second, "a stale frame would be shown otherwise");
        assert!(first.contains("/1?v=7"));
    }

    /// Windows cannot use `frame://`, so the scheme differs by platform and the UI must be
    /// told the URL rather than building it.
    #[test]
    fn the_scheme_matches_the_platform() {
        let url = frame_url(2, 1);
        if cfg!(target_os = "windows") {
            assert!(url.starts_with("http://frame.localhost/"), "{url}");
        } else {
            assert!(url.starts_with("frame://localhost/"), "{url}");
        }
    }
}

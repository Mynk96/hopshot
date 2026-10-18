//! Capture pipeline (ARCHITECTURE §5.2).
//!
//! ```text
//! hotkey ─▶ permissions check ─▶ frames::grab_all() ─▶ overlay::ensure_windows + show_all
//! drag   ─▶ overlay_commit {monitorId, rect} ─▶ crop::to_physical ─▶ Frame::crop
//!        ─▶ PNG into app-data/captures ─▶ overlay::hide_all
//! ```
//!
//! The sync upload from §5.2 lands in Phase 5; everything else in the pipeline is here.

pub mod crop;
pub mod frames;
pub mod overlay;
pub mod permissions;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use thiserror::Error;

use crate::capture::crop::LogicalRect;
use crate::capture::frames::{FrozenFrames, FrameError};
use crate::capture::overlay::OverlayError;

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error(transparent)]
    Frames(#[from] FrameError),
    #[error(transparent)]
    Overlay(#[from] OverlayError),
    #[error("the capture could not be saved: {0}")]
    Save(String),
    #[error("that monitor is no longer frozen")]
    StaleMonitor,
    #[error("nothing was selected")]
    EmptySelection,
}

/// The `mode` argument of `start_capture` (ARCHITECTURE §5.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// PRD F1.2 — drag a rectangle on the frozen overlay.
    Region,
    /// PRD F1.4 — the whole monitor under the cursor, with no overlay.
    Screen,
}

/// Bumped per capture so the webview cannot reuse the previous frame from its cache.
static FRAME_NONCE: AtomicU64 = AtomicU64::new(1);
/// The nonce of the capture currently on screen, for [`pending`].
static CURRENT_NONCE: AtomicU64 = AtomicU64::new(0);

/// Begin a capture.
///
/// Region mode freezes every monitor and opens the overlays; screen mode skips the overlay
/// entirely and saves the monitor under the cursor (PRD F1.4).
pub fn start<R: Runtime>(app: &AppHandle<R>, mode: Mode) {
    if let Err(error) = try_start(app, mode) {
        log::error!("capture failed: {error}");
        toast(app, "error", &error.to_string());
        overlay::hide_all(app);
    }
}

fn try_start<R: Runtime>(app: &AppHandle<R>, mode: Mode) -> Result<(), CaptureError> {
    // Without Screen Recording, xcap returns wallpaper-only images rather than failing, so
    // refusing up front is the only way the user learns what is actually wrong.
    let access = permissions::status();
    if !access.is_usable() {
        log::warn!("capture blocked: screen access is {access:?}");
        toast(
            app,
            "error",
            "Hopshot can't see your screen yet. Fix in one click →",
        );
        return Ok(());
    }

    let started = Instant::now();
    let frames = frames::grab_all()?;

    match mode {
        Mode::Screen => {
            let frame = frame_under_cursor(app, &frames);
            let Some(frame) = frame else {
                return Err(CaptureError::StaleMonitor);
            };
            let image = frame.crop(frame.bounds.full_frame());
            let path = save_png(app, &image)?;
            log::info!(
                "full-screen capture saved in {:.1} ms: {}",
                started.elapsed().as_secs_f64() * 1000.0,
                path.display()
            );
            deliver(app, &path, &image);
        }
        Mode::Region => {
            let monitors = overlay::monitors_of(&frames);
            overlay::ensure_windows(app, &monitors)?;

            let nonce = FRAME_NONCE.fetch_add(1, Ordering::Relaxed);
            CURRENT_NONCE.store(nonce, Ordering::Relaxed);

            // Publish the frames *before* showing. A webview that is still booting misses
            // the overlay:start event entirely, and then asks for it with `pending` — which
            // can only answer once the frames are in place.
            app.state::<FrozenFrames>().replace(frames);
            overlay::show_all(app, &monitors, nonce)?;

            log::info!(
                "hotkey → overlay visible in {:.1} ms (budget 300 ms)",
                started.elapsed().as_secs_f64() * 1000.0
            );
        }
    }

    Ok(())
}

/// The frozen frame for the monitor the cursor is on, falling back to the first monitor.
fn frame_under_cursor<'a, R: Runtime>(
    app: &AppHandle<R>,
    frames: &'a [frames::Frame],
) -> Option<&'a frames::Frame> {
    let cursor = app.cursor_position().ok();

    if let Some(position) = cursor {
        // Tauri reports the cursor in physical px; MonitorBounds reasons in logical space.
        let found = frames.iter().find(|frame| {
            let scale = frame.bounds.scale_factor;
            frame
                .bounds
                .contains_global(position.x / scale, position.y / scale)
        });
        if found.is_some() {
            return found;
        }
        log::warn!("no monitor contains the cursor at {position:?}; using the first");
    }

    frames.first()
}

/// Commit a selection from the overlay (PRD F1.5).
pub fn commit<R: Runtime>(
    app: &AppHandle<R>,
    monitor_id: u32,
    rect: LogicalRect,
) -> Result<PathBuf, CaptureError> {
    let started = Instant::now();

    let cropped = app
        .state::<FrozenFrames>()
        .with(monitor_id, |frame| {
            crop::to_physical(rect, &frame.bounds).map(|physical| (frame.crop(physical), physical))
        })
        .ok_or(CaptureError::StaleMonitor)?
        .ok_or(CaptureError::EmptySelection)?;

    let (image, physical) = cropped;
    let path = save_png(app, &image)?;

    overlay::hide_all(app);
    app.state::<FrozenFrames>().clear();
    CURRENT_NONCE.store(0, Ordering::Relaxed);

    log::info!(
        "captured {}x{} px in {:.1} ms: {}",
        physical.width,
        physical.height,
        started.elapsed().as_secs_f64() * 1000.0,
        path.display()
    );

    deliver(app, &path, &image);
    Ok(path)
}

/// Capture the whole monitor the overlay is on (PRD F1.3 — the `F` key).
pub fn commit_full<R: Runtime>(app: &AppHandle<R>, monitor_id: u32) -> Result<PathBuf, CaptureError> {
    let bounds = app
        .state::<FrozenFrames>()
        .with(monitor_id, |frame| frame.bounds)
        .ok_or(CaptureError::StaleMonitor)?;

    commit(
        app,
        monitor_id,
        LogicalRect {
            x: 0.0,
            y: 0.0,
            width: bounds.logical_width,
            height: bounds.logical_height,
        },
    )
}

/// Everything PRD F1.5 asks for once the pixels are on disk: copy to the clipboard (if the
/// setting is on), put the item on the shelf, and show the shelf with it highlighted.
///
/// Deliberately infallible — the capture already succeeded, so a clipboard or window
/// failure is worth a log line but must not turn into "the capture failed".
fn deliver<R: Runtime>(app: &AppHandle<R>, path: &std::path::Path, image: &image::RgbaImage) {
    let settings = crate::settings::load(app).unwrap_or_default();

    // The row has to exist before the shelf reloads, or the new item is missing from the
    // very list the highlight refers to.
    let item = match crate::shelf::add_capture(app, path, image) {
        Ok(item) => Some(item),
        Err(error) => {
            log::error!("the capture was saved but not added to the shelf: {error}");
            toast(app, "error", "That capture didn't make it to the shelf.");
            None
        }
    };

    if settings.copy_on_capture {
        match crate::clipboard::copy_image(path) {
            Ok(()) => toast(app, "info", "Copied to clipboard"),
            Err(error) => log::warn!("could not copy the capture to the clipboard: {error}"),
        }
    }

    crate::shelf::changed(app);

    if settings.show_shelf_on_capture {
        crate::shelf::show(app);
    }

    if let Some(item) = item {
        let _ = app.emit("shelf:highlight", serde_json::json!({ "id": item.id }));

        // PRD F4.3: every new capture goes to the paired phones. On a thread, because the
        // seal-and-upload is a network round trip and this function is on the path between
        // the hotkey and the shelf appearing.
        if settings.auto_sync {
            crate::cloud::vault::sync_capture_in_background(app, &item);
        }
    }
}

/// What an overlay should be drawing right now.
///
/// A window created for a freshly plugged-in monitor has no event listener yet when
/// `show_all` fires, so it would come up blank while still swallowing clicks. On mount the
/// overlay asks this instead of waiting for an event that already happened.
pub fn pending<R: Runtime>(app: &AppHandle<R>, monitor_id: u32) -> Option<overlay::OverlayStart> {
    let nonce = CURRENT_NONCE.load(Ordering::Relaxed);
    if nonce == 0 {
        return None;
    }
    app.state::<FrozenFrames>()
        .with(monitor_id, |frame| {
            overlay::start_payload(frame.monitor_id, &frame.bounds, nonce)
        })
}

/// Close the overlay without capturing (PRD F1.3 — `Esc`).
pub fn cancel<R: Runtime>(app: &AppHandle<R>) {
    overlay::hide_all(app);
    // Drops the frozen bitmaps, which are tens of megabytes on a 4K setup.
    app.state::<FrozenFrames>().clear();
    CURRENT_NONCE.store(0, Ordering::Relaxed);
    log::info!("capture cancelled");
}

/// Pre-create the overlay windows at startup so a capture only has to show them
/// (ARCHITECTURE §5.1).
pub fn prewarm_overlays<R: Runtime>(app: &AppHandle<R>) {
    match frames::monitor_bounds() {
        Ok(bounds) => {
            if let Err(error) = overlay::prewarm(app, &bounds) {
                log::warn!("could not pre-create the overlay windows: {error}");
            }
        }
        Err(error) => log::warn!("could not enumerate monitors at startup: {error}"),
    }

    frames::prewarm_capture();
}

/// `app-data/captures/{timestamp}.png` (ARCHITECTURE §5.3). The shelf takes over naming and
/// thumbnails in Phase 2.1.
fn save_png<R: Runtime>(
    app: &AppHandle<R>,
    image: &image::RgbaImage,
) -> Result<PathBuf, CaptureError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| CaptureError::Save(error.to_string()))?
        .join("captures");
    fs::create_dir_all(&dir).map_err(|error| CaptureError::Save(error.to_string()))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let path = dir.join(format!("{stamp}.png"));

    let bytes = frames::encode_png(image)?;
    fs::write(&path, bytes).map_err(|error| CaptureError::Save(error.to_string()))?;

    Ok(path)
}

fn toast<R: Runtime>(app: &AppHandle<R>, kind: &str, text: &str) {
    let _ = app.emit("toast", serde_json::json!({ "kind": kind, "text": text }));
}

/// Re-exported so `commands.rs` can name the rect type without reaching into `crop`.
pub use crop::LogicalRect as SelectionRect;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::crop::{MonitorBounds, PhysicalRect};

    #[test]
    fn modes_match_the_architecture_command_surface() {
        // start_capture(mode: 'region'|'screen')
        assert_eq!(serde_json::to_string(&Mode::Region).unwrap(), "\"region\"");
        assert_eq!(serde_json::to_string(&Mode::Screen).unwrap(), "\"screen\"");
    }

    #[test]
    fn the_frame_nonce_always_moves_forward() {
        let first = FRAME_NONCE.fetch_add(1, Ordering::Relaxed);
        let second = FRAME_NONCE.fetch_add(1, Ordering::Relaxed);
        assert!(second > first);
    }

    /// Guards the full-monitor shortcut: it must ask for the whole logical frame, which
    /// `to_physical` then scales back up to every physical pixel.
    #[test]
    fn the_f_key_selects_the_entire_monitor() {
        let bounds = MonitorBounds::from_physical(0, 0, 3840, 2160, 2.0);
        let whole = LogicalRect {
            x: 0.0,
            y: 0.0,
            width: bounds.logical_width,
            height: bounds.logical_height,
        };
        assert_eq!(
            crop::to_physical(whole, &bounds),
            Some(PhysicalRect {
                x: 0,
                y: 0,
                width: 3840,
                height: 2160
            })
        );
    }
}

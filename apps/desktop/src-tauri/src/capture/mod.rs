//! Capture pipeline (ARCHITECTURE §5.2).
//!
//! ```text
//! hotkey ─▶ permissions check ─▶ window_list::snapshot() ─▶ frames::grab_all()
//!        ─▶ overlay::ensure_windows + show_all
//! drag   ─▶ overlay_commit {monitorId, rect} ─▶ crop::to_physical ─▶ Frame::crop
//!        ─▶ PNG into app-data/captures ─▶ overlay::hide_all
//! click  ─▶ overlay_commit_window {monitorId, index} ─▶ the stored window rect ─▶ same path
//! ```
//!
//! The sync upload from §5.2 lands in Phase 5; everything else in the pipeline is here.

pub mod crop;
pub mod frames;
pub mod overlay;
pub mod permissions;
pub mod watch;
pub mod window_list;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use thiserror::Error;

use crate::capture::crop::LogicalRect;
use crate::capture::frames::{FrozenFrames, FrameError};
use crate::capture::overlay::OverlayError;
use crate::platform;

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
    /// PRD F1.6 — the same overlay, opened in window mode (tray "Capture window").
    Window,
}

/// Bumped per capture so the webview cannot reuse the previous frame from its cache.
static FRAME_NONCE: AtomicU64 = AtomicU64::new(1);
/// The nonce of the capture currently on screen, for [`pending`].
static CURRENT_NONCE: AtomicU64 = AtomicU64::new(0);
/// Whether the capture on screen opened in window mode, for [`pending`].
static WINDOW_MODE: AtomicBool = AtomicBool::new(false);

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
    /*
     * Pay-first (docs/designs/pay-first-10.md): capture is paused until a purchase. The shelf
     * stays readable and draggable, so anything already on it (including items a refunded
     * licence left behind) remains usable until it expires. Decided locally so a hotkey never
     * waits on the network; the server refuses an unlicensed caller independently.
     */
    if paused(app) {
        return Ok(());
    }

    // One overlay session at a time: the Edit surface is using the overlay windows.
    if crate::shelf::edit::is_open(app) {
        log::info!("capture ignored: an edit is open");
        return Ok(());
    }

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
    // Listed while the overlays are still hidden, so they can't appear in the list; a window
    // that moves in the few ms before the grab is accepted (cleanshot-gaps.md, PR 2).
    let windows = match mode {
        Mode::Region | Mode::Window => window_list::snapshot(),
        Mode::Screen => Vec::new(),
    };
    let mut frames = frames::grab_all()?;

    match mode {
        Mode::Screen => {
            let frame = frame_under_cursor(app, &frames);
            let Some(frame) = frame else {
                return Err(CaptureError::StaleMonitor);
            };
            let image = frame.crop(frame.bounds.full_frame());
            // The hotkey handler runs on the main thread; encoding there froze the whole app,
            // shelf included, until the PNG was written.
            let app = app.clone();
            std::thread::spawn(move || match save_png(&app, &image) {
                Ok(path) => {
                    log::info!(
                        "full-screen capture saved in {:.1} ms: {}",
                        started.elapsed().as_secs_f64() * 1000.0,
                        path.display()
                    );
                    deliver(&app, &path, &image, crate::shelf::store::Source::Capture, true);
                }
                Err(error) => {
                    log::error!("the capture could not be saved: {error}");
                    toast(&app, "error", &error.to_string());
                }
            });
        }
        Mode::Region | Mode::Window => {
            for frame in &mut frames {
                frame.windows =
                    window_list::rects_for(&windows, platform::WINDOW_SPACE, &frame.bounds);
            }
            let window_mode = mode == Mode::Window;
            WINDOW_MODE.store(window_mode, Ordering::Relaxed);

            let monitors = overlay::monitors_of(&frames);
            overlay::ensure_windows(app, &monitors)?;

            let nonce = FRAME_NONCE.fetch_add(1, Ordering::Relaxed);
            CURRENT_NONCE.store(nonce, Ordering::Relaxed);

            // Publish the frames *before* showing. A webview that is still booting misses
            // the overlay:start event entirely, and then asks for it with `pending` — which
            // can only answer once the frames are in place.
            app.state::<FrozenFrames>().replace(frames);
            overlay::show_all(app, &monitors, nonce, window_mode)?;

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

    // Crop and release the frozen frames in one step, so a second commit racing this one
    // finds nothing to crop (commits run off the main thread).
    let cropped = app
        .state::<FrozenFrames>()
        .take(monitor_id, |frame| {
            crop::to_physical(rect, &frame.bounds).map(|physical| (frame.crop(physical), physical))
        })
        .ok_or(CaptureError::StaleMonitor)?
        .ok_or(CaptureError::EmptySelection)?;

    // Give the screen back before encoding: the PNG takes 100+ ms on a Retina capture, and
    // the frozen overlay sitting on top of everything until then read as lag.
    overlay::hide_all(app);
    CURRENT_NONCE.store(0, Ordering::Relaxed);

    let (image, physical) = cropped;
    let path = save_png(app, &image).inspect_err(|error| {
        log::error!("the capture could not be saved: {error}");
        toast(app, "error", &error.to_string());
    })?;

    log::info!(
        "captured {}x{} px in {:.1} ms: {}",
        physical.width,
        physical.height,
        started.elapsed().as_secs_f64() * 1000.0,
        path.display()
    );

    deliver(app, &path, &image, crate::shelf::store::Source::Capture, true);
    Ok(path)
}

/// Commit the window the overlay highlighted (PRD F1.6).
///
/// The overlay sends only an index into the list Rust gave it; the rect is looked up here,
/// so the UI can never ask for pixels outside a window it was offered.
pub fn commit_window<R: Runtime>(
    app: &AppHandle<R>,
    monitor_id: u32,
    index: usize,
) -> Result<PathBuf, CaptureError> {
    let rect = window_rect(&app.state::<FrozenFrames>(), monitor_id, index)?;
    commit(app, monitor_id, rect)
}

/// The stored window rect behind an overlay's index.
fn window_rect(
    frames: &FrozenFrames,
    monitor_id: u32,
    index: usize,
) -> Result<LogicalRect, CaptureError> {
    frames
        .with(monitor_id, |frame| frame.windows.get(index).copied())
        .ok_or(CaptureError::StaleMonitor)?
        .ok_or(CaptureError::EmptySelection)
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
fn deliver<R: Runtime>(
    app: &AppHandle<R>,
    path: &std::path::Path,
    image: &image::RgbaImage,
    source: crate::shelf::store::Source,
    copy_allowed: bool,
) {
    let settings = crate::settings::load(app).unwrap_or_default();

    // The row has to exist before the shelf reloads, or the new item is missing from the
    // very list the highlight refers to.
    let item = match crate::shelf::add_capture(app, path, image, source) {
        Ok(item) => Some(item),
        Err(error) => {
            log::error!("the capture was saved but not added to the shelf: {error}");
            toast(app, "error", "That capture didn't make it to the shelf.");
            None
        }
    };

    crate::shelf::changed(app);

    if settings.show_shelf_on_capture {
        crate::shelf::show(app);
    }

    if let Some(item) = item {
        let _ = app.emit("shelf:highlight", serde_json::json!({ "id": item.id }));
        // Counted locally; only the daily number leaves the device (ARCHITECTURE §7.10).
        crate::stats::record_capture(app);
        // The Free plan's "N of 10 left today" counts down with every capture.
        let _ = app.emit("plan:changed", ());

        // PRD F4.3: every new capture goes to the paired phones. On a thread, because the
        // seal-and-upload is a network round trip and this function is on the path between
        // the hotkey and the shelf appearing.
        if settings.auto_sync {
            crate::cloud::vault::sync_capture_in_background(app, &item);
        }
    }

    // Last, and on its own thread: putting a Retina capture on the clipboard costs a few
    // hundred ms, and it used to sit between the capture and the card being draggable.
    // The pixels are already in memory, so nothing is decoded back from disk.
    if copy_allowed && settings.copy_on_capture {
        let app = app.clone();
        let image = image.clone();
        std::thread::spawn(move || match crate::clipboard::copy_rgba(image) {
            Ok(()) => toast(&app, "info", "Copied to clipboard"),
            Err(error) => log::warn!("could not copy the capture to the clipboard: {error}"),
        });
    }
}

/// The Free plan's daily cap (docs/designs/free-plan.md): once today's captures are used,
/// capture waits for tomorrow or a purchase. Shows the shelf with its upgrade banner and says
/// why. Shared by the hotkey and by caught OS screenshots.
fn paused<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = crate::license::plan_state(app);
    if !state.capture_paused {
        return false;
    }
    log::info!("capture is paused: the Free plan's captures for today are used");
    let price = &crate::limits::limits().pricing.display;
    let per_day = state.captures_per_day.unwrap_or_default();
    toast(
        app,
        "error",
        &format!(
            "That's today's {per_day} free screenshots. Unlock Hopshot for {price} once for unlimited, or keep going tomorrow."
        ),
    );
    let _ = tauri::Emitter::emit(app, "plan:changed", ());
    crate::shelf::show(app);
    true
}

/// A screenshot taken with the OS shortcut, caught by [`watch`] (PRD F1.7).
///
/// Re-encoded to PNG into `captures/`, which also drops macOS's screenshot flag so a copy
/// dragged or saved back out is never caught again. Delivered like a capture, except that
/// the clipboard is left alone: the OS already put the screenshot there.
pub fn import_external<R: Runtime>(app: &AppHandle<R>, image: &image::RgbaImage) {
    if paused(app) {
        return;
    }
    match save_png(app, image) {
        Ok(path) => deliver(app, &path, image, crate::shelf::store::Source::Folder, false),
        Err(error) => log::error!("could not save a caught screenshot: {error}"),
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
    let window_mode = WINDOW_MODE.load(Ordering::Relaxed);
    app.state::<FrozenFrames>()
        .with(monitor_id, |frame| overlay::start_payload(frame, nonce, window_mode))
}

/// Is a capture overlay on screen? The Edit surface won't open over one.
pub fn in_progress() -> bool {
    CURRENT_NONCE.load(Ordering::Relaxed) != 0
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
        // start_capture(mode: 'region'|'screen'|'window')
        assert_eq!(serde_json::to_string(&Mode::Region).unwrap(), "\"region\"");
        assert_eq!(serde_json::to_string(&Mode::Screen).unwrap(), "\"screen\"");
        assert_eq!(serde_json::to_string(&Mode::Window).unwrap(), "\"window\"");
    }

    fn held(windows: Vec<LogicalRect>) -> FrozenFrames {
        let frames = FrozenFrames::default();
        frames.replace(vec![crate::capture::frames::Frame {
            monitor_id: 4,
            bounds: MonitorBounds::from_logical(0, 0, 800, 600, 2.0),
            image: image::RgbaImage::new(1, 1),
            display_bytes: Vec::new(),
            windows,
        }]);
        frames
    }

    #[test]
    fn a_window_index_resolves_to_the_stored_rect() {
        let rect = LogicalRect {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 200.0,
        };
        let frames = held(vec![rect]);
        assert_eq!(window_rect(&frames, 4, 0).ok(), Some(rect));
    }

    #[test]
    fn an_index_past_the_list_is_an_empty_selection() {
        let frames = held(Vec::new());
        assert!(matches!(
            window_rect(&frames, 4, 0),
            Err(CaptureError::EmptySelection)
        ));
    }

    #[test]
    fn a_monitor_no_longer_frozen_is_stale() {
        let frames = held(Vec::new());
        assert!(matches!(
            window_rect(&frames, 9, 0),
            Err(CaptureError::StaleMonitor)
        ));
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

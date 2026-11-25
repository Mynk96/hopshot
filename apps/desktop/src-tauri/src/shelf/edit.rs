//! The Edit surface and the background tool's Done (docs/designs/next-features.md, 0.1.16).
//!
//! ```text
//! More ▾ → Background / B ─▶ open(id) ─▶ overlay-{n} in edit mode on the pointer's monitor
//! panel change ─▶ preview(style) ─▶ render a downscaled copy ─▶ frame://…/edit/{nonce}
//! Done ↵ ─▶ done(style) ─▶ apply(): original kept → txn A → framed file renamed over
//!           `path` → txn B ─▶ old share link retired off-thread
//! startup ─▶ recover(): roll interrupted Dones forward, restore missing files, sweep
//! ```
//!
//! The overlay windows are reused, so there is still only one overlay session at a time:
//! [`open`] refuses while a capture is on screen, and `capture::start` ignores the hotkey
//! while an edit is open.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use image::RgbaImage;
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

use crate::capture::crop::MonitorBounds;
use crate::capture::overlay;
use crate::shelf::background::{self, Style};
use crate::shelf::store::{Item, Store, StoreError};
use crate::shelf::{files, thumbs, ShelfError};

/// The panel to the right of the image, plus the gap between them, in CSS px.
const PANEL_WIDTH: f64 = 248.0;
const PANEL_GAP: f64 = 24.0;
/// DESIGN S2 "Edit surface": the image is centred at up to 90% of the monitor.
const MAX_FRACTION: f64 = 0.9;

/// DESIGN §5.
const REMOVED_MID_EDIT: &str = "That screenshot was removed, so your background wasn't saved.";
const COULD_NOT_SAVE: &str = "Couldn't save the background. Your screenshot is unchanged.";
const OLD_LINK_REMOVED: &str = "Old link removed. Share again for a new one.";
const OLD_LINK_PENDING: &str = "Couldn't remove the old copy yet. Hopshot will keep trying.";

static PREVIEW_NONCE: AtomicU64 = AtomicU64::new(1);

/// The open edit, if any. Managed in Tauri state.
#[derive(Default)]
pub struct EditState(Mutex<Option<Session>>);

struct Session {
    item_id: String,
    monitor_id: u32,
    bounds: MonitorBounds,
    /// Full-size pixels the edit starts from: the kept original, never the framed file.
    original: RgbaImage,
    /// The latest preview, served by `frame://` until the next one replaces it.
    preview: Vec<u8>,
    nonce: u64,
    start: EditStart,
}

/// Payload of `overlay:edit`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditStart {
    pub item_id: String,
    /// `background` now; `markup` joins in 0.2.0.
    pub kind: &'static str,
    pub style: Style,
    pub preview: EditPreview,
    /// The monitor in CSS px, for centring.
    pub width: f64,
    pub height: f64,
}

/// A rendered preview: where to load it and how big to draw it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPreview {
    pub url: String,
    /// CSS px.
    pub width: f64,
    pub height: f64,
    /// The saved file's size in physical px, for the panel's size label.
    pub output_width: u32,
    pub output_height: u32,
}

fn state<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, EditState>> {
    app.try_state::<EditState>()
}

/// Is an edit on screen? `capture::start` ignores the hotkey while one is.
pub fn is_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    state(app).is_some_and(|s| s.0.lock().unwrap_or_else(|e| e.into_inner()).is_some())
}

/// The URL an overlay loads a preview from. Same scheme rules as `overlay::frame_url`.
fn preview_url(nonce: u64) -> String {
    if cfg!(target_os = "windows") {
        format!("http://frame.localhost/edit/{nonce}")
    } else {
        format!("frame://localhost/edit/{nonce}")
    }
}

/// The preview bytes for `frame://localhost/edit/{nonce}`, or `None` for a stale nonce.
///
/// Only the current session's in-memory preview is ever served: the URL names a nonce,
/// never a file, so nothing on disk is reachable through it.
pub fn preview_bytes<R: Runtime>(app: &AppHandle<R>, nonce: u64) -> Option<Vec<u8>> {
    let state = state(app)?;
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .filter(|session| session.nonce == nonce)
        .map(|session| session.preview.clone())
}

/// Open the Edit surface with the background panel for `item_id`.
pub fn open<R: Runtime>(app: &AppHandle<R>, item_id: &str) -> Result<(), ShelfError> {
    if is_open(app) || crate::capture::in_progress() {
        return Ok(());
    }

    let item = crate::shelf::store(app)?.get(item_id)?;
    let source = item
        .original_path
        .as_deref()
        .filter(|p| Path::new(p).exists())
        .unwrap_or(&item.path);
    let original = image::open(source)
        .map_err(|error| ShelfError::Decode(error.to_string()))?
        .to_rgba8();

    // Re-opening an edited item starts from its own style; a fresh one from the last used.
    let style = item
        .style
        .as_deref()
        .and_then(|json| serde_json::from_str::<Style>(json).ok())
        .or(crate::settings::load(app).unwrap_or_default().background_style)
        .unwrap_or_default()
        .clamped();

    let (monitor_id, bounds) = monitor_under_pointer(app)?;
    overlay::ensure_windows(app, &[(monitor_id, bounds)]).map_err(|e| ShelfError::Io(e.to_string()))?;

    let (preview, bytes, nonce) = render_preview(&original, &style, &bounds)?;
    let start = EditStart {
        item_id: item.id.clone(),
        kind: "background",
        style,
        preview,
        width: bounds.logical_width,
        height: bounds.logical_height,
    };

    if let Some(state) = state(app) {
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Session {
            item_id: item.id,
            monitor_id,
            bounds,
            original,
            preview: bytes,
            nonce,
            start: start.clone(),
        });
    }

    let label = overlay::label_for(monitor_id);
    let _ = app.emit_to(EventTarget::webview_window(&label), "overlay:edit", &start);
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|e| ShelfError::Io(e.to_string()))?;
        crate::platform::raise_overlay(&window);
        let _ = window.set_focus();
    }
    Ok(())
}

/// What an overlay that missed `overlay:edit` should show (see `capture::pending`).
pub fn pending<R: Runtime>(app: &AppHandle<R>, monitor_id: u32) -> Option<EditStart> {
    let state = state(app)?;
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .filter(|session| session.monitor_id == monitor_id)
        .map(|session| session.start.clone())
}

/// Re-render the preview for a panel change.
pub fn preview<R: Runtime>(app: &AppHandle<R>, style: Style) -> Result<EditPreview, ShelfError> {
    let state = state(app).ok_or(ShelfError::NotReady)?;
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let session = guard.as_mut().ok_or(ShelfError::NotReady)?;

    let style = style.clamped();
    let (preview, bytes, nonce) = render_preview(&session.original, &style, &session.bounds)?;
    session.preview = bytes;
    session.nonce = nonce;
    session.start.style = style;
    session.start.preview = preview.clone();
    Ok(preview)
}

/// Esc / Cancel: close with the item unchanged.
pub fn cancel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = state(app) {
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    overlay::hide_all(app);
}

/// Done ↵: frame the item for real, then close.
///
/// On failure the surface stays open with the error, and the item is unchanged.
pub fn done<R: Runtime>(app: &AppHandle<R>, style: Style) -> Result<(), String> {
    let item_id = {
        let Some(state) = state(app) else {
            return Err(COULD_NOT_SAVE.to_string());
        };
        let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(session) => session.item_id.clone(),
            None => return Ok(()),
        }
    };

    let dir = crate::shelf::app_data(app).map_err(|_| COULD_NOT_SAVE.to_string())?;
    let store = crate::shelf::store(app).map_err(|_| COULD_NOT_SAVE.to_string())?;
    let style = style.clamped();

    let item = match apply(&dir, &store, &item_id, &style) {
        Ok(item) => item,
        Err(ShelfError::Store(StoreError::Missing)) => {
            cancel(app);
            crate::shelf::changed(app);
            toast(app, "error", REMOVED_MID_EDIT);
            return Ok(());
        }
        Err(error) => {
            log::error!("background Done failed for {item_id}: {error}");
            return Err(COULD_NOT_SAVE.to_string());
        }
    };

    // A drag staged before the edit must not hand out the old pixels.
    files::remove_staged(&dir, &item.id);

    let mut patch = serde_json::Map::new();
    if let Ok(value) = serde_json::to_value(style) {
        patch.insert("backgroundStyle".into(), value);
        if let Err(error) = crate::settings::patch(app, patch) {
            log::warn!("could not remember the background style: {error}");
        }
    }

    cancel(app);
    crate::shelf::changed(app);
    let _ = app.emit("shelf:highlight", serde_json::json!({ "id": item.id }));

    // Off the UI path: the delete is a network call with a 30 s timeout. Phone copies are
    // left alone (design doc, "Phone copies (vault) on Done"), and nothing is re-synced.
    if item.drop_id.is_some() {
        let handle = app.clone();
        let id = item.id.clone();
        std::thread::spawn(move || match crate::cloud::drops::retire(&handle, &id) {
            Ok(crate::cloud::drops::OldLink::Removed) => toast(&handle, "info", OLD_LINK_REMOVED),
            Ok(crate::cloud::drops::OldLink::Pending) => toast(&handle, "info", OLD_LINK_PENDING),
            Ok(crate::cloud::drops::OldLink::None) => {}
            Err(error) => log::warn!("could not retire the old link for {id}: {error}"),
        });
    }

    Ok(())
}

/// The crash-safe Done (design doc, "Crash-safe commit order on Done"). Testable without
/// a window: it only needs the app-data dir and the store.
pub fn apply(app_data: &Path, store: &Store, item_id: &str, style: &Style) -> Result<Item, ShelfError> {
    let item = store.get(item_id)?;

    // 1. Keep the original, once. After the first edit `path` holds framed pixels, so the
    //    copy must never be taken again.
    let original = match item.original_path.as_deref() {
        Some(existing) if Path::new(existing).exists() => existing.to_string(),
        _ => {
            let target = originals_dir(app_data).join(format!("{item_id}.png"));
            fs::create_dir_all(originals_dir(app_data))?;
            write_atomically(&target, &fs::read(&item.path)?)?;
            target.to_string_lossy().into_owned()
        }
    };

    // 2. Transaction A: `path` is untouched and still a whole image.
    let json = serde_json::to_string(style).map_err(|e| ShelfError::Save(e.to_string()))?;
    store.begin_edit(item_id, &original, &json)?;

    // 3 and 4.
    roll_forward(app_data, store, item_id)
}

/// Steps 3–4: render from `original_path` + `pending_style`, rename over `path`, then
/// transaction B. Deterministic, so recovery can re-run it whether or not the rename had
/// already happened before a crash.
fn roll_forward(app_data: &Path, store: &Store, item_id: &str) -> Result<Item, ShelfError> {
    let item = store.get(item_id)?;
    let (Some(original), Some(pending)) = (item.original_path.as_deref(), item.pending_style.as_deref())
    else {
        return Ok(item);
    };
    let style: Style = serde_json::from_str(pending).map_err(|e| ShelfError::Decode(e.to_string()))?;
    let source = image::open(original)
        .map_err(|e| ShelfError::Decode(e.to_string()))?
        .to_rgba8();

    let framed = background::render(&source, &style);
    let png = crate::capture::frames::encode_png(&framed).map_err(|e| ShelfError::Save(e.to_string()))?;

    write_atomically(Path::new(&item.path), &png)?;

    // A fresh thumbnail name, so the shelf can't show a cached copy of the old one.
    let thumb_id = format!("{item_id}-e{}", crate::shelf::store::now_ms());
    let thumb = thumbs::write(app_data, &thumb_id, &framed)?;
    let edited = store.finish_edit(
        item_id,
        &thumb.to_string_lossy(),
        framed.width(),
        framed.height(),
        png.len() as u64,
    )?;
    if item.thumb_path != edited.thumb_path {
        let _ = fs::remove_file(&item.thumb_path);
    }
    Ok(edited)
}

/// Startup recovery and sweep (design doc, "Startup recovery (roll forward)").
pub fn recover(app_data: &Path, store: &Store) {
    let Ok(items) = store.list() else {
        return;
    };

    for item in &items {
        let original_exists = item.original_path.as_deref().is_some_and(|p| Path::new(p).exists());

        if item.pending_style.is_some() && original_exists {
            match roll_forward(app_data, store, &item.id) {
                Ok(_) => log::info!("finished an interrupted background edit for {}", item.id),
                Err(error) => log::warn!("could not finish the edit for {}: {error}", item.id),
            }
            continue;
        }

        if !Path::new(&item.path).exists() && original_exists {
            if let Err(error) = restore_original(app_data, store, item) {
                log::warn!("could not restore the original for {}: {error}", item.id);
            }
            continue;
        }

        if item.pending_style.is_some() {
            // Nothing to roll forward from; `path` was never touched.
            let _ = store.reset_edit(&item.id, &item.thumb_path, item.width, item.height, item.bytes);
        }
    }

    sweep(app_data, store);
}

fn restore_original(app_data: &Path, store: &Store, item: &Item) -> Result<(), ShelfError> {
    let Some(original) = item.original_path.as_deref() else {
        return Ok(());
    };
    let bytes = fs::read(original)?;
    write_atomically(Path::new(&item.path), &bytes)?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| ShelfError::Decode(e.to_string()))?
        .to_rgba8();
    let thumb_id = format!("{}-r{}", item.id, crate::shelf::store::now_ms());
    let thumb = thumbs::write(app_data, &thumb_id, &image)?;
    store.reset_edit(
        &item.id,
        &thumb.to_string_lossy(),
        image.width(),
        image.height(),
        bytes.len() as u64,
    )?;
    let _ = fs::remove_file(&item.thumb_path);
    Ok(())
}

/// Delete originals no row points at, and any `*.tmp` a crash left behind.
fn sweep(app_data: &Path, store: &Store) {
    let referenced: std::collections::HashSet<PathBuf> = store
        .list()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.original_path.map(PathBuf::from))
        .collect();

    for dir in [originals_dir(app_data), files::captures_dir(app_data)] {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_tmp = path.extension().and_then(|e| e.to_str()) == Some("tmp");
            let is_orphan_original = dir == originals_dir(app_data) && !referenced.contains(&path);
            if is_tmp || is_orphan_original {
                if let Err(error) = fs::remove_file(&path) {
                    log::warn!("could not delete {}: {error}", path.display());
                }
            }
        }
    }
}

/// `originals/` under the app-data dir: never `captures/`, which orphan adoption scans.
pub fn originals_dir(app_data: &Path) -> PathBuf {
    app_data.join("originals")
}

/// Write `{path}.tmp`, fsync it, then rename it over `path`, so a reader (or a crash)
/// only ever sees the old file or the new one.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), ShelfError> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Render a preview that fits beside the panel at up to 90% of the monitor.
fn render_preview(
    original: &RgbaImage,
    style: &Style,
    bounds: &MonitorBounds,
) -> Result<(EditPreview, Vec<u8>, u64), ShelfError> {
    let full = background::layout(original.width(), original.height(), style);
    let scale = bounds.scale_factor.max(1.0);

    let available_width = (bounds.logical_width * MAX_FRACTION - PANEL_WIDTH - PANEL_GAP).max(120.0);
    let available_height = (bounds.logical_height * MAX_FRACTION).max(120.0);
    // Never upscale: a small screenshot is shown at its real size.
    let k = (available_width * scale / full.canvas_width as f64)
        .min(available_height * scale / full.canvas_height as f64)
        .min(1.0);

    let preview_source = if k < 1.0 {
        let w = ((original.width() as f64 * k).round() as u32).max(1);
        let h = ((original.height() as f64 * k).round() as u32).max(1);
        image::imageops::resize(original, w, h, image::imageops::FilterType::Triangle)
    } else {
        original.clone()
    };

    let rendered = background::render_scaled(&preview_source, style, original.width(), original.height());
    let bytes = encode_fast_png(&rendered)?;
    let nonce = PREVIEW_NONCE.fetch_add(1, Ordering::Relaxed);

    Ok((
        EditPreview {
            url: preview_url(nonce),
            width: rendered.width() as f64 / scale,
            height: rendered.height() as f64 / scale,
            output_width: full.canvas_width,
            output_height: full.canvas_height,
        },
        bytes,
        nonce,
    ))
}

/// PNG, not BMP like the frozen frames: the preview has a transparent "None" fill, and
/// webviews ignore a 32-bit BMP's alpha. Fast settings keep a slider drag responsive.
fn encode_fast_png(image: &RgbaImage) -> Result<Vec<u8>, ShelfError> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;

    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::NoFilter)
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| ShelfError::Save(e.to_string()))?;
    Ok(out)
}

/// The monitor under the pointer, falling back to the first one.
fn monitor_under_pointer<R: Runtime>(app: &AppHandle<R>) -> Result<(u32, MonitorBounds), ShelfError> {
    let monitors = crate::capture::frames::monitor_bounds().map_err(|e| ShelfError::Io(e.to_string()))?;
    if let Ok(cursor) = app.cursor_position() {
        if let Some(found) = monitors.iter().find(|(_, b)| {
            b.contains_global(cursor.x / b.scale_factor, cursor.y / b.scale_factor)
        }) {
            return Ok(*found);
        }
    }
    monitors
        .first()
        .copied()
        .ok_or_else(|| ShelfError::Io("no monitor is attached".to_string()))
}

fn toast<R: Runtime>(app: &AppHandle<R>, kind: &str, text: &str) {
    let _ = app.emit("toast", serde_json::json!({ "kind": kind, "text": text }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::Plan;
    use crate::shelf::store::{NewItem, Source};

    struct Fixture {
        dir: PathBuf,
        store: Store,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("hopshot-edit-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(files::captures_dir(&dir)).expect("captures");
            Fixture { store: Store::open(&dir).expect("store"), dir }
        }

        fn add(&self, id: &str, ttl: Option<i64>) -> Item {
            let path = files::captures_dir(&self.dir).join(format!("{id}.png"));
            let image = RgbaImage::from_pixel(120, 80, image::Rgba([10, 20, 30, 255]));
            image.save(&path).expect("png");
            let thumb = thumbs::write(&self.dir, id, &image).expect("thumb");
            self.store
                .insert_with_id(
                    id,
                    NewItem {
                        source: Source::Capture,
                        origin_device: None,
                        file_name: format!("{id}.png"),
                        bytes: fs::metadata(&path).expect("meta").len(),
                        path,
                        thumb_path: thumb,
                        width: 120,
                        height: 80,
                    },
                    ttl,
                )
                .expect("insert")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn dims(path: &str) -> (u32, u32) {
        image::image_dimensions(path).expect("dimensions")
    }

    #[test]
    fn done_keeps_the_original_and_frames_the_item() {
        let f = Fixture::new("done");
        let item = f.add("a", Some(60_000));
        let style = Style::default();

        let edited = apply(&f.dir, &f.store, "a", &style).expect("apply");

        let original = edited.original_path.clone().expect("original kept");
        assert!(original.starts_with(originals_dir(&f.dir).to_string_lossy().as_ref()));
        assert_eq!(dims(&original), (120, 80), "the original is untouched");

        let l = background::layout(120, 80, &style);
        assert_eq!(dims(&edited.path), (l.canvas_width, l.canvas_height));
        assert_eq!((edited.width, edited.height), (l.canvas_width, l.canvas_height));
        assert_eq!(edited.path, item.path, "the item keeps its path");
        assert!(edited.pending_style.is_none());
        assert!(edited.style.is_some());
    }

    #[test]
    fn re_editing_renders_from_the_original_not_the_framed_file() {
        let f = Fixture::new("reedit");
        f.add("a", Some(60_000));
        let first = Style::default();
        let second = Style { padding: background::Padding::S, aspect: background::Aspect::Square, ..first };

        apply(&f.dir, &f.store, "a", &first).expect("first");
        let again = apply(&f.dir, &f.store, "a", &second).expect("second");

        let l = background::layout(120, 80, &second);
        assert_eq!(dims(&again.path), (l.canvas_width, l.canvas_height));
        assert_eq!(dims(again.original_path.as_deref().expect("original")), (120, 80));
    }

    #[test]
    fn a_crash_after_transaction_a_is_rolled_forward() {
        let f = Fixture::new("crash-a");
        let item = f.add("a", Some(60_000));
        // Steps 1–2 only, as if the app died before the render.
        let original = originals_dir(&f.dir).join("a.png");
        fs::create_dir_all(originals_dir(&f.dir)).expect("dir");
        fs::copy(&item.path, &original).expect("copy");
        let style = Style::default();
        f.store
            .begin_edit("a", &original.to_string_lossy(), &serde_json::to_string(&style).expect("json"))
            .expect("txn a");

        recover(&f.dir, &f.store);

        let fixed = f.store.get("a").expect("get");
        assert!(fixed.pending_style.is_none());
        let l = background::layout(120, 80, &style);
        assert_eq!(dims(&fixed.path), (l.canvas_width, l.canvas_height));
        assert_eq!((fixed.width, fixed.height), (l.canvas_width, l.canvas_height));
    }

    #[test]
    fn a_crash_after_the_rename_is_rolled_forward_to_the_same_result() {
        let f = Fixture::new("crash-rename");
        let item = f.add("a", Some(60_000));
        let style = Style::default();
        let done = {
            let other = Fixture::new("crash-rename-ref");
            other.add("a", Some(60_000));
            let edited = apply(&other.dir, &other.store, "a", &style).expect("reference");
            fs::read(edited.path).expect("bytes")
        };

        // Steps 1–3 done (framed bytes at `path`), transaction B never ran.
        let original = originals_dir(&f.dir).join("a.png");
        fs::create_dir_all(originals_dir(&f.dir)).expect("dir");
        fs::copy(&item.path, &original).expect("copy");
        f.store
            .begin_edit("a", &original.to_string_lossy(), &serde_json::to_string(&style).expect("json"))
            .expect("txn a");
        fs::write(&item.path, &done).expect("renamed");

        recover(&f.dir, &f.store);

        let fixed = f.store.get("a").expect("get");
        assert!(fixed.pending_style.is_none());
        assert_eq!(fs::read(&fixed.path).expect("bytes"), done);
        assert_eq!(fixed.bytes, done.len() as u64);
    }

    #[test]
    fn a_missing_file_is_restored_from_the_original() {
        let f = Fixture::new("missing");
        f.add("a", Some(60_000));
        let edited = apply(&f.dir, &f.store, "a", &Style::default()).expect("apply");
        fs::remove_file(&edited.path).expect("lose the file");

        recover(&f.dir, &f.store);

        let fixed = f.store.get("a").expect("get");
        assert_eq!(dims(&fixed.path), (120, 80));
        assert!(fixed.style.is_none());
    }

    #[test]
    fn the_sweep_removes_unreferenced_originals_and_tmp_files() {
        let f = Fixture::new("sweep");
        f.add("a", Some(60_000));
        let edited = apply(&f.dir, &f.store, "a", &Style::default()).expect("apply");
        let stray = originals_dir(&f.dir).join("gone.png");
        fs::write(&stray, b"png").expect("stray");
        let tmp = files::captures_dir(&f.dir).join("b.png.tmp");
        fs::write(&tmp, b"partial").expect("tmp");

        recover(&f.dir, &f.store);

        assert!(!stray.exists());
        assert!(!tmp.exists());
        assert!(Path::new(edited.original_path.as_deref().expect("kept")).exists());
    }

    /// Every removal path goes through `expiry::remove_files`; expiry and capacity are the
    /// sweeps, Delete and Remove-after-drag call it directly.
    #[test]
    fn expiry_and_capacity_remove_the_original_too() {
        let f = Fixture::new("expiry");
        f.add("old", Some(-60_000));
        let expired = apply(&f.dir, &f.store, "old", &Style::default()).expect("apply");
        let original = expired.original_path.clone().expect("original");

        crate::shelf::expiry::sweep(&f.store, &f.dir, Plan::Lifetime, crate::shelf::store::now_ms())
            .expect("sweep");
        assert!(!Path::new(&original).exists(), "expiry left the original behind");

        let capacity = crate::shelf::store::capacity_for(Plan::Expired);
        let mut originals = Vec::new();
        for n in 0..capacity + 1 {
            let id = format!("c{n}");
            f.add(&id, Some(60_000));
            originals.push(apply(&f.dir, &f.store, &id, &Style::default()).expect("apply").original_path);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        crate::shelf::expiry::sweep(&f.store, &f.dir, Plan::Expired, crate::shelf::store::now_ms())
            .expect("sweep");
        let first = originals[0].clone().expect("original");
        assert!(!Path::new(&first).exists(), "capacity drop-off left the original behind");
    }

    #[test]
    fn deleting_an_item_removes_its_original() {
        let f = Fixture::new("delete");
        f.add("a", Some(60_000));
        let edited = apply(&f.dir, &f.store, "a", &Style::default()).expect("apply");
        let removed = f.store.delete("a").expect("delete");
        crate::shelf::expiry::remove_files(&f.dir, &removed);
        assert!(!Path::new(edited.original_path.as_deref().expect("original")).exists());
        assert!(!Path::new(&edited.path).exists());
    }

    #[test]
    fn a_removed_item_is_reported_as_missing() {
        let f = Fixture::new("removed");
        assert!(matches!(
            apply(&f.dir, &f.store, "nope", &Style::default()),
            Err(ShelfError::Store(StoreError::Missing))
        ));
    }

    #[test]
    fn tmp_files_are_never_adopted_as_captures() {
        let f = Fixture::new("adopt");
        fs::write(files::captures_dir(&f.dir).join("1.png.tmp"), b"x").expect("tmp");
        let found = files::list_capture_files(&f.dir).expect("list");
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn preview_urls_name_a_nonce_not_a_file() {
        let url = preview_url(42);
        assert!(url.ends_with("/edit/42"), "{url}");
    }
}

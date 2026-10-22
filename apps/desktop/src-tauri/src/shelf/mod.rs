//! Local shelf: store, files, expiry, thumbnails (ARCHITECTURE §5.3).
//!
//! `store` is the source of truth; `files` owns naming and the `drag/` staging area, and
//! `expiry` runs the sweep. Everything the UI can do to an item goes through here so the
//! command layer stays thin (CLAUDE.md rule 3).

pub mod expiry;
pub mod files;
pub mod store;
pub mod thumbs;

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use thiserror::Error;

use crate::clipboard::ClipboardError;
use crate::settings::Settings;
use crate::shelf::files::FileError;
use crate::shelf::store::{Item, NewItem, Source, Store, StoreError};
use crate::shelf::thumbs::ThumbError;

/// Tauri window label for the shelf (ARCHITECTURE §5.1).
pub const SHELF_WINDOW: &str = "shelf";

/// Staged drag copies are disposable; an hour is long enough for any drop to finish.
pub(crate) const DRAG_STAGING_TTL_MS: u64 = 60 * 60 * 1000;

/// Whether the OS applied a real backdrop (Windows acrylic / macOS vibrancy) to the shelf.
///
/// The shelf window is transparent, so when this is `false` the glass surface would
/// composite straight onto the wallpaper with nothing behind it — `backdrop-filter` samples
/// only the page, never the desktop. The UI reads this and switches to `--surface-solid`
/// instead (DESIGN §7).
pub struct Vibrancy(pub bool);

/// Does the shelf have an OS backdrop to draw glass over?
pub fn has_vibrancy<R: Runtime>(app: &AppHandle<R>) -> bool {
    // Missing state means setup has not reached the shelf window yet. Solid is the safe
    // answer: a readable panel that is slightly plainer beats an unreadable one.
    app.try_state::<Vibrancy>().is_some_and(|state| state.0)
}

#[derive(Debug, Error)]
pub enum ShelfError {
    #[error("the shelf is still starting up")]
    NotReady,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Files(#[from] FileError),
    #[error(transparent)]
    Thumb(#[from] ThumbError),
    #[error(transparent)]
    Clipboard(#[from] ClipboardError),
    #[error("the app data folder is unavailable: {0}")]
    AppData(String),
    #[error("that file could not be written: {0}")]
    Save(String),
    /// A vault item whose PNG will not decode — a truncated download, or a key mismatch
    /// that produced plausible-looking garbage.
    #[error("that image could not be read: {0}")]
    Decode(String),
    #[error("that file could not be read: {0}")]
    Io(String),
}

impl From<std::io::Error> for ShelfError {
    fn from(error: std::io::Error) -> Self {
        ShelfError::Io(error.to_string())
    }
}

/// The store, or a clean error if setup has not reached it yet.
///
/// `Manager::state` *panics* when the type was never managed, and a panic raised inside a
/// command handler cannot unwind across Tauri's FFI boundary — it aborts the process. The
/// shelf webview can invoke a command before `setup()` finishes, so this has to be fallible.
pub fn store<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, Store>, ShelfError> {
    app.try_state::<Store>().ok_or(ShelfError::NotReady)
}

pub fn app_data<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, ShelfError> {
    app.path()
        .app_data_dir()
        .map_err(|error| ShelfError::AppData(error.to_string()))
}

/// Everything on the shelf, newest first (PRD F2.1).
pub fn list<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Item>, ShelfError> {
    Ok(store(app)?.list()?)
}

/// Record a freshly captured PNG: write its thumbnail, insert the row, return the item.
///
/// The TTL comes from the user's "keep items" setting (PRD F2.7, default 24 h).
pub fn add_capture<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    image: &image::RgbaImage,
) -> Result<Item, ShelfError> {
    let dir = app_data(app)?;
    let settings = crate::settings::load(app).unwrap_or_default();

    let id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(String::from)
        .unwrap_or_else(store::new_id);

    let thumb_path = thumbs::write(&dir, &id, image)?;
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or_default();

    let item = store(app)?.insert(
        NewItem {
            source: Source::Capture,
            origin_device: None,
            file_name: files::friendly_name(store::now_ms()),
            path: path.to_path_buf(),
            thumb_path,
            width: image.width(),
            height: image.height(),
            bytes,
        },
        Some(settings.item_ttl_ms()),
    )?;

    Ok(item)
}

/// Put an item that arrived from a paired phone onto the shelf (PRD F4.5).
///
/// The PNG has already been unsealed by `cloud::vault`, so this is the same work as
/// [`add_capture`] with two differences: the bytes have to be written to `captures/`
/// ourselves, and the source is recorded so the card shows a "from iPhone" badge.
///
/// The vault item's id is reused as the shelf id, which makes the insert idempotent — a
/// reconnect that replays `item.created` cannot add the same screenshot twice.
pub fn add_from_vault<R: Runtime>(
    app: &AppHandle<R>,
    item_id: &str,
    png: &[u8],
    meta: &crate::cloud::vault::ItemMeta,
) -> Result<(), ShelfError> {
    let dir = app_data(app)?;
    let settings = crate::settings::load(app).unwrap_or_default();

    // Already here: a replayed event, not a new screenshot.
    if store(app)?.get(item_id).is_ok() {
        return Ok(());
    }

    let image = image::load_from_memory(png)
        .map_err(|error| ShelfError::Decode(error.to_string()))?
        .to_rgba8();

    let captures = files::captures_dir(&dir);
    std::fs::create_dir_all(&captures)?;
    let path = captures.join(format!("{item_id}.png"));
    std::fs::write(&path, png)?;

    let thumb_path = thumbs::write(&dir, item_id, &image)?;

    store(app)?.insert_with_id(
        item_id,
        NewItem {
            source: Source::Phone,
            origin_device: meta.origin.clone(),
            file_name: meta.name.clone(),
            path,
            thumb_path,
            width: image.width(),
            height: image.height(),
            bytes: png.len() as u64,
        },
        Some(settings.item_ttl_ms()),
    )?;

    // PRD F4.5: the shelf pops out when something arrives from a phone.
    show(app);
    changed(app);
    let _ = app.emit(
        "toast",
        serde_json::json!({
            "kind": "info",
            "text": match meta.origin.as_deref() {
                Some(device) => format!("New from {device}"),
                None => "New from your phone".to_string(),
            },
        }),
    );

    Ok(())
}

/// Stage a capture under its friendly name and return the path to drag (PRD F2.4).
pub fn prepare_drag<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<DragPaths, ShelfError> {
    let dir = app_data(app)?;
    let item = store(app)?.get(id)?;
    let staged = files::stage_for_drag(&dir, &item.id, &item.path, &item.file_name)?;

    Ok(DragPaths {
        path: staged.to_string_lossy().into_owned(),
        icon: item.thumb_path,
    })
}

/// What `startDrag` needs: the staged file and the thumbnail to carry (ARCHITECTURE §5.3).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragPaths {
    pub path: String,
    pub icon: String,
}

/// Copy a capture to the clipboard (PRD F2.5).
pub fn copy<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), ShelfError> {
    let item = store(app)?.get(id)?;
    crate::clipboard::copy_image(Path::new(&item.path))?;
    Ok(())
}

/// Delete an item and its files (PRD F2.6).
pub fn delete<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), ShelfError> {
    let dir = app_data(app)?;
    let item = store(app)?.delete(id)?;
    expiry::remove_files(&dir, &item);
    changed(app);
    Ok(())
}

/// A drag of `id` ended (PRD F2.10, "Remove after dragging out").
///
/// The setting is read here rather than in the UI so the shelf stays a view (rule 3). A
/// cancelled drag leaves the item alone: the user did not hand it anywhere.
pub fn drag_finished<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    dropped: bool,
) -> Result<(), ShelfError> {
    if !dropped {
        return Ok(());
    }
    if !crate::settings::load(app).unwrap_or_default().remove_after_drag {
        return Ok(());
    }
    delete(app, id)
}

/// Pin or unpin (PRD F2.11).
pub fn set_pinned<R: Runtime>(app: &AppHandle<R>, id: &str, pinned: bool) -> Result<Item, ShelfError> {
    let settings = crate::settings::load(app).unwrap_or_default();
    let item = store(app)?.set_pinned(id, pinned, settings.item_ttl_ms())?;
    changed(app);
    Ok(item)
}

/// Write a copy wherever the user chose (PRD F2.9).
pub fn save_as<R: Runtime>(app: &AppHandle<R>, id: &str, destination: &Path) -> Result<(), ShelfError> {
    let item = store(app)?.get(id)?;
    std::fs::copy(&item.path, destination).map_err(|e| ShelfError::Save(e.to_string()))?;
    Ok(())
}

/// The capture file, for "Reveal in Finder" / "Show in File Explorer" (PRD F2.6).
pub fn path_of<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<String, ShelfError> {
    Ok(store(app)?.get(id)?.path)
}

/// Tell the shelf to reload.
pub fn changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("shelf:changed", ());
}

/// Show the shelf without taking focus from whatever the user is working in (PRD F2.1).
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(SHELF_WINDOW) else {
        log::warn!("the shelf window is missing from tauri.conf.json");
        return;
    };

    if let Err(error) = window.show() {
        log::warn!("the shelf would not show: {error}");
        return;
    }

    // Non-activating is a window-style property, so showing is all it takes on Windows;
    // macOS needs the panel ordered front without activating the app.
    crate::platform::raise_shelf(&window);

    if let Err(error) = position(app, &window) {
        log::warn!("the shelf could not be positioned: {error}");
    }

    // The shelf webview mounts once at launch and is only shown and hidden after that, so
    // becoming visible is not something it can notice on its own — and the auto-hide
    // countdown (PRD F2.2) has to restart on every appearance.
    let _ = app.emit("shelf:shown", ());
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(SHELF_WINDOW) {
        let _ = window.hide();
    }
    // Lets the auto-hide timer stop rather than fire against a window already gone.
    let _ = app.emit("shelf:hidden", ());
}

/// PRD F2.2 — the toggle hotkey shows the shelf, or hides it if it is already up.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let visible = app
        .get_webview_window(SHELF_WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);

    if visible {
        hide(app);
    } else {
        show(app);
    }
}

/// Resize the shelf to fit its content, up to DESIGN S3's 80% of the screen.
pub fn set_height<R: Runtime>(app: &AppHandle<R>, logical_height: f64) {
    let Some(window) = app.get_webview_window(SHELF_WINDOW) else {
        return;
    };
    let _ = window.set_size(tauri::LogicalSize::new(SHELF_WIDTH, logical_height));
    let _ = position(app, &window);
}

/// DESIGN S3: 208 px wide.
const SHELF_WIDTH: f64 = 208.0;
/// DESIGN S3: 12 px from the screen edge.
const SHELF_MARGIN: f64 = 12.0;

/// Park the shelf against the configured screen edge, vertically centered (DESIGN S3).
fn position<R: Runtime>(app: &AppHandle<R>, window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    let settings = crate::settings::load(app).unwrap_or_default();

    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or(app.primary_monitor()?);

    let Some(monitor) = monitor else {
        return Ok(());
    };

    let scale = monitor.scale_factor();
    let area = monitor.size();
    let origin = monitor.position();
    let size = window.outer_size()?;
    let margin = (SHELF_MARGIN * scale).round() as i32;

    let x = if settings.shelf_side_is_left() {
        origin.x + margin
    } else {
        origin.x + area.width as i32 - size.width as i32 - margin
    };
    let y = origin.y + ((area.height as i32 - size.height as i32) / 2);

    window.set_position(tauri::PhysicalPosition::new(x, y))
}

/// Open the store, adopt any captures from before it existed, and start the expiry job.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), ShelfError> {
    let dir = app_data(app)?;
    let store = Store::open(&dir)?;

    let adopted = adopt_orphan_captures(&dir, &store, &crate::settings::load(app).unwrap_or_default());
    if adopted > 0 {
        log::info!("adopted {adopted} capture(s) that predate the shelf database");
    }

    app.manage(store);
    // `drag/` is purged by the sweep, which runs immediately and then on its timer.
    expiry::start(app);

    Ok(())
}

/// Bring `captures/*.png` written before the database existed onto the shelf.
///
/// Phase 1 wrote captures straight to disk with no row. Without this they would be
/// invisible to the user but still counted against their disk, and the expiry job would
/// never clean them up.
fn adopt_orphan_captures(app_data: &Path, store: &Store, settings: &Settings) -> usize {
    let Ok(existing) = files::list_capture_files(app_data) else {
        return 0;
    };

    let mut adopted = 0;
    for (path, created_at) in existing {
        let as_string = path.to_string_lossy().into_owned();
        if store.has_path(&as_string).unwrap_or(true) {
            continue;
        }

        let Ok(image) = image::open(&path) else {
            log::warn!("{} is not a readable image; skipping", path.display());
            continue;
        };
        let rgba = image.to_rgba8();

        let id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(String::from)
            .unwrap_or_else(store::new_id);

        let Ok(thumb_path) = thumbs::write(app_data, &id, &rgba) else {
            continue;
        };

        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or_default();
        // Expire relative to when it was taken, not now, so an old capture does not get a
        // fresh 24 hours just because the database arrived today.
        let remaining = created_at + settings.item_ttl_ms() - store::now_ms();

        if store
            .insert(
                NewItem {
                    source: Source::Capture,
                    origin_device: None,
                    file_name: files::friendly_name(created_at),
                    path: path.clone(),
                    thumb_path,
                    width: rgba.width(),
                    height: rgba.height(),
                    bytes,
                },
                Some(remaining.max(0)),
            )
            .is_ok()
        {
            adopted += 1;
        }
    }

    adopted
}

/// Stub: PRD F4 (send to phone) lands in Phase 5.
pub fn send_last_to_phone<R: Runtime>(_app: &AppHandle<R>) {
    log::info!("shelf::send_last_to_phone() — stub until Phase 5");
}

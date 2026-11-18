//! Catch other screenshots (PRD F1.7, docs/designs/catch-screenshots.md).
//!
//! When `settings.catch_other_screenshots` is on, the OS screenshot folder is watched with
//! native file events (`notify`). A new screenshot there is copied onto the shelf, never
//! moved: the original file is not touched. The clipboard is never read.
//!
//! Per event: extension → coalesce per path → skip Hopshot's own writes → settle → (macOS)
//! screenshot flag → decode → import as `Source::Folder`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// How long a file's size must stay unchanged before it counts as written.
const SETTLE_QUIET: Duration = Duration::from_millis(300);
/// Give up waiting for a still-growing file after this, and try it once anyway.
const SETTLE_CAP: Duration = Duration::from_secs(5);
const SETTLE_POLL: Duration = Duration::from_millis(100);
/// A file already imported or rejected is not looked at again for this long.
const HANDLED_FOR: Duration = Duration::from_secs(60);
/// Paths Hopshot itself wrote into the watched folder (Save as…) are ignored this long.
const OWN_WRITE_FOR: Duration = Duration::from_secs(600);
/// macOS sets the screenshot flag just after the file lands; how many times to look.
const FLAG_TRIES: u32 = 5;
const FLAG_WAIT: Duration = Duration::from_millis(200);

/// What Settings shows under the switch.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub on: bool,
    /// The folder being watched (or that would be).
    pub folder: Option<String>,
    /// Something the user should know or fix, e.g. a denied permission.
    pub problem: Option<String>,
}

struct Running {
    _watcher: RecommendedWatcher,
    /// The screenshot folder (the target, even while its parent is watched).
    folder: PathBuf,
    /// True while only the parent is watched because the folder doesn't exist yet.
    waiting_for_folder: bool,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    status: WatchStatus,
    in_flight: HashSet<PathBuf>,
    handled: HashMap<PathBuf, (u64, Option<SystemTime>, Instant)>,
    own_writes: HashMap<PathBuf, Instant>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

fn lock() -> std::sync::MutexGuard<'static, State> {
    state().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Current state for Settings.
pub fn status() -> WatchStatus {
    lock().status.clone()
}

/// Remember a path Hopshot wrote, so writing into the watched folder never re-imports.
pub fn note_own_write(path: &Path) {
    let mut st = lock();
    st.own_writes.insert(path.to_path_buf(), Instant::now());
}

/// Start, stop or re-point the watcher to match the setting. Idempotent; called at launch
/// and whenever a setting is saved.
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let wanted = crate::settings::load(app).unwrap_or_default().catch_other_screenshots;
    if !wanted {
        let mut st = lock();
        if st.running.take().is_some() {
            log::info!("stopped watching for screenshots");
        }
        st.status = WatchStatus::default();
        return;
    }

    let (folder, note) = crate::platform::screenshot_folder();
    {
        let st = lock();
        if let Some(running) = &st.running {
            if running.folder == folder && !(running.waiting_for_folder && folder.is_dir()) {
                return;
            }
        }
    }
    start(app, folder, note);
}

fn start<R: Runtime>(app: &AppHandle<R>, folder: PathBuf, note: Option<String>) {
    let shown = folder.display().to_string();
    let waiting_for_folder = !folder.is_dir();
    let target = if waiting_for_folder {
        match folder.parent().filter(|parent| parent.is_dir()) {
            Some(parent) => parent.to_path_buf(),
            None => {
                set_status(true, &shown, Some("Can't find your Screenshots folder.".to_string()));
                lock().running = None;
                return;
            }
        }
    } else {
        // Touch the folder now, so macOS asks for Desktop access when the switch is turned
        // on rather than in the middle of a screenshot, and a denial is seen right away.
        if let Err(error) = std::fs::read_dir(&folder) {
            log::warn!("cannot read {shown}: {error}");
            let problem = if error.kind() == std::io::ErrorKind::PermissionDenied {
                format!(
                    "Hopshot can't see {shown}. Allow it in System Settings → Privacy & Security → Files and Folders."
                )
            } else {
                format!("Hopshot can't watch {shown}.")
            };
            set_status(true, &shown, Some(problem));
            lock().running = None;
            return;
        }
        folder.clone()
    };

    let handle = app.clone();
    let watched_for = folder.clone();
    let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| match result {
        Ok(event) => on_event(&handle, &watched_for, event),
        Err(error) => log::warn!("screenshot watcher error: {error}"),
    });

    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(error) => {
            log::warn!("could not create the screenshot watcher: {error}");
            set_status(true, &shown, Some(format!("Hopshot can't watch {shown}.")));
            return;
        }
    };
    if let Err(error) = watcher.watch(&target, RecursiveMode::NonRecursive) {
        log::warn!("could not watch {}: {error}", target.display());
        set_status(true, &shown, Some(format!("Hopshot can't watch {shown}.")));
        lock().running = None;
        return;
    }

    log::info!(
        "watching {} for screenshots{}",
        target.display(),
        if waiting_for_folder { " (until the Screenshots folder appears)" } else { "" }
    );
    let mut st = lock();
    st.running = Some(Running { _watcher: watcher, folder, waiting_for_folder });
    st.status = WatchStatus { on: true, folder: Some(shown), problem: note };
}

fn set_status(on: bool, folder: &str, problem: Option<String>) {
    lock().status = WatchStatus { on, folder: Some(folder.to_string()), problem };
}

/* ── Events ──────────────────────────────────────────────────────────────── */

fn on_event<R: Runtime>(app: &AppHandle<R>, folder: &Path, event: Event) {
    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
        return;
    }

    for path in &event.paths {
        // The Screenshots folder appeared while its parent was watched: re-point.
        if path == folder && path.is_dir() {
            let app = app.clone();
            std::thread::spawn(move || sync(&app));
            continue;
        }
        // Only files directly in the screenshot folder, and only the side of a rename
        // that exists.
        if path.parent() != Some(folder) || !path.is_file() || !is_candidate(path) {
            continue;
        }
        if !claim(path) {
            continue;
        }
        let app = app.clone();
        let path = path.clone();
        std::thread::spawn(move || {
            let outcome = handle_file(&app, &path);
            release(&path, outcome);
        });
    }
}

/// Image types the shelf can decode. HEIC is skipped: the `image` crate can't read it.
/// macOS writes a hidden `.Screenshot…` file first and renames it, so dotfiles are ignored.
fn is_candidate(path: &Path) -> bool {
    let hidden = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_none_or(|name| name.starts_with('.'));
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase);
    !hidden && matches!(ext.as_deref(), Some("png" | "jpg" | "jpeg"))
}

/// Take a path for processing unless it is already settling, was handled recently with the
/// same size and mtime, or is one Hopshot wrote itself. Several events arrive per file.
fn claim(path: &Path) -> bool {
    let mut st = lock();
    let now = Instant::now();
    st.handled.retain(|_, (_, _, at)| now.duration_since(*at) < HANDLED_FOR);
    st.own_writes.retain(|_, at| now.duration_since(*at) < OWN_WRITE_FOR);

    if st.own_writes.contains_key(path) || st.in_flight.contains(path) {
        return false;
    }
    if let Some((size, mtime, _)) = st.handled.get(path) {
        if fingerprint(path) == Some((*size, *mtime)) {
            return false;
        }
    }
    st.in_flight.insert(path.to_path_buf())
}

fn fingerprint(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

/// What happened to one file.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    /// Imported, or definitively not ours: remember it so repeats are skipped.
    Done,
    /// Maybe too early (no screenshot flag yet): a later event may still bring it in.
    NotYet,
}

fn release(path: &Path, outcome: Outcome) {
    let mut st = lock();
    st.in_flight.remove(path);
    if outcome == Outcome::Done {
        if let Some((size, mtime)) = fingerprint(path) {
            st.handled.insert(path.to_path_buf(), (size, mtime, Instant::now()));
        }
    }
}

fn handle_file<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Outcome {
    settle(path);

    if !has_screenshot_flag(path) {
        return if crate::platform::SCREENSHOT_FLAG_MAY_LAG { Outcome::NotYet } else { Outcome::Done };
    }

    let image = match image::open(path) {
        Ok(image) => image.to_rgba8(),
        Err(error) => {
            log::warn!("skipped a screenshot that could not be decoded: {error}");
            return Outcome::Done;
        }
    };

    log::info!("caught a screenshot from the screenshot folder");
    crate::capture::import_external(app, &image);
    Outcome::Done
}

fn has_screenshot_flag(path: &Path) -> bool {
    for attempt in 0..FLAG_TRIES {
        if crate::platform::is_os_screenshot(path) {
            return true;
        }
        if !crate::platform::SCREENSHOT_FLAG_MAY_LAG || attempt + 1 == FLAG_TRIES {
            break;
        }
        std::thread::sleep(FLAG_WAIT);
    }
    false
}

/// Wait until the file stops growing (quiet for [`SETTLE_QUIET`]), at most [`SETTLE_CAP`].
fn settle(path: &Path) {
    let started = Instant::now();
    let mut last = std::fs::metadata(path).map(|m| m.len()).ok();
    let mut quiet_since = Instant::now();
    while started.elapsed() < SETTLE_CAP {
        std::thread::sleep(SETTLE_POLL);
        let now = std::fs::metadata(path).map(|m| m.len()).ok();
        if now != last || now == Some(0) {
            last = now;
            quiet_since = Instant::now();
        } else if quiet_since.elapsed() >= SETTLE_QUIET {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_visible_png_and_jpeg_files_are_candidates() {
        assert!(is_candidate(Path::new("/d/Screenshot 2026-11-18 at 10.00.00.png")));
        assert!(is_candidate(Path::new("/d/Screenshot (3).PNG")));
        assert!(is_candidate(Path::new("/d/shot.jpeg")));
        assert!(is_candidate(Path::new("/d/shot.JPG")));
        assert!(!is_candidate(Path::new("/d/.Screenshot 2026-11-18 at 10.00.00.png")));
        assert!(!is_candidate(Path::new("/d/Screenshot.heic")));
        assert!(!is_candidate(Path::new("/d/notes.txt")));
        assert!(!is_candidate(Path::new("/d/no-extension")));
    }

    #[test]
    fn a_path_is_claimed_once_until_released_and_own_writes_are_skipped() {
        let dir = std::env::temp_dir().join(format!("hopshot-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("Screenshot.png");
        std::fs::write(&file, b"png").expect("write");

        assert!(claim(&file), "first event takes it");
        assert!(!claim(&file), "a second event while settling is dropped");
        release(&file, Outcome::Done);
        assert!(!claim(&file), "handled with the same size and mtime: skipped");

        std::fs::write(&file, b"a different, longer file").expect("rewrite");
        assert!(claim(&file), "a changed file is looked at again");
        release(&file, Outcome::NotYet);
        assert!(claim(&file), "not-yet is not remembered, so a later event retries");
        release(&file, Outcome::NotYet);

        let saved = dir.join("Saved.png");
        std::fs::write(&saved, b"png").expect("write");
        note_own_write(&saved);
        assert!(!claim(&saved), "Hopshot's own Save as… is never re-imported");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settle_returns_for_a_finished_file() {
        let dir = std::env::temp_dir().join(format!("hopshot-settle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("done.png");
        std::fs::write(&file, b"finished").expect("write");
        let started = Instant::now();
        settle(&file);
        assert!(started.elapsed() < SETTLE_CAP, "a stable file settles quickly");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

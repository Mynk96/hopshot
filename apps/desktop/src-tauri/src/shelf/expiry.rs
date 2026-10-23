//! The expiry job (PRD F2.7, F2.8, ARCHITECTURE §5.3).
//!
//! Runs once at startup and every 10 minutes after. Two rules, in order:
//!
//! 1. **Expiry** — rows past `expires_at` go, along with their files. Pinned rows have a
//!    NULL `expires_at` and are never matched (PRD F2.11).
//! 2. **Capacity** — the oldest *unpinned* rows beyond the plan's capacity go too, so a
//!    shelf full of pinned items cannot be silently emptied by new captures (PRD F2.8).
//!
//! "Nothing is left in app-data after expiry" (F2.7) means the row, the capture, the
//! thumbnail and any copy staged for a drag all go, so file deletion is part of the sweep
//! rather than a later cleanup.

use std::fs;
use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::limits::Plan;
use crate::shelf::store::{Item, Store, StoreError};

/// ARCHITECTURE §5.3: "runs at start and every 10 min".
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// What one sweep removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub expired: usize,
    pub over_capacity: usize,
}

impl Swept {
    pub fn total(&self) -> usize {
        self.expired + self.over_capacity
    }
}

/// Delete expired rows, then trim to capacity. Returns what went.
pub fn sweep(store: &Store, app_data: &Path, plan: Plan, now: i64) -> Result<Swept, StoreError> {
    let expired = store.take_expired(now)?;
    for item in &expired {
        remove_files(app_data, item);
    }

    let over_capacity = store.take_over_capacity(plan)?;
    for item in &over_capacity {
        remove_files(app_data, item);
    }

    Ok(Swept {
        expired: expired.len(),
        over_capacity: over_capacity.len(),
    })
}

/// Delete an item's capture, thumbnail and staged drag copy. Best-effort: a missing file is
/// already the desired end state, and a locked one must not stop the rest of the sweep.
pub fn remove_files(app_data: &Path, item: &Item) {
    for path in [&item.path, &item.thumb_path] {
        let path = Path::new(path);
        if path.exists() {
            if let Err(error) = fs::remove_file(path) {
                log::warn!("could not delete {}: {error}", path.display());
            }
        }
    }

    // F2.7 is "nothing is left in app-data after expiry", and a staged copy is usually a
    // hard link: without this the expired capture's pixels stay readable in `drag/`.
    crate::shelf::files::remove_staged(app_data, &item.id);
}

/// Run the sweep now and then on a timer for the lifetime of the app.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    run_once(app);

    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(SWEEP_INTERVAL);
        run_once(&handle);
    });
}

fn run_once<R: Runtime>(app: &AppHandle<R>) {
    // The sweep runs on a timer, so it can fire during shutdown when the store is gone.
    let Some(store) = app.try_state::<Store>() else {
        log::warn!("the expiry sweep ran before the shelf store was ready");
        return;
    };
    let Ok(app_data) = crate::shelf::app_data(app) else {
        log::warn!("the expiry sweep could not find the app data folder");
        return;
    };
    let plan = crate::license::current_plan(app);

    // ARCHITECTURE §5.3 promises `drag/` is purged hourly, so it has to happen on the timer
    // rather than only at startup — a session that stays open never reaches the next launch.
    crate::shelf::files::purge_drag_dir(&app_data, crate::shelf::DRAG_STAGING_TTL_MS);

    match sweep(&store, &app_data, plan, crate::shelf::store::now_ms()) {
        Ok(swept) if swept.total() > 0 => {
            log::info!(
                "expiry: removed {} expired and {} over capacity",
                swept.expired,
                swept.over_capacity
            );
            let _ = app.emit("shelf:changed", ());

            // DESIGN §5 has copy for the capacity case; silent expiry is expected, so only
            // the capacity drop is worth telling the user about.
            if swept.over_capacity > 0 {
                let _ = app.emit(
                    "toast",
                    serde_json::json!({
                        "kind": "info",
                        "text": format!(
                            "Shelf holds {}. Oldest one made room.",
                            crate::shelf::store::capacity_for(plan)
                        ),
                    }),
                );
            }
        }
        Ok(_) => {}
        Err(error) => log::warn!("the expiry sweep failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shelf::files;
    use crate::shelf::store::{NewItem, Source};
    use std::path::PathBuf;

    const MINUTE_MS: i64 = 60 * 1000;
    const DAY_MS: i64 = 24 * 60 * MINUTE_MS;

    /// A store backed by real files in a temp dir, so file deletion can be asserted.
    struct Fixture {
        dir: PathBuf,
        store: Store,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("hopshot-expiry-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join("captures")).expect("captures dir");
            fs::create_dir_all(dir.join("thumbs")).expect("thumbs dir");
            Fixture {
                store: Store::open(&dir).expect("store"),
                dir,
            }
        }

        fn add(&self, name: &str, ttl: Option<i64>) -> Item {
            let path = self.dir.join("captures").join(name);
            let thumb = self.dir.join("thumbs").join(name);
            fs::write(&path, b"png").expect("capture file");
            fs::write(&thumb, b"png").expect("thumb file");

            self.store
                .insert(
                    NewItem {
                        source: Source::Capture,
                        origin_device: None,
                        file_name: name.to_string(),
                        path,
                        thumb_path: thumb,
                        width: 10,
                        height: 10,
                        bytes: 3,
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

    #[test]
    fn expired_items_and_their_files_are_removed() {
        let f = Fixture::new("expired");
        let doomed = f.add("old.png", Some(-MINUTE_MS)); // already past
        let keeper = f.add("new.png", Some(DAY_MS));

        let swept = sweep(&f.store, &f.dir, Plan::Lifetime, crate::shelf::store::now_ms()).expect("sweep");
        assert_eq!(swept.expired, 1);

        // PRD F2.7: "Nothing is left in app-data after expiry."
        assert!(!Path::new(&doomed.path).exists());
        assert!(!Path::new(&doomed.thumb_path).exists());
        assert!(Path::new(&keeper.path).exists());

        let left: Vec<_> = f.store.list().expect("list").into_iter().map(|i| i.id).collect();
        assert_eq!(left, [keeper.id]);
    }

    /// CLAUDE.md rule 1 and PRD F2.7: a staged drag copy is a hard link to the capture, so
    /// an expired item whose staged copy survived would still be readable at full
    /// resolution inside app-data.
    #[test]
    fn a_staged_drag_copy_does_not_survive_expiry() {
        let f = Fixture::new("staged");
        let doomed = f.add("old.png", Some(-MINUTE_MS));
        let keeper = f.add("new.png", Some(DAY_MS));

        // Both items share one friendly name, as two captures from the same second do.
        let friendly = files::friendly_name(crate::shelf::store::now_ms());
        let staged = files::stage_for_drag(&f.dir, &doomed.id, &doomed.path, &friendly)
            .expect("stage the doomed item");
        let kept = files::stage_for_drag(&f.dir, &keeper.id, &keeper.path, &friendly)
            .expect("stage the keeper");
        assert!(staged.exists() && kept.exists());

        let swept = sweep(&f.store, &f.dir, Plan::Lifetime, crate::shelf::store::now_ms()).expect("sweep");
        assert_eq!(swept.expired, 1);

        assert!(!staged.exists(), "expired pixels left behind in drag/");
        assert!(
            !files::drag_item_dir(&f.dir, &doomed.id).exists(),
            "the staging directory itself must go too"
        );
        // A live item's staged copy is still needed for its next drag.
        assert!(kept.exists());
    }

    #[test]
    fn pinned_items_never_expire() {
        let f = Fixture::new("pinned");
        let pinned = f.add("kept.png", None);
        f.add("gone.png", Some(-MINUTE_MS));

        let swept = sweep(&f.store, &f.dir, Plan::Lifetime, crate::shelf::store::now_ms()).expect("sweep");
        assert_eq!(swept.expired, 1);

        assert!(Path::new(&pinned.path).exists());
        assert_eq!(f.store.count().expect("count"), 1);
    }

    #[test]
    fn capacity_drops_the_oldest_unpinned_items() {
        let f = Fixture::new("capacity");
        let capacity = crate::shelf::store::capacity_for(Plan::Lifetime);

        let mut inserted = Vec::new();
        for n in 0..capacity + 3 {
            inserted.push(f.add(&format!("{n}.png"), Some(DAY_MS)));
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        let swept = sweep(&f.store, &f.dir, Plan::Lifetime, crate::shelf::store::now_ms()).expect("sweep");
        assert_eq!(swept.over_capacity, 3, "three past the cap");
        assert_eq!(f.store.count().expect("count"), capacity);

        // The three oldest went, and their files with them.
        for item in inserted.iter().take(3) {
            assert!(!Path::new(&item.path).exists(), "{} should be gone", item.file_name);
        }
        assert!(Path::new(&inserted[3].path).exists());
    }

    /// PRD F2.8 says the oldest *unpinned* item drops off, so pinned items must not be
    /// counted as candidates — otherwise a shelf of pinned items would evict them.
    #[test]
    fn pinned_items_are_exempt_from_capacity() {
        let f = Fixture::new("pinned-capacity");
        let capacity = crate::shelf::store::capacity_for(Plan::Lifetime);

        let mut pinned = Vec::new();
        for n in 0..capacity + 5 {
            pinned.push(f.add(&format!("pin{n}.png"), None));
        }

        let swept = sweep(&f.store, &f.dir, Plan::Lifetime, crate::shelf::store::now_ms()).expect("sweep");
        assert_eq!(swept.over_capacity, 0, "pinned items are never evicted");
        assert_eq!(f.store.count().expect("count"), capacity + 5);
        for item in &pinned {
            assert!(Path::new(&item.path).exists());
        }
    }

    #[test]
    fn a_quiet_shelf_sweeps_to_nothing() {
        let f = Fixture::new("quiet");
        f.add("a.png", Some(DAY_MS));

        let swept = sweep(&f.store, &f.dir, Plan::Lifetime, crate::shelf::store::now_ms()).expect("sweep");
        assert_eq!(swept, Swept::default());
        assert_eq!(swept.total(), 0);
    }

    #[test]
    fn a_missing_file_does_not_stop_the_sweep() {
        let f = Fixture::new("missing-file");
        let item = f.add("gone.png", Some(-MINUTE_MS));
        fs::remove_file(&item.path).expect("remove ahead of the sweep");

        let swept = sweep(&f.store, &f.dir, Plan::Lifetime, crate::shelf::store::now_ms()).expect("sweep");
        assert_eq!(swept.expired, 1);
        assert_eq!(f.store.count().expect("count"), 0);
    }
}

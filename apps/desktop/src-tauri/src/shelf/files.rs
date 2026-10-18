//! Capture files on disk: listing them, and staging a copy with a friendly name for a
//! native drag (ARCHITECTURE §5.3).
//!
//! Phase 2.1 replaces the directory listing with the SQLite store; the naming and the
//! `drag/` staging stay, because they are what the OS shows the drop target.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Local, TimeZone};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FileError {
    #[error("the capture folder could not be read: {0}")]
    Read(String),
    #[error("the file could not be staged for dragging: {0}")]
    Stage(String),
    #[error("that item is no longer on the shelf")]
    Missing,
}

/// `captures/` under the app-data dir.
pub fn captures_dir(app_data: &Path) -> PathBuf {
    app_data.join("captures")
}

/// `drag/` — staging copies with friendly names, purged hourly (ARCHITECTURE §5.3).
pub fn drag_dir(app_data: &Path) -> PathBuf {
    app_data.join("drag")
}

/// `drag/{item_id}/` — one staging directory per item.
///
/// The friendly name has one-second resolution, so two captures taken in the same second
/// share it. Staging them side by side in `drag/` would make the second one overwrite the
/// first, and dragging the first would then hand the drop target the second one's pixels
/// under the first one's name. The name is fixed by PRD F2.4; the path is not, so the id
/// goes in the path.
pub fn drag_item_dir(app_data: &Path, item_id: &str) -> PathBuf {
    drag_dir(app_data).join(item_id)
}

/// Capture files on disk with their timestamps, for adopting rows written before the
/// database existed. The store is the source of truth once they are adopted.
pub fn list_capture_files(app_data: &Path) -> Result<Vec<(PathBuf, i64)>, FileError> {
    let dir = captures_dir(app_data);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir).map_err(|e| FileError::Read(e.to_string()))?;
    let mut found = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| FileError::Read(e.to_string()))?;

        // Phase 1 named captures after their unix-ms timestamp; anything else falls back
        // to the filesystem.
        let created_at = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.parse::<i64>().ok())
            .unwrap_or_else(|| modified_ms(&metadata) as i64);

        found.push((path, created_at));
    }

    Ok(found)
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// `Screenshot 2026-09-29 at 14.03.22.png` (PRD F2.4).
///
/// Local time, because the name is read by a human looking for the shot they just took.
/// Dots rather than colons in the time: Windows forbids `:` in file names, and macOS
/// Finder renders a `:` as `/`.
pub fn friendly_name(created_at_ms: i64) -> String {
    match Local.timestamp_millis_opt(created_at_ms).single() {
        Some(when) => when.format("Screenshot %Y-%m-%d at %H.%M.%S.png").to_string(),
        // Unrepresentable timestamps are not worth failing a drag over.
        None => format!("Screenshot {created_at_ms}.png"),
    }
}

/// Put a copy of the capture in the item's `drag/` directory under its friendly name and
/// return that path.
///
/// The drop target reads the file name off the path, so the staged copy is what gives the
/// user `Screenshot 2026-09-29 at 14.03.22.png` instead of `1791264924737.png`.
///
/// A hard link is tried first — same volume, so it normally succeeds and costs nothing.
pub fn stage_for_drag(
    app_data: &Path,
    item_id: &str,
    capture_path: &str,
    file_name: &str,
) -> Result<PathBuf, FileError> {
    let source = PathBuf::from(capture_path);
    if !source.exists() {
        return Err(FileError::Missing);
    }

    let dir = drag_item_dir(app_data, item_id);
    fs::create_dir_all(&dir).map_err(|e| FileError::Stage(e.to_string()))?;

    let staged = dir.join(file_name);

    // A stale link from an earlier drag of this item would otherwise win.
    if staged.exists() {
        fs::remove_file(&staged).map_err(|e| FileError::Stage(e.to_string()))?;
    }

    if fs::hard_link(&source, &staged).is_err() {
        // Different volume, or the filesystem has no links: a copy works everywhere.
        fs::copy(&source, &staged).map_err(|e| FileError::Stage(e.to_string()))?;
    }

    Ok(staged)
}

/// Drop one item's staged drag copy (PRD F2.7).
///
/// The staged file is normally a hard link to the capture, so deleting the capture alone
/// leaves the inode — and the full-resolution pixels — readable in `drag/`. Best-effort:
/// an absent copy is already the desired end state.
pub fn remove_staged(app_data: &Path, item_id: &str) {
    let dir = drag_item_dir(app_data, item_id);
    if !dir.exists() {
        return;
    }
    if let Err(error) = fs::remove_dir_all(&dir) {
        log::warn!("could not delete {}: {error}", dir.display());
    }
}

/// Delete staged drag copies older than an hour (ARCHITECTURE §5.3 "purged hourly").
pub fn purge_drag_dir(app_data: &Path, max_age_ms: u64) {
    let dir = drag_dir(app_data);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default();

    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let path = entry.path();

        // A staging directory is judged by its own age rather than by the files inside it:
        // a hard link reports the capture's mtime, not the moment it was staged, so an item
        // captured hours ago would look stale the instant it was staged for a drag.
        if metadata.is_dir() {
            if now.saturating_sub(modified_ms(&metadata)) > max_age_ms {
                let _ = fs::remove_dir_all(&path);
            }
        } else if now.saturating_sub(modified_ms(&metadata)) > max_age_ms {
            // Copies staged flat in `drag/` by an earlier build.
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_names_follow_prd_f2_4() {
        // Build the expected string from the same local clock the function uses, so the
        // test is not pinned to the machine's timezone.
        let stamp = 1_727_618_602_000; // 2024-09-29T14:03:22Z
        let name = friendly_name(stamp);

        assert!(name.starts_with("Screenshot "), "{name}");
        assert!(name.ends_with(".png"), "{name}");
        assert!(name.contains(" at "), "{name}");
        // No character Windows forbids in a file name.
        assert!(
            !name.contains(':') && !name.contains('/') && !name.contains('\\'),
            "{name}"
        );
    }

    #[test]
    fn friendly_names_are_fixed_width() {
        // "Screenshot YYYY-MM-DD at HH.MM.SS.png"
        assert_eq!(friendly_name(0).len(), "Screenshot 1970-01-01 at 00.00.00.png".len());
        assert_eq!(friendly_name(1_727_618_602_000).len(), friendly_name(0).len());
    }

    #[test]
    fn capture_files_are_found_with_their_timestamps() {
        let dir = std::env::temp_dir().join(format!("hopshot-list-{}", std::process::id()));
        let captures = captures_dir(&dir);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&captures).expect("temp captures dir");

        fs::write(captures.join("1727618602000.png"), b"x").expect("write");
        // Not a capture: must be ignored.
        fs::write(captures.join("notes.txt"), b"x").expect("write");

        let found = list_capture_files(&dir).expect("list");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, 1_727_618_602_000);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn listing_a_missing_folder_is_empty_not_an_error() {
        let nowhere = std::env::temp_dir().join("hopshot-does-not-exist-xyz");
        assert!(list_capture_files(&nowhere).expect("empty list").is_empty());
    }

    #[test]
    fn staging_gives_the_file_its_friendly_name() {
        let dir = std::env::temp_dir().join(format!("hopshot-drag-{}", std::process::id()));
        let captures = captures_dir(&dir);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&captures).expect("temp captures dir");

        let source = captures.join("1727618602000.png");
        fs::write(&source, b"png-bytes").expect("write");
        let friendly = "Screenshot 2024-09-29 at 14.03.22.png";

        let staged =
            stage_for_drag(&dir, "item1", &source.to_string_lossy(), friendly).expect("stage");
        assert_eq!(staged.file_name().and_then(|n| n.to_str()), Some(friendly));
        assert_eq!(fs::read(&staged).expect("read staged"), b"png-bytes");

        // Dragging the same item twice must not fail on the existing file.
        let again =
            stage_for_drag(&dir, "item1", &source.to_string_lossy(), friendly).expect("again");
        assert_eq!(again, staged);

        fs::remove_dir_all(&dir).ok();
    }

    /// Two captures from the same second share a friendly name (it has one-second
    /// resolution), so staging them must not land on one path — the first item's drag would
    /// otherwise carry the second item's pixels.
    #[test]
    fn items_sharing_a_friendly_name_stage_separately() {
        let dir = std::env::temp_dir().join(format!("hopshot-drag-collide-{}", std::process::id()));
        let captures = captures_dir(&dir);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&captures).expect("temp captures dir");

        let first = captures.join("1727618602000.png");
        let second = captures.join("1727618602400.png");
        fs::write(&first, b"first-bytes").expect("write");
        fs::write(&second, b"second-bytes").expect("write");
        let friendly = friendly_name(1_727_618_602_000);
        assert_eq!(friendly, friendly_name(1_727_618_602_400), "same second");

        let a = stage_for_drag(&dir, "aaa", &first.to_string_lossy(), &friendly).expect("stage a");
        let b = stage_for_drag(&dir, "bbb", &second.to_string_lossy(), &friendly).expect("stage b");

        assert_ne!(a, b);
        // PRD F2.4: the name the drop target sees is still the friendly one.
        assert_eq!(a.file_name(), b.file_name());
        assert_eq!(fs::read(&a).expect("read a"), b"first-bytes");
        assert_eq!(fs::read(&b).expect("read b"), b"second-bytes");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removing_a_staged_copy_leaves_nothing_behind() {
        let dir = std::env::temp_dir().join(format!("hopshot-drag-remove-{}", std::process::id()));
        let captures = captures_dir(&dir);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&captures).expect("temp captures dir");

        let source = captures.join("1727618602000.png");
        fs::write(&source, b"png-bytes").expect("write");
        let staged =
            stage_for_drag(&dir, "gone", &source.to_string_lossy(), "Shot.png").expect("stage");

        remove_staged(&dir, "gone");
        assert!(!staged.exists());
        assert!(!drag_item_dir(&dir, "gone").exists());
        // A second call on an already-clean item must not complain.
        remove_staged(&dir, "gone");

        fs::remove_dir_all(&dir).ok();
    }

    /// The hourly purge has to reach inside the per-item directories, which is where staged
    /// copies live now.
    #[test]
    fn the_purge_clears_aged_staging_directories() {
        let dir = std::env::temp_dir().join(format!("hopshot-drag-purge-{}", std::process::id()));
        let captures = captures_dir(&dir);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&captures).expect("temp captures dir");

        let source = captures.join("1727618602000.png");
        fs::write(&source, b"png-bytes").expect("write");
        let staged =
            stage_for_drag(&dir, "stale", &source.to_string_lossy(), "Shot.png").expect("stage");
        // A flat copy, as an older build would have left it.
        let flat = drag_dir(&dir).join("Flat.png");
        fs::write(&flat, b"png-bytes").expect("write flat");

        // Nothing has aged out yet.
        purge_drag_dir(&dir, u64::MAX);
        assert!(staged.exists());
        assert!(flat.exists());

        std::thread::sleep(std::time::Duration::from_millis(20));
        purge_drag_dir(&dir, 0);
        assert!(!staged.exists());
        assert!(!drag_item_dir(&dir, "stale").exists());
        assert!(!flat.exists());

        fs::remove_dir_all(&dir).ok();
    }
}

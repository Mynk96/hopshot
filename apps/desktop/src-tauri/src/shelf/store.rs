//! `shelf.db` — the SQLite store from ARCHITECTURE §5.3.
//!
//! Every shelf read and write goes through here. The connection is wrapped in a mutex and
//! held in Tauri state: SQLite handles concurrency itself, but serialising at the Rust edge
//! keeps the capacity rule (read count, then delete the overflow) atomic with respect to
//! the expiry job running on its own timer.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::limits::Plan;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("the shelf database could not be opened: {0}")]
    Open(String),
    #[error("the shelf database rejected a query: {0}")]
    Query(String),
    #[error("that item is not on the shelf")]
    Missing,
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Query(error.to_string())
    }
}

/// Where an item came from (ARCHITECTURE §5.3 `source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Capture,
    Clipboard,
    Folder,
    Phone,
    Computer,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Capture => "capture",
            Source::Clipboard => "clipboard",
            Source::Folder => "folder",
            Source::Phone => "phone",
            Source::Computer => "computer",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "clipboard" => Source::Clipboard,
            "folder" => Source::Folder,
            "phone" => Source::Phone,
            "computer" => Source::Computer,
            _ => Source::Capture,
        }
    }
}

/// A row of `items`, as the shelf UI sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub created_at: i64,
    /// `None` means pinned: it never expires (PRD F2.11).
    pub expires_at: Option<i64>,
    pub source: Source,
    pub origin_device: Option<String>,
    pub file_name: String,
    pub path: String,
    pub thumb_path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// PRD F3 — set once this item has been published as a drop.
    pub drop_id: Option<String>,
    /// base64url, local only: it is the decryption key and never leaves this machine
    /// except inside a URL fragment (ARCHITECTURE §6).
    pub drop_key: Option<String>,
    pub drop_delete_token: Option<String>,
    pub drop_expires_at: Option<i64>,
    /// `originals/{id}.png` once the item has been edited (migration 1). Re-edits always
    /// start from this, never from the edited `path`.
    pub original_path: Option<String>,
    /// The background style applied to `path`, as JSON (`shelf::background::Style`).
    pub style: Option<String>,
    /// Set between the two transactions of a background Done. A row that still has it at
    /// startup had its Done interrupted, and recovery rolls it forward.
    #[serde(skip)]
    pub pending_style: Option<String>,
    /// Over `maxImageBytes` from `config/limits.json`, so it is never uploaded: auto-sync
    /// skips it and the card shows "Too big to sync".
    pub too_big_to_send: bool,
}

impl Item {
    pub fn is_pinned(&self) -> bool {
        self.expires_at.is_none()
    }

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Item {
            id: row.get("id")?,
            created_at: row.get("created_at")?,
            expires_at: row.get("expires_at")?,
            source: Source::parse(&row.get::<_, String>("source")?),
            origin_device: row.get("origin_device")?,
            file_name: row.get("file_name")?,
            path: row.get("path")?,
            thumb_path: row.get("thumb_path")?,
            width: row.get::<_, i64>("width")? as u32,
            height: row.get::<_, i64>("height")? as u32,
            bytes: row.get::<_, i64>("bytes")? as u64,
            drop_id: row.get("drop_id")?,
            drop_key: row.get("drop_key")?,
            drop_delete_token: row.get("drop_delete_token")?,
            drop_expires_at: row.get("drop_expires_at")?,
            original_path: row.get("original_path")?,
            style: row.get("style")?,
            pending_style: row.get("pending_style")?,
            too_big_to_send: crate::limits::too_big_to_send(row.get::<_, i64>("bytes")? as u64),
        })
    }
}

/// A share link that was replaced by an edit but couldn't be deleted at the time
/// (design doc, "Share link (drop) on Done"). Kept until a delete succeeds or it expires,
/// so "Delete all my cloud data" can still reach it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupersededDrop {
    pub drop_id: String,
    pub delete_token: String,
    pub expires_at: i64,
}

/// What a new row needs. The id, timestamps and expiry are worked out by [`Store::insert`].
pub struct NewItem {
    pub source: Source,
    pub origin_device: Option<String>,
    pub file_name: String,
    pub path: PathBuf,
    pub thumb_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

pub struct Store {
    connection: Mutex<Connection>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// A 22-char base62 id from 128 random bits (ARCHITECTURE §5.3 and §6).
pub fn new_id() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // getrandom only fails if the OS entropy source is unavailable, which on both our
        // targets means something is very wrong. Fall back to the clock rather than panic;
        // the id is for addressing a local file, not for secrecy.
        let stamp = now_ms().to_be_bytes();
        bytes[..8].copy_from_slice(&stamp);
    }

    let mut value = u128::from_be_bytes(bytes);
    let mut out = [b'0'; 22];
    for slot in out.iter_mut().rev() {
        *slot = ALPHABET[(value % 62) as usize];
        value /= 62;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Store {
    /// Open (and migrate) `shelf.db` in the app-data dir.
    pub fn open(app_data: &Path) -> Result<Self, StoreError> {
        fs::create_dir_all(app_data).map_err(|e| StoreError::Open(e.to_string()))?;
        let connection = Connection::open(app_data.join("shelf.db"))
            .map_err(|e| StoreError::Open(e.to_string()))?;
        Self::from_connection(connection)
    }

    #[cfg(test)]
    fn in_memory() -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory().map_err(|e| StoreError::Open(e.to_string()))?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self, StoreError> {
        // A half-written row would orphan its files, so durability is worth the fsync.
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS items (
                   id              TEXT PRIMARY KEY,
                   created_at      INTEGER NOT NULL,
                   expires_at      INTEGER,
                   source          TEXT NOT NULL,
                   origin_device   TEXT,
                   file_name       TEXT NOT NULL,
                   path            TEXT NOT NULL,
                   thumb_path      TEXT NOT NULL,
                   width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL,
                   vault_item_id   TEXT,
                   drop_id         TEXT, drop_key TEXT, drop_delete_token TEXT,
                   drop_expires_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC);",
            )
            .map_err(|e| StoreError::Open(e.to_string()))?;

        migrate(&connection).map_err(|e| StoreError::Open(e.to_string()))?;

        Ok(Store {
            connection: Mutex::new(connection),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, StoreError>) -> Result<T, StoreError> {
        let guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
        f(&guard)
    }

    /// Add an item and return it. `ttl_ms` of `None` pins it from the start.
    pub fn insert(&self, item: NewItem, ttl_ms: Option<i64>) -> Result<Item, StoreError> {
        self.insert_with_id(&new_id(), item, ttl_ms)
    }

    /// Add an item under a *given* id.
    ///
    /// Used for items that arrive from a paired phone (PRD F4.5): reusing the vault item's
    /// id makes the insert idempotent, so a reconnect that replays `item.created` cannot put
    /// the same screenshot on the shelf twice.
    pub fn insert_with_id(
        &self,
        id: &str,
        item: NewItem,
        ttl_ms: Option<i64>,
    ) -> Result<Item, StoreError> {
        let created_at = now_ms();
        let row = Item {
            id: id.to_string(),
            created_at,
            expires_at: ttl_ms.map(|ttl| created_at + ttl),
            source: item.source,
            origin_device: item.origin_device,
            file_name: item.file_name,
            path: item.path.to_string_lossy().into_owned(),
            thumb_path: item.thumb_path.to_string_lossy().into_owned(),
            width: item.width,
            height: item.height,
            bytes: item.bytes,
            drop_id: None,
            drop_key: None,
            drop_delete_token: None,
            drop_expires_at: None,
            original_path: None,
            style: None,
            pending_style: None,
            too_big_to_send: crate::limits::too_big_to_send(item.bytes),
        };

        self.with(|connection| {
            connection.execute(
                "INSERT INTO items (id, created_at, expires_at, source, origin_device,
                                    file_name, path, thumb_path, width, height, bytes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    row.id,
                    row.created_at,
                    row.expires_at,
                    row.source.as_str(),
                    row.origin_device,
                    row.file_name,
                    row.path,
                    row.thumb_path,
                    row.width as i64,
                    row.height as i64,
                    row.bytes as i64,
                ],
            )?;
            Ok(())
        })?;

        Ok(row)
    }

    /// Every row, newest first — including any past `expires_at` that the sweep has not
    /// removed yet. Internal callers (cloud cleanup, edit recovery) need those too.
    pub fn list(&self) -> Result<Vec<Item>, StoreError> {
        self.with(|connection| {
            let mut statement = connection.prepare(
                "SELECT * FROM items ORDER BY created_at DESC",
            )?;
            let rows = statement.query_map([], Item::from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// What the shelf shows, newest first (PRD F2.1): every row not yet past `expires_at`,
    /// so an item never lingers on screen between expiring and being swept (PRD F2.7).
    pub fn list_live(&self, now: i64) -> Result<Vec<Item>, StoreError> {
        self.with(|connection| {
            let mut statement = connection.prepare(
                "SELECT * FROM items WHERE expires_at IS NULL OR expires_at > ?1
                 ORDER BY created_at DESC",
            )?;
            let rows = statement.query_map(params![now], Item::from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// When the next unpinned item expires, if any. The expiry job sleeps until then.
    pub fn next_expiry(&self) -> Result<Option<i64>, StoreError> {
        self.with(|connection| {
            Ok(connection.query_row(
                "SELECT MIN(expires_at) FROM items WHERE expires_at IS NOT NULL",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )?)
        })
    }

    pub fn get(&self, id: &str) -> Result<Item, StoreError> {
        self.with(|connection| {
            connection
                .query_row("SELECT * FROM items WHERE id = ?1", params![id], Item::from_row)
                .optional()?
                .ok_or(StoreError::Missing)
        })
    }

    /// Remove a row and return it, so the caller can delete its files.
    pub fn delete(&self, id: &str) -> Result<Item, StoreError> {
        let item = self.get(id)?;
        self.with(|connection| {
            connection.execute("DELETE FROM items WHERE id = ?1", params![id])?;
            Ok(())
        })?;
        Ok(item)
    }

    /// PRD F2.11 — pinning clears the expiry; unpinning restarts it from now.
    pub fn set_pinned(&self, id: &str, pinned: bool, ttl_ms: i64) -> Result<Item, StoreError> {
        let expires_at = if pinned { None } else { Some(now_ms() + ttl_ms) };
        self.with(|connection| {
            let changed = connection.execute(
                "UPDATE items SET expires_at = ?2 WHERE id = ?1",
                params![id, expires_at],
            )?;
            if changed == 0 {
                return Err(StoreError::Missing);
            }
            Ok(())
        })?;
        self.get(id)
    }

    /// Rows past their expiry (PRD F2.7). Pinned rows have a NULL `expires_at` and so are
    /// never matched by the comparison.
    pub fn take_expired(&self, now: i64) -> Result<Vec<Item>, StoreError> {
        let expired = self.with(|connection| {
            let mut statement =
                connection.prepare("SELECT * FROM items WHERE expires_at IS NOT NULL AND expires_at <= ?1")?;
            let rows = statement.query_map(params![now], Item::from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })?;

        for item in &expired {
            self.with(|connection| {
                connection.execute("DELETE FROM items WHERE id = ?1", params![item.id])?;
                Ok(())
            })?;
        }

        Ok(expired)
    }

    /// Rows beyond the plan's capacity, oldest first, skipping pinned ones (PRD F2.8).
    ///
    /// Capacity comes from `config/limits.json`, never a literal (CLAUDE.md rule 2).
    pub fn take_over_capacity(&self, plan: Plan) -> Result<Vec<Item>, StoreError> {
        let capacity = capacity_for(plan);

        let overflow = self.with(|connection| {
            let mut statement = connection.prepare(
                "SELECT * FROM items
                 WHERE expires_at IS NOT NULL
                 ORDER BY created_at DESC
                 LIMIT -1 OFFSET ?1",
            )?;
            let rows = statement.query_map(params![capacity as i64], Item::from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })?;

        for item in &overflow {
            self.with(|connection| {
                connection.execute("DELETE FROM items WHERE id = ?1", params![item.id])?;
                Ok(())
            })?;
        }

        Ok(overflow)
    }

    /// How many items are pinned right now; the Free plan caps this (docs/designs/free-plan.md).
    pub fn count_pinned(&self) -> Result<usize, StoreError> {
        self.with(|connection| {
            let count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM items WHERE expires_at IS NULL",
                [],
                |row| row.get(0),
            )?;
            Ok(count as usize)
        })
    }

    pub fn count(&self) -> Result<usize, StoreError> {
        self.with(|connection| {
            let count: i64 = connection.query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))?;
            Ok(count as usize)
        })
    }

    /// Record the drop an item was published as (PRD F3.1).
    pub fn set_drop(
        &self,
        id: &str,
        drop_id: &str,
        drop_key: &str,
        delete_token: &str,
        expires_at: i64,
    ) -> Result<(), StoreError> {
        self.with(|connection| {
            let changed = connection.execute(
                "UPDATE items SET drop_id = ?2, drop_key = ?3, drop_delete_token = ?4,
                                  drop_expires_at = ?5
                 WHERE id = ?1",
                params![id, drop_id, drop_key, delete_token, expires_at],
            )?;
            if changed == 0 {
                return Err(StoreError::Missing);
            }
            Ok(())
        })
    }

    /// Forget a deleted drop (PRD F3.5).
    pub fn clear_drop(&self, id: &str) -> Result<(), StoreError> {
        self.with(|connection| {
            connection.execute(
                "UPDATE items SET drop_id = NULL, drop_key = NULL, drop_delete_token = NULL,
                                  drop_expires_at = NULL
                 WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        })
    }

    /// Background Done, transaction A: remember the original and the style about to be
    /// applied. `path` is untouched, so a crash after this leaves a whole item.
    pub fn begin_edit(&self, id: &str, original_path: &str, pending_style: &str) -> Result<(), StoreError> {
        self.with(|connection| {
            let changed = connection.execute(
                "UPDATE items SET original_path = ?2, pending_style = ?3 WHERE id = ?1",
                params![id, original_path, pending_style],
            )?;
            if changed == 0 {
                return Err(StoreError::Missing);
            }
            Ok(())
        })
    }

    /// Background Done, transaction B: the framed file is in place at `path`.
    ///
    /// The thumbnail gets a new path rather than being overwritten: the shelf webview
    /// caches images by URL, so a rewritten `thumbs/{id}.png` would keep showing the old one.
    pub fn finish_edit(
        &self,
        id: &str,
        thumb_path: &str,
        width: u32,
        height: u32,
        bytes: u64,
    ) -> Result<Item, StoreError> {
        self.with(|connection| {
            let changed = connection.execute(
                "UPDATE items SET style = pending_style, pending_style = NULL, thumb_path = ?2,
                                  width = ?3, height = ?4, bytes = ?5
                 WHERE id = ?1 AND pending_style IS NOT NULL",
                params![id, thumb_path, width as i64, height as i64, bytes as i64],
            )?;
            if changed == 0 {
                return Err(StoreError::Missing);
            }
            Ok(())
        })?;
        self.get(id)
    }

    /// Recovery for a row whose edited file is gone: `path` holds the original again.
    pub fn reset_edit(
        &self,
        id: &str,
        thumb_path: &str,
        width: u32,
        height: u32,
        bytes: u64,
    ) -> Result<(), StoreError> {
        self.with(|connection| {
            connection.execute(
                "UPDATE items SET style = NULL, pending_style = NULL, thumb_path = ?2,
                                  width = ?3, height = ?4, bytes = ?5
                 WHERE id = ?1",
                params![id, thumb_path, width as i64, height as i64, bytes as i64],
            )?;
            Ok(())
        })
    }

    /// Move an item's drop into `superseded_drops` and clear it from the row, atomically,
    /// so the next Copy link mints a new one while the old stays deletable.
    pub fn supersede_drop(&self, id: &str) -> Result<(), StoreError> {
        let mut guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
        let tx = guard.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO superseded_drops (drop_id, delete_token, expires_at)
             SELECT drop_id, drop_delete_token, COALESCE(drop_expires_at, 0) FROM items
             WHERE id = ?1 AND drop_id IS NOT NULL AND drop_delete_token IS NOT NULL",
            params![id],
        )?;
        tx.execute(
            "UPDATE items SET drop_id = NULL, drop_key = NULL, drop_delete_token = NULL,
                              drop_expires_at = NULL
             WHERE id = ?1",
            params![id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Every superseded link still waiting for its delete.
    pub fn superseded_drops(&self) -> Result<Vec<SupersededDrop>, StoreError> {
        self.with(|connection| {
            let mut statement =
                connection.prepare("SELECT drop_id, delete_token, expires_at FROM superseded_drops")?;
            let rows = statement.query_map([], |row| {
                Ok(SupersededDrop {
                    drop_id: row.get(0)?,
                    delete_token: row.get(1)?,
                    expires_at: row.get(2)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Forget a superseded link: deleted, or expired on its own.
    pub fn forget_superseded(&self, drop_id: &str) -> Result<(), StoreError> {
        self.with(|connection| {
            connection.execute("DELETE FROM superseded_drops WHERE drop_id = ?1", params![drop_id])?;
            Ok(())
        })
    }

    /// Is this file already tracked? Used when adopting Phase 1 captures.
    pub fn has_path(&self, path: &str) -> Result<bool, StoreError> {
        self.with(|connection| {
            let count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM items WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )?;
            Ok(count > 0)
        })
    }
}

/// Schema migrations, keyed on `PRAGMA user_version` (design doc 0.1.16, "Storage").
///
/// The base `CREATE TABLE` above stays as it was, so a database from any earlier release
/// reaches the same schema as a fresh one by running the same steps. Each step runs in one
/// transaction with its version bump, so a crash can't leave half a migration applied.
fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if version < 1 {
        // `annotations` lands now with the rest so 0.2.0 markup needs no second migration.
        connection.execute_batch(
            "BEGIN;
             ALTER TABLE items ADD COLUMN original_path TEXT;
             ALTER TABLE items ADD COLUMN style TEXT;
             ALTER TABLE items ADD COLUMN pending_style TEXT;
             ALTER TABLE items ADD COLUMN annotations TEXT;
             CREATE TABLE IF NOT EXISTS superseded_drops (
               drop_id      TEXT PRIMARY KEY,
               delete_token TEXT NOT NULL,
               expires_at   INTEGER NOT NULL
             );
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }

    Ok(())
}

/// Shelf capacity for a plan, from `config/limits.json`: the Free plan's smaller shelf, or
/// the Lifetime one that Sync shares (docs/designs/free-plan.md).
pub fn capacity_for(plan: Plan) -> usize {
    plan.shelf_capacity() as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::limits;

    fn sample(name: &str) -> NewItem {
        NewItem {
            source: Source::Capture,
            origin_device: None,
            file_name: name.to_string(),
            path: PathBuf::from(format!("/captures/{name}")),
            thumb_path: PathBuf::from(format!("/thumbs/{name}")),
            width: 100,
            height: 50,
            bytes: 1234,
        }
    }

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    #[test]
    fn ids_are_22_char_base62() {
        let id = new_id();
        assert_eq!(id.len(), 22);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()), "{id}");
        // 128 bits of randomness: a collision in a handful of draws would mean it is broken.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(new_id()));
        }
    }

    #[test]
    fn inserting_then_listing_round_trips() {
        let store = Store::in_memory().expect("store");
        let item = store.insert(sample("a.png"), Some(DAY_MS)).expect("insert");

        let listed = store.list().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, item.id);
        assert_eq!(listed[0].file_name, "a.png");
        assert_eq!(listed[0].width, 100);
        assert!(!listed[0].is_pinned());
    }

    #[test]
    fn the_list_is_newest_first() {
        let store = Store::in_memory().expect("store");
        for name in ["one.png", "two.png", "three.png"] {
            store.insert(sample(name), Some(DAY_MS)).expect("insert");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let names: Vec<_> = store
            .list()
            .expect("list")
            .into_iter()
            .map(|item| item.file_name)
            .collect();
        assert_eq!(names, ["three.png", "two.png", "one.png"]);
    }

    #[test]
    fn deleting_returns_the_row_so_its_files_can_go_too() {
        let store = Store::in_memory().expect("store");
        let item = store.insert(sample("a.png"), Some(DAY_MS)).expect("insert");

        let removed = store.delete(&item.id).expect("delete");
        assert_eq!(removed.path, item.path);
        assert_eq!(store.count().expect("count"), 0);
        assert!(matches!(store.delete(&item.id), Err(StoreError::Missing)));
    }

    #[test]
    fn pinning_clears_the_expiry_and_unpinning_restarts_it() {
        let store = Store::in_memory().expect("store");
        let item = store.insert(sample("a.png"), Some(DAY_MS)).expect("insert");
        assert!(item.expires_at.is_some());

        let pinned = store.set_pinned(&item.id, true, DAY_MS).expect("pin");
        assert!(pinned.is_pinned());

        let unpinned = store.set_pinned(&item.id, false, DAY_MS).expect("unpin");
        assert!(!unpinned.is_pinned());
        assert!(unpinned.expires_at.expect("expiry") > now_ms());
    }

    #[test]
    fn a_drop_can_be_recorded_and_cleared() {
        let store = Store::in_memory().expect("store");
        let item = store.insert(sample("a.png"), Some(DAY_MS)).expect("insert");
        assert_eq!(item.drop_id, None);

        store
            .set_drop(&item.id, "drop-1", "key-1", "token-1", 42)
            .expect("set");

        let with_drop = store.get(&item.id).expect("get");
        assert_eq!(with_drop.drop_id.as_deref(), Some("drop-1"));
        assert_eq!(with_drop.drop_key.as_deref(), Some("key-1"));
        assert_eq!(with_drop.drop_expires_at, Some(42));

        store.clear_drop(&item.id).expect("clear");
        assert_eq!(store.get(&item.id).expect("get").drop_id, None);
    }

    #[test]
    fn recording_a_drop_on_a_missing_item_is_an_error() {
        let store = Store::in_memory().expect("store");
        assert!(matches!(
            store.set_drop("nope", "d", "k", "t", 0),
            Err(StoreError::Missing)
        ));
    }

    #[test]
    fn counts_pinned_items_only() {
        let store = Store::in_memory().expect("store");
        let a = store.insert(sample("a.png"), Some(DAY_MS)).expect("a");
        let b = store.insert(sample("b.png"), Some(DAY_MS)).expect("b");
        store.insert(sample("c.png"), Some(DAY_MS)).expect("c");
        assert_eq!(store.count_pinned().expect("count"), 0);

        store.set_pinned(&a.id, true, DAY_MS).expect("pin a");
        store.set_pinned(&b.id, true, DAY_MS).expect("pin b");
        assert_eq!(store.count_pinned().expect("count"), 2);

        store.set_pinned(&a.id, false, DAY_MS).expect("unpin a");
        assert_eq!(store.count_pinned().expect("count"), 1);
    }

    /// A database written by 0.1.15 or earlier reaches the same schema as a fresh one, and
    /// keeps its rows (design doc 0.1.16, "Storage").
    #[test]
    fn migration_1_upgrades_an_existing_database_in_place() {
        let connection = Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(
                "CREATE TABLE items (
                   id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER,
                   source TEXT NOT NULL, origin_device TEXT, file_name TEXT NOT NULL,
                   path TEXT NOT NULL, thumb_path TEXT NOT NULL,
                   width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL,
                   vault_item_id TEXT, drop_id TEXT, drop_key TEXT, drop_delete_token TEXT,
                   drop_expires_at INTEGER);
                 INSERT INTO items (id, created_at, source, file_name, path, thumb_path,
                                    width, height, bytes)
                 VALUES ('old', 1, 'capture', 'a.png', '/a.png', '/t.png', 1, 1, 1);",
            )
            .expect("0.1.15 schema");

        let store = Store::from_connection(connection).expect("migrate");
        let item = store.get("old").expect("row kept");
        assert_eq!(item.original_path, None);
        assert_eq!(item.style, None);
        let version: i64 = store
            .with(|c| Ok(c.query_row("PRAGMA user_version", [], |row| row.get(0))?))
            .expect("version");
        assert_eq!(version, 1);
        assert!(store.superseded_drops().expect("table exists").is_empty());
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let store = Store::in_memory().expect("store");
        store.with(|c| Ok(migrate(c)?)).expect("second run");
        store.insert(sample("a.png"), Some(DAY_MS)).expect("still usable");
    }

    #[test]
    fn an_edit_is_begun_then_finished_in_two_steps() {
        let store = Store::in_memory().expect("store");
        let item = store.insert(sample("a.png"), Some(DAY_MS)).expect("insert");

        store.begin_edit(&item.id, "/originals/a.png", "{\"x\":1}").expect("txn a");
        let mid = store.get(&item.id).expect("get");
        assert_eq!(mid.pending_style.as_deref(), Some("{\"x\":1}"));
        assert_eq!(mid.style, None, "the style isn't applied until the file is in place");

        let done = store.finish_edit(&item.id, "/thumbs/a-e1.png", 300, 200, 999).expect("txn b");
        assert_eq!(done.thumb_path, "/thumbs/a-e1.png");
        assert_eq!(done.style.as_deref(), Some("{\"x\":1}"));
        assert_eq!(done.pending_style, None);
        assert_eq!((done.width, done.height, done.bytes), (300, 200, 999));
        assert_eq!(done.original_path.as_deref(), Some("/originals/a.png"));
    }

    /// The old link must stay deletable ("Delete all my cloud data") after the item lets go
    /// of it, so the next Copy link mints a new one.
    #[test]
    fn superseding_a_drop_moves_it_off_the_item_and_keeps_it_deletable() {
        let store = Store::in_memory().expect("store");
        let item = store.insert(sample("a.png"), Some(DAY_MS)).expect("insert");
        store.set_drop(&item.id, "drop-1", "key-1", "token-1", 42).expect("set");

        store.supersede_drop(&item.id).expect("supersede");

        let after = store.get(&item.id).expect("get");
        assert_eq!(after.drop_id, None);
        assert_eq!(after.drop_key, None);
        assert_eq!(
            store.superseded_drops().expect("list"),
            vec![SupersededDrop {
                drop_id: "drop-1".into(),
                delete_token: "token-1".into(),
                expires_at: 42,
            }]
        );

        store.forget_superseded("drop-1").expect("forget");
        assert!(store.superseded_drops().expect("list").is_empty());
    }

    #[test]
    fn superseding_an_item_without_a_link_records_nothing() {
        let store = Store::in_memory().expect("store");
        let item = store.insert(sample("a.png"), Some(DAY_MS)).expect("insert");
        store.supersede_drop(&item.id).expect("supersede");
        assert!(store.superseded_drops().expect("list").is_empty());
    }

    #[test]
    fn items_over_the_send_limit_are_flagged() {
        let store = Store::in_memory().expect("store");
        let limit = limits().lifetime.max_image_bytes;
        let small = store.insert(sample("a.png"), Some(DAY_MS)).expect("small");
        let big = store
            .insert(NewItem { bytes: limit + 1, ..sample("b.png") }, Some(DAY_MS))
            .expect("big");
        assert!(!store.get(&small.id).expect("get").too_big_to_send);
        assert!(store.get(&big.id).expect("get").too_big_to_send);
        assert!(big.too_big_to_send);
    }

    #[test]
    fn capacity_comes_from_the_limits_file() {
        // CLAUDE.md rule 2: no magic numbers for plan limits.
        assert_eq!(capacity_for(Plan::Lifetime), limits().lifetime.shelf_capacity as usize);
        assert_eq!(capacity_for(Plan::Lifetime), 100);
        assert_eq!(capacity_for(Plan::Sync), 100);
        assert_eq!(capacity_for(Plan::Expired), limits().free.shelf_capacity as usize);
    }
}

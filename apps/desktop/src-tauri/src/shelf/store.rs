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

use crate::limits::{limits, Plan};

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
        })
    }
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

    /// Everything on the shelf, newest first (PRD F2.1).
    pub fn list(&self) -> Result<Vec<Item>, StoreError> {
        self.with(|connection| {
            let mut statement = connection.prepare(
                "SELECT * FROM items ORDER BY created_at DESC",
            )?;
            let rows = statement.query_map([], Item::from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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

/// Shelf capacity for a plan, from `config/limits.json`.
///
/// Only the Lifetime block carries `shelfCapacity`; the trial includes everything, and Sync
/// is an add-on to Lifetime, so they share the same shelf.
pub fn capacity_for(_plan: Plan) -> usize {
    limits().lifetime.shelf_capacity as usize
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn capacity_comes_from_the_limits_file() {
        // CLAUDE.md rule 2: no magic numbers for plan limits.
        assert_eq!(capacity_for(Plan::Lifetime), limits().lifetime.shelf_capacity as usize);
        assert_eq!(capacity_for(Plan::Lifetime), 100);
    }
}

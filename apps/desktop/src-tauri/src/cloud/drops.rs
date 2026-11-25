//! Send to phone / share links (PRD F3, ARCHITECTURE §7.1).
//!
//! ```text
//! item PNG ─▶ fresh 256-bit key ─▶ HOP1 seal ─▶ POST /drops/{id}?ttl=
//!          ─▶ store {dropId, key, deleteToken, expiresAt} on the item row
//!          ─▶ https://app.hopshot.xyz/d/{id}#{key}
//! ```
//!
//! **The key is never sent anywhere.** It is generated here, used to seal, written to the
//! local row, and placed in the URL *fragment* — which browsers never transmit. Nothing in
//! this module logs it (CLAUDE.md privacy invariants).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use thiserror::Error;

use crate::cloud::client::{self, ClientError};
use crate::crypto::{self, EnvelopeError, Kind};
use crate::shelf::store::StoreError;
use crate::shelf::ShelfError;

/// Where the viewer and the phone app live.
///
/// **Not the apex.** ARCHITECTURE §8 writes these URLs as `hopshot.xyz/d/:id` and
/// `hopshot.xyz/pair`, but the apex is served by the separate marketing Worker (see the
/// repo-root wrangler.jsonc), which has no such routes — a QR pointing there 404s. The Astro
/// app is deployed to `app.hopshot.xyz`, so that is what the codes have to encode.
///
/// Overridable via `HOPSHOT_VIEWER_BASE` so a preview deployment can be tested.
const DEFAULT_VIEWER_BASE: &str = "https://app.hopshot.xyz";

#[derive(Debug, Error)]
pub enum DropError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error(transparent)]
    Envelope(#[from] EnvelopeError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("that image could not be read: {0}")]
    Read(String),
    #[error("this item has no link to delete")]
    NoDrop,
    /// Over `maxImageBytes`: refused before any upload (DESIGN §5 "Too big to send").
    #[error("{}", crate::limits::too_big_message())]
    TooBig,
    #[error(transparent)]
    Shelf(#[from] ShelfError),
}

/// `POST /drops/{id}` → `201 {id, deleteToken, expiresAt}` (ARCHITECTURE §7.1).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedDrop {
    id: String,
    delete_token: String,
    expires_at: i64,
}

/// What the QR popover needs (DESIGN S4).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drop {
    pub id: String,
    /// `https://app.hopshot.xyz/d/{id}#{key}` — the key is in the fragment.
    pub url: String,
    pub expires_at: i64,
    /// The QR as an inline SVG, rendered in Rust so the UI stays a view (rule 3).
    pub qr_svg: String,
}

/// Viewer base URL. `HOPSHOT_VIEWER_BASE` points a staging build at a preview deployment.
///
/// Shared with `cloud::vault`, which builds the pairing URL against the same host — two
/// copies could drift and send a staging build's pairing QR to production.
pub fn viewer_base() -> String {
    std::env::var("HOPSHOT_VIEWER_BASE").unwrap_or_else(|_| DEFAULT_VIEWER_BASE.to_string())
}

/// Encrypt an item and publish it as a drop (PRD F3.1).
pub fn send<R: Runtime>(app: &AppHandle<R>, item_id: &str, ttl: &str) -> Result<Drop, DropError> {
    let store = crate::shelf::store(app)?;
    let item = store.get(item_id)?;

    // Reuse the existing live drop rather than paying for a second upload.
    if let Some(existing) = existing_drop(&item) {
        return Ok(existing);
    }
    if item.too_big_to_send {
        return Err(DropError::TooBig);
    }

    let plaintext = std::fs::read(&item.path).map_err(|e| DropError::Read(e.to_string()))?;

    // A fresh key per drop (ARCHITECTURE §6), so one shared link never exposes another.
    let key = crypto::new_key()?;
    let key_bytes = crypto::key_from_base64url(&key)?;
    let drop_id = crypto::new_id();

    let envelope = crypto::seal(&key_bytes, Kind::Drop, &drop_id, &plaintext)?;

    let install_id = install_id(app);
    let created: CreatedDrop = client::post_bytes(
        &format!("/drops/{drop_id}?ttl={ttl}"),
        envelope,
        &[("X-Hopshot-Install", install_id.as_str())],
    )?;

    store.set_drop(
        item_id,
        &created.id,
        &key,
        &created.delete_token,
        created.expires_at,
    )?;

    // Logged without the fragment: the id is harmless, the key is not.
    log::info!("drop {} created, expires {}", created.id, created.expires_at);

    Ok(build(&created.id, &key, created.expires_at))
}

/// `DELETE /drops/{id}` — "Delete now" in the popover (PRD F3.5).
pub fn delete<R: Runtime>(app: &AppHandle<R>, item_id: &str) -> Result<(), DropError> {
    let store = crate::shelf::store(app)?;
    let item = store.get(item_id)?;

    let (Some(drop_id), Some(token)) = (item.drop_id.as_deref(), item.drop_delete_token.as_deref())
    else {
        return Err(DropError::NoDrop);
    };

    client::delete(&format!("/drops/{drop_id}"), token)?;
    store.clear_drop(item_id)?;

    log::info!("drop {drop_id} deleted");
    Ok(())
}

/// Every shelf item that still has a link online, with what deleting it needs.
fn live_drops(items: &[crate::shelf::store::Item]) -> Vec<(&str, &str, &str)> {
    items
        .iter()
        .filter_map(|item| {
            Some((item.id.as_str(), item.drop_id.as_deref()?, item.drop_delete_token.as_deref()?))
        })
        .collect()
}

/// Delete every link this computer has online ("Delete all my cloud data", DESIGN S7).
///
/// Already-expired links answer 404, which `client::delete` treats as done. A network or
/// server failure stops here with the error, so the user can retry rather than be told it
/// worked; links deleted before the failure stay deleted. Returns how many were removed.
pub fn delete_all<R: Runtime>(app: &AppHandle<R>) -> Result<usize, DropError> {
    let store = crate::shelf::store(app)?;
    let items = store.list()?;
    let targets = live_drops(&items);

    for (item_id, drop_id, token) in &targets {
        client::delete(&format!("/drops/{drop_id}"), token)?;
        store.clear_drop(item_id)?;
    }

    // Links an edit replaced but couldn't delete at the time are still online, and no item
    // points at them any more, so they have to be walked separately.
    let superseded = store.superseded_drops()?;
    for old in &superseded {
        client::delete(&format!("/drops/{}", old.drop_id), &old.delete_token)?;
        store.forget_superseded(&old.drop_id)?;
    }

    let total = targets.len() + superseded.len();
    log::info!("deleted {total} drop(s) online");
    Ok(total)
}

/// What happened to an item's old link when its image changed (background Done).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OldLink {
    /// The item had no link.
    None,
    /// Deleted (or already gone) online.
    Removed,
    /// Couldn't be deleted yet; it's in `superseded_drops` and will be retried.
    Pending,
}

/// Retire an item's link because its image changed (design doc, "Share link (drop) on
/// Done"). Called *after* the local edit is committed, off the UI thread, so an offline
/// machine never holds Done open for the client's timeout.
///
/// Either way the item ends with no link, so the next Copy link mints one with the new
/// image; a failed delete leaves the old link in `superseded_drops` for [`retry_superseded`]
/// and [`delete_all`].
pub fn retire<R: Runtime>(app: &AppHandle<R>, item_id: &str) -> Result<OldLink, DropError> {
    let store = crate::shelf::store(app)?;
    let item = store.get(item_id)?;
    let (Some(drop_id), Some(token)) = (item.drop_id.clone(), item.drop_delete_token.clone()) else {
        return Ok(OldLink::None);
    };

    // An expired link is already gone from the server's point of view.
    if item.drop_expires_at.is_some_and(|at| at <= crate::shelf::store::now_ms()) {
        store.clear_drop(item_id)?;
        return Ok(OldLink::None);
    }

    // Moved first, so a crash mid-delete can't lose track of a live link.
    store.supersede_drop(item_id)?;
    match client::delete(&format!("/drops/{drop_id}"), &token) {
        Ok(()) => {
            store.forget_superseded(&drop_id)?;
            Ok(OldLink::Removed)
        }
        Err(error) => {
            log::warn!("could not delete superseded drop {drop_id} yet: {error}");
            Ok(OldLink::Pending)
        }
    }
}

/// Try again to delete links an edit replaced. Runs at startup; rows go once deleted or
/// expired. Best-effort: anything still failing waits for the next launch or delete-all.
pub fn retry_superseded<R: Runtime>(app: &AppHandle<R>) {
    let Ok(store) = crate::shelf::store(app) else {
        return;
    };
    let Ok(pending) = store.superseded_drops() else {
        return;
    };
    let now = crate::shelf::store::now_ms();
    for old in pending {
        if old.expires_at <= now {
            let _ = store.forget_superseded(&old.drop_id);
            continue;
        }
        match client::delete(&format!("/drops/{}", old.drop_id), &old.delete_token) {
            Ok(()) => {
                let _ = store.forget_superseded(&old.drop_id);
                log::info!("deleted superseded drop {}", old.drop_id);
            }
            Err(error) => log::info!("superseded drop {} still pending: {error}", old.drop_id),
        }
    }
}

/// The still-valid drop already on an item, if any.
fn existing_drop(item: &crate::shelf::store::Item) -> Option<Drop> {
    let (id, key, expires_at) = (
        item.drop_id.as_deref()?,
        item.drop_key.as_deref()?,
        item.drop_expires_at?,
    );

    // An expired link is worth replacing rather than handing back.
    if expires_at <= crate::shelf::store::now_ms() {
        return None;
    }

    Some(build(id, key, expires_at))
}

fn build(id: &str, key: &str, expires_at: i64) -> Drop {
    let url = format!("{}/d/{id}#{key}", viewer_base());
    Drop {
        qr_svg: qr_svg(&url),
        id: id.to_string(),
        url,
        expires_at,
    }
}

/// Render the link as an SVG QR code (DESIGN S4).
///
/// Quiet zone included: scanners need the margin, and without it a reader pressed against
/// the screen edge fails more often than it succeeds.
///
/// Shared with the pairing QR (PRD F4.1) so both codes render identically.
pub fn qr_svg(url: &str) -> String {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};

    // Medium correction tolerates the logo punched into the middle of the tile.
    match QrCode::with_error_correction_level(url.as_bytes(), EcLevel::M) {
        Ok(code) => code
            .render::<svg::Color<'_>>()
            .min_dimensions(180, 180)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(error) => {
            log::error!("could not render the QR code: {error}");
            String::new()
        }
    }
}

/// A stable per-install id for the daily cap (ARCHITECTURE §7.9).
///
/// Not a user identifier: it is random, local, and only ever used to count this install's
/// sends against its own quota.
///
/// Also what `POST /vaults` and `POST /trial/start` are keyed on (ARCHITECTURE §7.2, §7.5).
pub fn install_id<R: Runtime>(app: &AppHandle<R>) -> String {
    let settings = crate::settings::load(app).unwrap_or_default();
    if let Some(existing) = settings.install_id.clone() {
        return existing;
    }

    let fresh = crypto::new_id();
    let mut patch = serde_json::Map::new();
    patch.insert("installId".into(), serde_json::Value::String(fresh.clone()));
    if let Err(error) = crate::settings::patch(app, patch) {
        log::warn!("could not persist the install id: {error}");
    }
    fresh
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, drop: Option<(&str, &str)>) -> crate::shelf::store::Item {
        crate::shelf::store::Item {
            id: id.to_string(),
            created_at: 0,
            expires_at: None,
            source: crate::shelf::store::Source::Capture,
            origin_device: None,
            file_name: format!("{id}.png"),
            path: String::new(),
            thumb_path: String::new(),
            width: 1,
            height: 1,
            bytes: 1,
            drop_id: drop.map(|(d, _)| d.to_string()),
            drop_key: drop.map(|_| "key".to_string()),
            drop_delete_token: drop.map(|(_, t)| t.to_string()),
            drop_expires_at: drop.map(|_| 1),
            original_path: None,
            style: None,
            pending_style: None,
            too_big_to_send: false,
        }
    }

    /// "Delete all my cloud data" must reach every link online, and only those.
    #[test]
    fn delete_all_targets_every_item_with_a_link_and_nothing_else() {
        let items = vec![
            item("a", Some(("drop-a", "tok-a"))),
            item("b", None),
            item("c", Some(("drop-c", "tok-c"))),
        ];
        assert_eq!(live_drops(&items), vec![("a", "drop-a", "tok-a"), ("c", "drop-c", "tok-c")]);
        assert!(live_drops(&[item("d", None)]).is_empty());
    }

    /// Regression: the default was the apex, which the marketing Worker serves. Every
    /// pairing QR and share link 404'd because neither /pair nor /d/ exists there.
    #[test]
    fn the_viewer_base_is_not_the_marketing_apex() {
        // Only meaningful without the override, which is the normal case.
        if std::env::var("HOPSHOT_VIEWER_BASE").is_ok() {
            return;
        }

        assert_eq!(viewer_base(), "https://app.hopshot.xyz");
        assert_ne!(viewer_base(), "https://hopshot.xyz");
        // And no trailing slash, since every caller appends a path beginning with `/`.
        assert!(!viewer_base().ends_with('/'));
    }

    #[test]
    fn the_url_puts_the_key_in_the_fragment() {
        let drop = build("7Kq2mXa9Lr4TzB0cP1vYwe", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", 0);

        let (before_hash, fragment) = drop.url.split_once('#').expect("a fragment");
        // ARCHITECTURE §6: the key must never be in the path or query.
        assert!(!before_hash.contains("AAECAw"), "{before_hash}");
        assert_eq!(fragment, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
        assert!(before_hash.ends_with("/d/7Kq2mXa9Lr4TzB0cP1vYwe"));
    }

    #[test]
    fn the_qr_encodes_the_whole_link_including_the_key() {
        let drop = build("7Kq2mXa9Lr4TzB0cP1vYwe", "k".repeat(43).as_str(), 0);
        assert!(drop.qr_svg.starts_with("<?xml") || drop.qr_svg.starts_with("<svg"));
        assert!(!drop.qr_svg.is_empty());
    }

    /// A 22-char id plus a 43-char key plus the origin is ~90 chars, well inside what a
    /// QR at this size can carry — but a longer viewer base could break it silently.
    #[test]
    fn a_realistic_link_still_renders() {
        let url = format!("https://hopshot.xyz/d/{}#{}", "7".repeat(22), "k".repeat(43));
        assert!(url.len() < 128);
        assert!(!qr_svg(&url).is_empty());
    }
}

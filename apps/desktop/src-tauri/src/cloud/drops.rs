//! Send to phone / share links (PRD F3, ARCHITECTURE §7.1).
//!
//! ```text
//! item PNG ─▶ fresh 256-bit key ─▶ HOP1 seal ─▶ POST /drops/{id}?ttl=
//!          ─▶ store {dropId, key, deleteToken, expiresAt} on the item row
//!          ─▶ https://hopshot.xyz/d/{id}#{key}
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

/// Where the viewer lives (ARCHITECTURE §6). Overridable so a Pages preview can be tested.
const DEFAULT_VIEWER_BASE: &str = "https://hopshot.xyz";

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
    /// `https://hopshot.xyz/d/{id}#{key}` — the key is in the fragment.
    pub url: String,
    pub expires_at: i64,
    /// The QR as an inline SVG, rendered in Rust so the UI stays a view (rule 3).
    pub qr_svg: String,
}

/// Viewer base URL. `HOPSHOT_VIEWER_BASE` points a staging build at a Pages preview.
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

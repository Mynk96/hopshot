//! The vault: pairing, syncing captures out, pulling phone items in (ARCHITECTURE §7.2–§7.3,
//! PRD F4).
//!
//! **The privacy rule this module exists to keep** (CLAUDE.md invariant 1): the vault key is
//! generated here, stored in the OS keychain, and used here to seal every item before it is
//! handed to `cloud::client`. It reaches the network exactly once, in the **fragment** of the
//! pairing URL — `https://app.hopshot.xyz/pair#{code}.{vaultKey}` — which browsers never send
//! to a server. Nothing in this file logs the key, and the metadata (including the file name)
//! is sealed too, so the server sees only opaque bytes.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::cloud::client::{self, ClientError};
use crate::crypto::{self, EnvelopeError, Kind};
use crate::secrets::{self, SecretError, VaultCredentials};

#[derive(Debug, Error)]
pub enum VaultError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error(transparent)]
    Crypto(#[from] EnvelopeError),
    #[error(transparent)]
    Secret(#[from] SecretError),
    /// Nothing is paired yet, so there is no vault to act in.
    #[error("Pair a phone first.")]
    NotPaired,
}

/* ── Wire shapes. Mirrors packages/shared/src/types.ts ────────────────────── */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrolment {
    pub vault_id: String,
    pub device_id: String,
    pub device_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub code: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    pub is_self: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: String,
    pub source_device_id: String,
    pub size: i64,
    /// Sealed `ItemMeta`, base64url. Opaque until [`open_meta`].
    pub meta: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemCreated {
    #[allow(dead_code)]
    item_id: String,
    expires_at: i64,
}

/// The metadata sealed alongside each item. The file name is in here precisely so it does
/// not travel in a header the server could read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemMeta {
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_device: Option<String>,
}

/* ── Pairing (PRD F4.1) ───────────────────────────────────────────────────── */

/// Is this computer already in a vault?
pub fn credentials() -> Result<Option<VaultCredentials>, VaultError> {
    Ok(secrets::vault_credentials()?)
}

fn require_credentials() -> Result<VaultCredentials, VaultError> {
    credentials()?.ok_or(VaultError::NotPaired)
}

/// Create the vault for this computer and keep its credentials (ARCHITECTURE §7.2).
///
/// The vault key is minted locally and never sent: the server stores ciphertext it cannot
/// read, which is the whole point of the design.
pub fn create(install_id: &str, device_name: &str) -> Result<VaultCredentials, VaultError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
        device_name: &'a str,
        kind: &'a str,
    }

    let enrolment: Enrolment = client::post_json(
        "/vaults",
        &Body {
            device_name,
            kind: "desktop",
        },
        &[("X-Hopshot-Install", install_id)],
    )?;

    let credentials = VaultCredentials {
        vault_id: enrolment.vault_id,
        device_id: enrolment.device_id,
        device_token: enrolment.device_token,
        vault_key: crypto::new_key()?,
    };

    secrets::save_vault_credentials(&credentials)?;
    log::info!("vault created, device {}", credentials.device_id);
    Ok(credentials)
}

/// The vault for this computer, creating it on first use (PRD F4.1).
pub fn ensure(install_id: &str, device_name: &str) -> Result<VaultCredentials, VaultError> {
    match credentials()? {
        Some(existing) => Ok(existing),
        None => create(install_id, device_name),
    }
}

/// A pairing URL for the QR code (PRD F4.1).
///
/// `#{code}.{vaultKey}` — both halves are in the **fragment**, so neither reaches the
/// server when the phone opens the link. The invite code is single-use and lasts 10 minutes;
/// the key is what makes the phone able to decrypt anything at all.
pub fn pairing_url(viewer_base: &str, code: &str, vault_key: &str) -> String {
    format!("{viewer_base}/pair#{code}.{vault_key}")
}

/// Mint an invite and build the pairing URL for it.
pub fn new_pairing(install_id: &str, device_name: &str) -> Result<(String, i64), VaultError> {
    let credentials = ensure(install_id, device_name)?;

    let invite: Invite = client::post_json(
        &format!("/vaults/{}/invites", credentials.vault_id),
        &serde_json::json!({}),
        &[("Authorization", &format!("Bearer {}", credentials.device_token))],
    )?;

    Ok((
        pairing_url(&crate::cloud::drops::viewer_base(), &invite.code, &credentials.vault_key),
        invite.expires_at,
    ))
}

/* ── Devices (PRD F4.7, DESIGN S7) ────────────────────────────────────────── */

pub fn devices() -> Result<Vec<DeviceSummary>, VaultError> {
    let credentials = require_credentials()?;
    Ok(client::get_json(
        &format!("/vaults/{}/devices", credentials.vault_id),
        &credentials.device_token,
    )?)
}

pub fn revoke(device_id: &str) -> Result<(), VaultError> {
    let credentials = require_credentials()?;
    Ok(client::delete(
        &format!("/vaults/{}/devices/{device_id}", credentials.vault_id),
        &credentials.device_token,
    )?)
}

/// "Delete all my cloud data" (DESIGN S7 Privacy).
///
/// The local keychain is cleared even if the server call fails: the user asked to be
/// unpaired, and keeping a key for a vault we can no longer reach serves nobody. The shelf
/// on this computer is untouched, which is what the confirm copy promises.
pub fn delete_everything() -> Result<(), VaultError> {
    let credentials = require_credentials()?;

    let result = client::delete(
        &format!("/vaults/{}", credentials.vault_id),
        &credentials.device_token,
    );

    secrets::clear_vault_credentials()?;
    Ok(result?)
}

/* ── Items (PRD F4.3, F4.5) ───────────────────────────────────────────────── */

/// Seal and upload one capture to the vault.
///
/// Both the image and its metadata are sealed under the vault key before anything leaves
/// this function. `item` and `meta` use different AAD kinds so a blob cannot be swapped for
/// a metadata envelope (ARCHITECTURE §6).
pub fn upload(
    credentials: &VaultCredentials,
    png: &[u8],
    meta: &ItemMeta,
    ttl: &str,
) -> Result<(String, i64), VaultError> {
    let key = crypto::key_from_base64url(&credentials.vault_key)?;
    let item_id = crypto::new_id();

    let sealed_image = crypto::seal(&key, Kind::Item, &item_id, png)?;
    let sealed_meta = crypto::seal(
        &key,
        Kind::Meta,
        &item_id,
        &serde_json::to_vec(meta).map_err(|e| ClientError::Protocol(e.to_string()))?,
    )?;

    let created: ItemCreated = client::post_bytes(
        &format!(
            "/vaults/{}/items/{item_id}?ttl={ttl}",
            credentials.vault_id
        ),
        sealed_image,
        &[
            ("Authorization", &format!("Bearer {}", credentials.device_token)),
            ("X-Hopshot-Meta", &crypto::to_base64url(&sealed_meta)),
        ],
    )?;

    Ok((item_id, created.expires_at))
}

/// Items created after `since` (ms). `since = 0` is the whole feed.
pub fn list(credentials: &VaultCredentials, since: i64) -> Result<Vec<ItemSummary>, VaultError> {
    Ok(client::get_json(
        &format!("/vaults/{}/items?since={since}", credentials.vault_id),
        &credentials.device_token,
    )?)
}

/// Fetch and unseal one item's image.
pub fn download(
    credentials: &VaultCredentials,
    item_id: &str,
) -> Result<Vec<u8>, VaultError> {
    let sealed = client::get_bytes(
        &format!("/vaults/{}/items/{item_id}/blob", credentials.vault_id),
        &credentials.device_token,
    )?;

    let key = crypto::key_from_base64url(&credentials.vault_key)?;
    Ok(crypto::open(&key, Kind::Item, item_id, &sealed)?)
}

/// Unseal an item's metadata envelope.
pub fn open_meta(
    credentials: &VaultCredentials,
    item_id: &str,
    sealed_base64: &str,
) -> Result<ItemMeta, VaultError> {
    let key = crypto::key_from_base64url(&credentials.vault_key)?;
    let sealed = crypto::from_base64url(sealed_base64)?;
    let plain = crypto::open(&key, Kind::Meta, item_id, &sealed)?;

    serde_json::from_slice(&plain)
        .map_err(|e| VaultError::Client(ClientError::Protocol(e.to_string())))
}

/// Push a freshly taken capture to the vault, off the capture path (PRD F4.3).
///
/// Silent by design. Auto-sync is a background convenience, and the capture is already
/// safely on the shelf — interrupting the user with "sync failed" for something they did not
/// ask for would be noise. Failures are logged, and the item is picked up by the next
/// catch-up pass if the vault is reachable then.
pub fn sync_capture_in_background<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    item: &crate::shelf::store::Item,
) {
    // No vault means no phone is paired, so there is nothing to sync to and nothing to say.
    let Ok(Some(credentials)) = credentials() else {
        return;
    };

    let path = item.path.clone();
    let file_name = item.file_name.clone();
    let (width, height) = (item.width, item.height);
    let ttl = crate::settings::load(app)
        .unwrap_or_default()
        .item_ttl
        .clone();
    let device_name = hostname();

    std::thread::spawn(move || {
        let png = match std::fs::read(&path) {
            Ok(png) => png,
            Err(error) => {
                log::warn!("auto-sync could not read {path}: {error}");
                return;
            }
        };

        let meta = ItemMeta {
            file_name,
            width,
            height,
            // So the *phone* can label where it came from (DESIGN S5).
            origin_device: Some(device_name),
        };

        match upload(&credentials, &png, &meta, &ttl) {
            Ok((id, _)) => log::info!("auto-synced capture as vault item {id}"),
            Err(error) => log::warn!("auto-sync failed: {error}"),
        }
    });
}

/// A friendly name for this computer, for the devices list and the "from" badge.
pub fn hostname() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME", "HOST"] {
        if let Ok(name) = std::env::var(key) {
            if !name.trim().is_empty() {
                return name;
            }
        }
    }
    // Better a generic label than an empty one: the server requires a non-empty name.
    "This computer".to_string()
}

pub fn delete_item(credentials: &VaultCredentials, item_id: &str) -> Result<(), VaultError> {
    Ok(client::delete(
        &format!("/vaults/{}/items/{item_id}", credentials.vault_id),
        &credentials.device_token,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CLAUDE.md invariant 1: keys travel in fragments, never in a query string or path.
    #[test]
    fn a_pairing_url_keeps_both_secrets_in_the_fragment() {
        let url = pairing_url("https://app.hopshot.xyz", "INVITECODE123456", "k".repeat(43).as_str());

        let (before, fragment) = url.split_once('#').expect("a fragment");
        assert!(!before.contains("INVITECODE"), "the code leaked into the path: {before}");
        assert!(!before.contains('?'), "no query string at all: {before}");
        assert!(fragment.starts_with("INVITECODE123456."));
        assert!(fragment.ends_with(&"k".repeat(43)));
    }

    /// The server must not be able to tell two items apart by their metadata, and must not
    /// be able to move a blob from one item id to another.
    #[test]
    fn item_and_meta_are_sealed_under_different_contexts() {
        let key = crypto::key_from_base64url(&crypto::new_key().expect("key")).expect("decode");
        let id = crypto::new_id();

        let image = crypto::seal(&key, Kind::Item, &id, b"png-bytes").expect("seal image");
        let meta = crypto::seal(&key, Kind::Meta, &id, b"{}").expect("seal meta");

        // Opening the image envelope as metadata must fail: different AAD.
        assert!(crypto::open(&key, Kind::Meta, &id, &image).is_err());
        assert!(crypto::open(&key, Kind::Item, &id, &meta).is_err());

        // And an envelope cannot be replayed under another item's id.
        let other = crypto::new_id();
        assert!(crypto::open(&key, Kind::Item, &other, &image).is_err());

        assert_eq!(
            crypto::open(&key, Kind::Item, &id, &image).expect("round trip"),
            b"png-bytes"
        );
    }

    #[test]
    fn item_meta_round_trips_as_camel_case() {
        let meta = ItemMeta {
            file_name: "Screenshot 2026-10-18 at 16.20.11.png".into(),
            width: 1280,
            height: 720,
            origin_device: Some("Mayank's iPhone".into()),
        };

        let json = serde_json::to_string(&meta).expect("serialize");
        // The PWA and the Worker both read these names (packages/shared/src/types.ts).
        assert!(json.contains("\"fileName\""));
        assert!(json.contains("\"originDevice\""));

        let back: ItemMeta = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.file_name, meta.file_name);
        assert_eq!(back.width, 1280);
    }

    /// A capture of our own has no origin device, and the field must then be absent rather
    /// than `null` — the PWA treats presence as "this came from somewhere else".
    #[test]
    fn a_local_capture_omits_the_origin_device() {
        let json = serde_json::to_string(&ItemMeta {
            file_name: "shot.png".into(),
            width: 10,
            height: 10,
            origin_device: None,
        })
        .expect("serialize");

        assert!(!json.contains("originDevice"), "{json}");
    }
}

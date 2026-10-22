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
///
/// **These field names are a cross-language contract** with `Meta` in
/// `packages/crypto/src/index.ts`, which is what the phone unseals. They were written
/// independently and did not match — Rust sealed `{fileName, width, height, originDevice}`
/// while the phone read `{name, mime, w, h, createdAt, origin}`, so *every* field came back
/// `undefined`. The visible damage was a Blob with an empty MIME type, which made
/// `navigator.share` reject the file and `ClipboardItem` throw; card titles read "undefined".
///
/// `mime` is the field that cannot be dropped: the phone has to rebuild a Blob with the
/// right type, and a typeless Blob is unusable by the share sheet. Keep this struct and that
/// type in step — `metadata_matches_the_shared_contract` below pins the wire names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemMeta {
    pub name: String,
    pub mime: String,
    pub w: u32,
    pub h: u32,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/* ── Pairing (PRD F4.1) ───────────────────────────────────────────────────── */

/// Is this computer already in a vault?
pub fn credentials() -> Result<Option<VaultCredentials>, VaultError> {
    Ok(secrets::vault_credentials()?)
}

/// What `POST /trial/start` reports back (ARCHITECTURE §7.5).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trial {
    pub started_at: i64,
    pub ends_at: i64,
    pub days: u32,
    pub active: bool,
}

/// Record the start of the 7-day trial, server-side (PRD F8).
///
/// Deliberately non-fatal. A failure here is worth a log line but not a thrown error: the
/// call that follows is the one that actually decides whether the user is allowed a vault,
/// and it reports the real reason in the DESIGN §5 voice. Turning a flaky trial ping into
/// the user's error message would hide that.
pub fn ensure_trial(install_id: &str) {
    match client::post_json::<_, Trial>(
        "/trial/start",
        &serde_json::json!({}),
        &[("X-Hopshot-Install", install_id)],
    ) {
        Ok(trial) => log::info!(
            "trial: {} ({} day(s), ends {})",
            if trial.active { "active" } else { "ended" },
            trial.days,
            trial.ends_at
        ),
        Err(error) => log::warn!("could not record the trial start: {error}"),
    }
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

    // Without this the vault cannot be created at all: `resolvePlan` reads the `trials`
    // table, `lifetime.vault` is false, and `POST /vaults` answers 403. Idempotent on the
    // install id, so re-posting returns the original start date rather than extending the
    // trial (ARCHITECTURE §7.5).
    ensure_trial(install_id);

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
    let created_at_ms = item.created_at;
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
            name: file_name,
            // Captures are always PNG (capture/mod.rs writes one). The phone rebuilds its
            // Blob from this, and an empty type makes the share sheet refuse the file.
            mime: "image/png".to_string(),
            w: width,
            h: height,
            created_at: created_at_ms,
            // So the *phone* can label where it came from (DESIGN S5).
            origin: Some(device_name),
        };

        match upload(&credentials, &png, &meta, &ttl) {
            Ok((id, _)) => log::info!("auto-synced capture as vault item {id}"),
            Err(error) => log::warn!("auto-sync failed: {error}"),
        }
    });
}

/// The paired phones this item could be sent to, newest pairing last.
///
/// Empty when nothing is paired, which is what makes the send sheet fall back to a QR.
pub fn paired_phones() -> Result<Vec<String>, VaultError> {
    let Some(_credentials) = credentials()? else {
        return Ok(Vec::new());
    };

    Ok(devices()?
        .into_iter()
        .filter(|device| device.kind == "phone")
        .map(|device| device.name)
        .collect())
}

/// Send one shelf item straight to the paired phones (DESIGN S4, PRD F3).
///
/// This is what "Send to phone" should do once a phone exists: the item goes into the vault
/// and appears in the phone's feed within seconds, with no QR to scan and no public link
/// created at all. The QR path is for the un-paired case and for sharing with other people.
///
/// Returns the names it went to, so the UI can say "Sent to Mayank's iPhone".
pub fn send_to_phones<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    item_id: &str,
) -> Result<Vec<String>, VaultError> {
    let credentials = require_credentials()?;

    let phones = paired_phones()?;
    if phones.is_empty() {
        return Ok(Vec::new());
    }

    let store = crate::shelf::store(app).map_err(|_| VaultError::NotPaired)?;
    let item = store.get(item_id).map_err(|_| VaultError::NotPaired)?;

    let png = std::fs::read(&item.path)
        .map_err(|error| VaultError::Client(ClientError::Protocol(error.to_string())))?;

    let settings = crate::settings::load(app).unwrap_or_default();
    let meta = ItemMeta {
        name: item.file_name.clone(),
        mime: "image/png".to_string(),
        w: item.width,
        h: item.height,
        created_at: item.created_at,
        origin: Some(hostname()),
    };

    let (vault_item_id, _) = upload(&credentials, &png, &meta, &settings.item_ttl)?;
    log::info!("sent {item_id} to {} phone(s) as {vault_item_id}", phones.len());

    Ok(phones)
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

    /// The sealed metadata is a contract with `Meta` in packages/crypto/src/index.ts, which
    /// is what the phone unseals. The two were written independently and did not match, so
    /// every field arrived `undefined` on the phone: an empty Blob MIME type, which made
    /// `navigator.share` reject the file and `ClipboardItem` throw, and card titles that read
    /// "undefined".
    ///
    /// Pinned as exact JSON keys. Renaming a field here without renaming it there is the
    /// same bug again, and nothing else would catch it — both sides compile fine.
    #[test]
    fn metadata_matches_the_shared_contract() {
        let json = serde_json::to_value(ItemMeta {
            name: "Screenshot 2026-10-21 at 16.20.11.png".into(),
            mime: "image/png".into(),
            w: 1280,
            h: 720,
            created_at: 1_792_000_000_000,
            origin: Some("Mayank's PC".into()),
        })
        .expect("serialize");

        let object = json.as_object().expect("an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();

        // Exactly the fields `Meta` declares, spelled the way TypeScript reads them.
        assert_eq!(keys, ["createdAt", "h", "mime", "name", "origin", "w"]);

        // `mime` is the one that cannot be empty: the phone rebuilds a Blob from it, and a
        // typeless Blob cannot be shared or copied.
        assert_eq!(object["mime"], "image/png");
        assert!(object["name"].as_str().expect("a name").ends_with(".png"));
    }

    #[test]
    fn item_meta_round_trips_as_camel_case() {
        let meta = ItemMeta {
            name: "Screenshot 2026-10-18 at 16.20.11.png".into(),
            mime: "image/png".into(),
            w: 1280,
            h: 720,
            created_at: 0,
            origin: Some("Mayank's iPhone".into()),
        };

        let json = serde_json::to_string(&meta).expect("serialize");
        // The names the phone's `Meta` type declares.
        assert!(json.contains("\"name\""));
        assert!(json.contains("\"origin\""));

        let back: ItemMeta = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.name, meta.name);
        assert_eq!(back.w, 1280);
    }

    /// A capture of our own has no origin device, and the field must then be absent rather
    /// than `null` — the PWA treats presence as "this came from somewhere else".
    #[test]
    fn a_local_capture_omits_the_origin_device() {
        let json = serde_json::to_string(&ItemMeta {
            name: "shot.png".into(),
            mime: "image/png".into(),
            w: 10,
            h: 10,
            created_at: 0,
            origin: None,
        })
        .expect("serialize");

        assert!(!json.contains("origin"), "{json}");
    }
}

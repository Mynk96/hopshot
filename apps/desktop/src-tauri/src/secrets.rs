//! OS keychain access via the `keyring` crate, service `xyz.hopshot` (ARCHITECTURE §5.3).
//! Secrets never go into settings.json or SQLite (CLAUDE.md rule 10).
//!
//! Three things live here, and all three are credentials:
//!
//! * **the vault key** — the AES-256 key every synced item is sealed with. The one secret
//!   that must never reach the server in any form. It is created on this computer, shown
//!   once in a pairing QR fragment, and otherwise never leaves the keychain.
//! * **the device token** — the vault bearer credential.
//! * **the license device token** (Phase 4.1).
//!
//! `keyring` errors are mapped to a single [`SecretError`] rather than surfaced: the
//! messages name entries and services, and they end up in logs.

use keyring::Entry;
use thiserror::Error;

/// Keychain service name. Matches the bundle identifier in tauri.conf.json.
const SERVICE: &str = "xyz.hopshot";

/// The vault's AES-256 key, base64url (ARCHITECTURE §6).
pub const VAULT_KEY: &str = "vault-key";
/// The vault device token (ARCHITECTURE §7.2).
pub const DEVICE_TOKEN: &str = "device-token";
/// The vault id this computer is enrolled in. Not secret, but it belongs with its token.
pub const VAULT_ID: &str = "vault-id";
/// This device's id inside the vault.
pub const DEVICE_ID: &str = "device-id";

#[derive(Debug, Error)]
pub enum SecretError {
    /// The keychain is present but refused us: locked, or access denied by the user.
    #[error("Hopshot couldn't reach your keychain.")]
    Unavailable,
    #[error("Hopshot couldn't save that securely.")]
    Write,
}

fn entry(name: &str) -> Result<Entry, SecretError> {
    Entry::new(SERVICE, name).map_err(|error| {
        log::warn!("keychain entry {name} could not be opened: {error}");
        SecretError::Unavailable
    })
}

/// Read a secret, or `None` when it was never stored.
///
/// A missing entry is not an error: "no vault yet" is the normal state on first launch, and
/// every caller has to handle it anyway.
pub fn get(name: &str) -> Result<Option<String>, SecretError> {
    match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => {
            log::warn!("keychain read of {name} failed: {error}");
            Err(SecretError::Unavailable)
        }
    }
}

pub fn set(name: &str, value: &str) -> Result<(), SecretError> {
    entry(name)?.set_password(value).map_err(|error| {
        log::warn!("keychain write of {name} failed: {error}");
        SecretError::Write
    })
}

/// Remove a secret. Already-absent counts as success.
pub fn delete(name: &str) -> Result<(), SecretError> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => {
            log::warn!("keychain delete of {name} failed: {error}");
            Err(SecretError::Write)
        }
    }
}

/// Everything this computer needs to act in its vault.
#[derive(Debug, Clone)]
pub struct VaultCredentials {
    pub vault_id: String,
    pub device_id: String,
    pub device_token: String,
    pub vault_key: String,
}

/// Load the vault credentials, or `None` if this computer has never paired.
///
/// All four are required together. A partial set means an interrupted write or a keychain
/// someone edited by hand; treating that as "not paired" is the only safe reading, because
/// a token without its key can reach the server but cannot decrypt anything it finds.
pub fn vault_credentials() -> Result<Option<VaultCredentials>, SecretError> {
    Ok(assemble(
        get(VAULT_ID)?,
        get(DEVICE_ID)?,
        get(DEVICE_TOKEN)?,
        get(VAULT_KEY)?,
    ))
}

/// The all-or-nothing rule, as a pure function.
///
/// Separated from [`vault_credentials`] so it can be tested without touching the real
/// keychain: a test that wrote to the live `vault-id` entry to simulate a partial set would
/// overwrite — and on cleanup delete — an actual pairing.
fn assemble(
    vault_id: Option<String>,
    device_id: Option<String>,
    device_token: Option<String>,
    vault_key: Option<String>,
) -> Option<VaultCredentials> {
    Some(VaultCredentials {
        vault_id: vault_id?,
        device_id: device_id?,
        device_token: device_token?,
        vault_key: vault_key?,
    })
}

/// Store a fresh enrolment. Written key-first: a token with no key is useless, so if this is
/// interrupted the next read sees a partial set and correctly reports "not paired".
pub fn save_vault_credentials(credentials: &VaultCredentials) -> Result<(), SecretError> {
    set(VAULT_KEY, &credentials.vault_key)?;
    set(VAULT_ID, &credentials.vault_id)?;
    set(DEVICE_ID, &credentials.device_id)?;
    set(DEVICE_TOKEN, &credentials.device_token)?;
    Ok(())
}

/// Forget the vault — unpairing, or "Delete all my cloud data" (DESIGN S7).
pub fn clear_vault_credentials() -> Result<(), SecretError> {
    // Every one is attempted even if an earlier delete fails: leaving the key behind after
    // the user asked to unpair would be the worst of the possible outcomes.
    let results = [
        delete(DEVICE_TOKEN),
        delete(DEVICE_ID),
        delete(VAULT_ID),
        delete(VAULT_KEY),
    ];
    results.into_iter().collect::<Result<Vec<_>, _>>().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique per run so a crashed test cannot leave an entry that breaks the next one.
    fn scratch(name: &str) -> String {
        format!("test-{name}-{}", std::process::id())
    }

    /// Touches the real OS keychain, which is the point: a mocked keyring would prove
    /// nothing about whether secrets actually persist.
    #[test]
    fn a_secret_round_trips_and_can_be_removed() {
        let name = scratch("round-trip");

        assert!(get(&name).expect("read a missing entry").is_none());

        set(&name, "s3cret").expect("write");
        assert_eq!(get(&name).expect("read").as_deref(), Some("s3cret"));

        // Overwriting replaces rather than appending.
        set(&name, "rotated").expect("rewrite");
        assert_eq!(get(&name).expect("read again").as_deref(), Some("rotated"));

        delete(&name).expect("delete");
        assert!(get(&name).expect("read after delete").is_none());
        // Deleting twice is not an error.
        delete(&name).expect("second delete");
    }

    /// A token without its key could reach the server but decrypt nothing, so a partial set
    /// has to read as "not paired" rather than half-working.
    ///
    /// Tests [`assemble`] rather than [`vault_credentials`] on purpose. The previous version
    /// of this test wrote a dummy value to the live `vault-id` entry and deleted it on
    /// cleanup, which destroyed a real pairing on any machine that had one — and failed
    /// whenever the other three entries existed, which is exactly when it mattered.
    #[test]
    fn a_partial_credential_set_reads_as_not_paired() {
        let full = assemble(
            Some("vault".into()),
            Some("device".into()),
            Some("token".into()),
            Some("key".into()),
        );
        assert!(full.is_some());

        // Every one of the four missing on its own must read as not paired.
        let present = || Some("x".to_string());
        assert!(assemble(None, present(), present(), present()).is_none());
        assert!(assemble(present(), None, present(), present()).is_none());
        assert!(assemble(present(), present(), None, present()).is_none());
        assert!(
            assemble(present(), present(), present(), None).is_none(),
            "a vault key is the one that cannot be re-derived"
        );
    }
}

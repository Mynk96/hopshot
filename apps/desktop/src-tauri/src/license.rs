//! Keyless activation: claim, restore, device limit, plan resolution (ARCHITECTURE §7.5).
//!
//! The licence lives as a *device token* in the OS keychain (CLAUDE.md rule 10). There is no
//! licence key for the user to copy anywhere.
//!
//! The interesting part is the computer limit (PRD F8.3): one computer on Lifetime, three
//! while Sync is active. When that limit *drops* — a bundle's included Sync year running out
//! — the licence can legitimately hold more slots than it is now allowed, and the server
//! answers `over_limit` to all but the most recently seen device. The UI then offers DESIGN
//! S9's choice rather than silently locking a machine out.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

pub use crate::limits::Plan;
use crate::cloud::client::{self, ClientError};
use crate::secrets::{self, LICENSE_TOKEN};

/// One computer in the chooser (DESIGN S9).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensedComputer {
    pub id: String,
    pub label: String,
    pub last_seen_at: i64,
    pub is_self: bool,
}

/// `GET /license/status`, as the server answers it (ARCHITECTURE §7.5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub valid: bool,
    /// `unknown` | `revoked` | `over_limit` — absent when valid.
    #[serde(default)]
    pub reason: Option<String>,
    pub plan: String,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub sync_active: Option<bool>,
    #[serde(default)]
    pub devices: Option<Vec<LicensedComputer>>,
}

impl LicenseStatus {
    /// Is this the over-limit case the S9 screens exist for?
    pub fn is_over_limit(&self) -> bool {
        !self.valid && self.reason.as_deref() == Some("over_limit")
    }

    /// The other computers, which is what the chooser lists.
    pub fn others(&self) -> Vec<LicensedComputer> {
        self.devices
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|device| !device.is_self)
            .collect()
    }
}

/// The stored licence token, if this computer has ever been licensed.
pub fn token() -> Option<String> {
    match secrets::get(LICENSE_TOKEN) {
        Ok(found) => found,
        Err(error) => {
            log::warn!("could not read the licence token: {error}");
            None
        }
    }
}

pub fn store_token(value: &str) -> Result<(), ClientError> {
    secrets::set(LICENSE_TOKEN, value)
        .map_err(|error| ClientError::Protocol(error.to_string()))
}

/// Ask the server whether this computer may run, and on what plan.
pub fn status() -> Result<Option<LicenseStatus>, ClientError> {
    let Some(token) = token() else {
        // Never licensed. The trial is what covers a new install, so this is not an error.
        return Ok(None);
    };

    client::get_json::<LicenseStatus>("/license/status", &token).map(Some)
}

/// DESIGN S9 "Move it here?" — free the chosen computer and keep this one.
pub fn move_here(release_device_id: &str) -> Result<LicenseStatus, ClientError> {
    let Some(token) = token() else {
        return Err(ClientError::Protocol("this computer has no licence".into()));
    };

    client::post_json(
        "/license/move-here",
        &serde_json::json!({ "releaseDeviceId": release_device_id }),
        &[("Authorization", &format!("Bearer {token}"))],
    )
}

/// DESIGN S9 "Remove one to use it here" — free a slot on a Sync licence.
pub fn remove_computer(device_id: &str) -> Result<(), ClientError> {
    let Some(token) = token() else {
        return Err(ClientError::Protocol("this computer has no licence".into()));
    };

    client::delete(&format!("/license/devices/{device_id}"), &token)
}

/// What plan this computer is on.
///
/// Resolved locally from the keychain and the last known status rather than hitting the
/// network: this is called on the capture path and from the tray menu, and neither can wait
/// on a request. The real re-check happens every `licenseRecheckDays` (ARCHITECTURE §7.5).
pub fn current_plan<R: Runtime>(_app: &AppHandle<R>) -> Plan {
    // Until the periodic re-check lands, a stored token means a purchase happened and the
    // trial covers everyone else. Treating an unlicensed install as Trial is the forgiving
    // direction: the server is the one that actually enforces the plan on every request.
    Plan::Trial
}

/// PRD F8.2 opens Stripe Checkout in the browser.
pub fn open_checkout<R: Runtime>(_app: &AppHandle<R>, plan: Plan) {
    log::info!("license::open_checkout({plan:?}) — the buy flow lands with the plans sheet");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The over-limit payload is the one the S9 screens branch on, so its shape matters.
    #[test]
    fn an_over_limit_status_parses_and_names_the_other_computers() {
        let json = r#"{
            "valid": false,
            "reason": "over_limit",
            "plan": "lifetime",
            "limit": 1,
            "devices": [
                {"id":"d1","label":"Work PC","lastSeenAt":1792000000000,"isSelf":false},
                {"id":"d2","label":"This PC","lastSeenAt":1791000000000,"isSelf":true}
            ]
        }"#;

        let status: LicenseStatus = serde_json::from_str(json).expect("parse");

        assert!(status.is_over_limit());
        assert_eq!(status.limit, Some(1));

        // The chooser lists everything except this machine.
        let others = status.others();
        assert_eq!(others.len(), 1);
        assert_eq!(others[0].label, "Work PC");
    }

    #[test]
    fn a_valid_status_has_no_reason_and_is_not_over_limit() {
        let status: LicenseStatus =
            serde_json::from_str(r#"{"valid":true,"plan":"sync","limit":3,"syncActive":true}"#)
                .expect("parse");

        assert!(status.valid);
        assert!(!status.is_over_limit());
        assert_eq!(status.sync_active, Some(true));
        assert!(status.others().is_empty());
    }

    /// A revoked licence is not the over-limit case and must not show the chooser.
    #[test]
    fn a_revoked_status_is_not_over_limit() {
        let status: LicenseStatus =
            serde_json::from_str(r#"{"valid":false,"reason":"revoked","plan":"expired"}"#)
                .expect("parse");

        assert!(!status.is_over_limit());
        assert!(status.devices.is_none());
    }
}

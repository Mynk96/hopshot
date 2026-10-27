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

use std::time::Duration;

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
        // Never licensed, which is where every new install starts. Not an error: the caller
        // reads `None` as "not bought yet" and shows the plans screen.
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

/* ── The locked state (PRD F8.1) ─────────────────────────────────────────── */

/// What the app is allowed to do right now, decided locally.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanState {
    pub plan: Plan,
    /// PRD F8.1 — nothing has been bought yet, so capture is paused.
    pub capture_paused: bool,
}

/// What plan this computer is on, and whether capture is paused.
///
/// Decided locally from the keychain alone, because the capture path calls this on every
/// hotkey press and cannot wait on a request. The server is still the authority and refuses
/// an unlicensed caller on every API call.
///
/// **Pay-first (PRD F8.1).** No licence means no capture — there is no trial and no grace,
/// so the answer here is the same whether the app has never been online or is simply unpaid.
/// That is deliberate: a local-only "allow" would be a bypass.
pub fn plan_state<R: Runtime>(app: &AppHandle<R>) -> PlanState {
    let _ = app;

    // A stored licence token means a purchase happened. Which plan it is comes from the
    // server's last word; absent that, Lifetime is the safe floor — it unlocks capture
    // without granting Sync, and the server rejects anything beyond it.
    if token().is_some() {
        return PlanState {
            plan: Plan::Lifetime,
            capture_paused: false,
        };
    }

    PlanState {
        plan: Plan::Expired,
        capture_paused: true,
    }
}

/// What plan this computer is on.
pub fn current_plan<R: Runtime>(app: &AppHandle<R>) -> Plan {
    plan_state(app).plan
}

/* ── Buying (PRD F8.2, F8.3) ──────────────────────────────────────────────── */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuyStarted {
    claim: String,
    url: String,
}

/// What the claim poll can come back with.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimPoll {
    status: String,
    #[serde(default)]
    device_token: Option<String>,
    #[serde(default)]
    plan: Option<String>,
}

/// How long to keep polling a checkout the user may have abandoned.
const POLL_FOR: Duration = Duration::from_secs(20 * 60);
const POLL_EVERY: Duration = Duration::from_secs(2);

/**
 * Start a purchase: open Stripe Checkout in the browser and poll for the result (PRD F8.2).
 *
 * There is no licence key to type. The claim created here is carried through Checkout in
 * metadata, the webhook marks it ready, and the poll below collects a device token — so the
 * app unlocks itself while the user is still looking at the browser (F8.3).
 *
 * Returns once the browser is open; the polling runs on a thread and reports through
 * `license:changed`.
 */
pub fn buy<R: Runtime>(app: &AppHandle<R>, plan: &str) -> Result<(), ClientError> {
    let install_id = crate::cloud::drops::install_id(app);

    let started: BuyStarted = client::post_json(
        &format!("/license/buy/{plan}"),
        &serde_json::json!({}),
        &[("X-Hopshot-Install", install_id.as_str())],
    )?;

    // Opened before polling starts, so the user is never waiting on us first.
    {
        use tauri_plugin_opener::OpenerExt;
        if let Err(error) = app.opener().open_url(&started.url, None::<&str>) {
            log::error!("could not open checkout in the browser: {error}");
            return Err(ClientError::Protocol(
                "Hopshot couldn't open your browser.".into(),
            ));
        }
    }

    let handle = app.clone();
    let claim = started.claim;
    std::thread::spawn(move || poll_claim(&handle, &install_id, &claim));

    Ok(())
}

/// Poll until the purchase lands, the window closes, or the server says the limit is full.
fn poll_claim<R: Runtime>(app: &AppHandle<R>, install_id: &str, claim: &str) {
    let deadline = std::time::Instant::now() + POLL_FOR;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(POLL_EVERY);

        let polled: Result<ClaimPoll, ClientError> = client::get_json_with(
            &format!("/license/claims/{claim}"),
            &[("X-Hopshot-Install", install_id)],
        );

        match polled {
            Ok(result) if result.status == "ready" => {
                let Some(token) = result.device_token else {
                    log::error!("the claim was ready but carried no device token");
                    return;
                };

                if let Err(error) = store_token(&token) {
                    log::error!("could not store the licence token: {error}");
                    return;
                }

                log::info!("licensed: {}", result.plan.as_deref().unwrap_or("unknown"));
                let _ = tauri::Emitter::emit(app, "license:changed", &result.plan);
                return;
            }
            Ok(result) if result.status == "pending" => {}
            Ok(result) => {
                // `device_limit` — the purchase worked but every slot is taken (PRD F8.3).
                log::info!("claim came back as {}", result.status);
                let _ = tauri::Emitter::emit(app, "license:changed", &result.status);
                return;
            }
            Err(ClientError::Offline) => {
                // Keep waiting: the payment may well be going through regardless.
            }
            Err(error) => {
                log::warn!("claim poll failed: {error}");
                return;
            }
        }
    }

    log::info!("stopped waiting for the checkout to complete");
}

/// PRD F8.2 opens Stripe Checkout in the browser.
pub fn open_checkout<R: Runtime>(app: &AppHandle<R>, plan: Plan) {
    let product = if plan.includes_sync() { "bundle" } else { "lifetime" };
    if let Err(error) = buy(app, product) {
        log::warn!("could not start checkout: {error}");
    }
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

    /// `Plan` has no trial variant, so nothing can deserialize into one.
    ///
    /// Pinned because the whole paywall rests on it: a `"trial"` that still parsed would be
    /// an unlicensed plan the capture gate let through.
    #[test]
    fn there_is_no_trial_plan_to_deserialize_into() {
        assert!(serde_json::from_str::<Plan>(r#""trial""#).is_err());

        for (json, expected) in [
            (r#""expired""#, Plan::Expired),
            (r#""lifetime""#, Plan::Lifetime),
            (r#""sync""#, Plan::Sync),
        ] {
            assert_eq!(
                serde_json::from_str::<Plan>(json).expect("parse"),
                expected,
                "{json}"
            );
        }
    }
}

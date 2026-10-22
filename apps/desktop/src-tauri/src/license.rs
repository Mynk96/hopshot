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

/* ── Trial and the paused state (PRD F8.1, F8.1a) ─────────────────────────── */

/// What the app is allowed to do right now, decided locally.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanState {
    pub plan: Plan,
    /// Whole days left in the trial, 0 once it has run out. `None` when not on a trial.
    pub trial_days_left: Option<i64>,
    /// PRD F8.1a — the trial ran out and nothing was bought.
    pub capture_paused: bool,
}

/// What `POST /trial/start` reports.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trial {
    pub ends_at: i64,
    pub active: bool,
}

/// Start (or re-read) the trial and cache when it ends.
///
/// Idempotent server-side, so calling it at every launch cannot extend anything. The cached
/// `trial_ends_at` is what lets [`plan_state`] answer without a network call.
pub fn refresh_trial<R: Runtime>(app: &AppHandle<R>) {
    // A licensed computer has nothing to gain from a trial lookup.
    if token().is_some() {
        return;
    }

    let install_id = crate::cloud::drops::install_id(app);
    let result: Result<Trial, ClientError> = client::post_json(
        "/trial/start",
        &serde_json::json!({}),
        &[("X-Hopshot-Install", install_id.as_str())],
    );

    match result {
        Ok(trial) => {
            let mut patch = serde_json::Map::new();
            patch.insert("trialEndsAt".into(), serde_json::json!(trial.ends_at));
            if let Err(error) = crate::settings::patch(app, patch) {
                log::warn!("could not cache the trial end: {error}");
            }
            log::info!(
                "trial {} (ends {})",
                if trial.active { "active" } else { "ended" },
                trial.ends_at
            );
        }
        // Offline at launch is normal. The cached value carries the app until it is reachable
        // again, and an install that has never reached the server is treated as on trial —
        // the forgiving direction, since the server enforces the plan on every request.
        Err(error) => log::warn!("could not refresh the trial: {error}"),
    }
}

/// What plan this computer is on, and whether capture is paused.
///
/// Decided locally from the keychain and the cached trial end. The capture path calls this on
/// every hotkey press and cannot wait on a request; the server is still the authority and
/// refuses an expired caller on every API call.
pub fn plan_state<R: Runtime>(app: &AppHandle<R>) -> PlanState {
    // A stored licence token means a purchase happened. Which plan it is comes from the
    // server's last word; absent that, Lifetime is the safe floor — it unlocks capture
    // without granting Sync, and the server rejects anything beyond it.
    if token().is_some() {
        return PlanState {
            plan: Plan::Lifetime,
            trial_days_left: None,
            capture_paused: false,
        };
    }

    let ends_at = crate::settings::load(app)
        .unwrap_or_default()
        .trial_ends_at;

    match ends_at {
        Some(ends_at) => {
            let remaining = ends_at - crate::shelf::store::now_ms();
            let days = (remaining as f64 / 86_400_000.0).ceil() as i64;

            if remaining > 0 {
                PlanState {
                    // The trial includes everything (limits.trial.includes).
                    plan: Plan::Trial,
                    trial_days_left: Some(days.max(1)),
                    capture_paused: false,
                }
            } else {
                // PRD F8.1a: capture pauses; the shelf stays readable and draggable.
                PlanState {
                    plan: Plan::Expired,
                    trial_days_left: Some(0),
                    capture_paused: true,
                }
            }
        }
        // Never reached the server, so we do not know. Allow capture: a first-run user
        // behind a captive portal must not be locked out of the app they just installed.
        None => PlanState {
            plan: Plan::Trial,
            trial_days_left: None,
            capture_paused: false,
        },
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
}

//! Usage counts, the feedback ask and the mailing-list sign-up (ARCHITECTURE §7.10).
//!
//! What leaves the device (CLAUDE.md rule 1): the random install id, the app version, the OS
//! and the number of screenshots taken on each recent UTC day. Never an image, a file name or
//! anything that was on screen. Disclosed on /privacy; always on (product decision, 0.1.8).
//!
//! State lives in its own `stats.json`, apart from the user's settings:
//! `firstSeen` (ms), `days` ({"YYYY-MM-DD": count}, the last `pingMaxDays` days),
//! `totalCaptures`, and `feedback` ("asked" once the question has been answered or dismissed).

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::cloud::client::{self, ClientError};
use crate::limits::limits;

const STORE_FILE: &str = "stats.json";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Like the update check: not during launch, then once a day.
const FIRST_PING_DELAY: Duration = Duration::from_secs(30);
const PING_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Serialises read-modify-write on the store: a capture and a ping can land together.
static LOCK: Mutex<()> = Mutex::new(());

/* ── Pure rules (tested below) ─────────────────────────────────────────────── */

/// Add one capture to `today`, keeping only the most recent `keep` days.
fn bump(days: &mut BTreeMap<String, u32>, today: &str, keep: usize) {
    *days.entry(today.to_string()).or_insert(0) += 1;
    // Keys are ISO dates, so BTreeMap order is chronological.
    while days.len() > keep {
        let Some(oldest) = days.keys().next().cloned() else { break };
        days.remove(&oldest);
    }
}

/// Whether to ask "Is Hopshot useful to you?" now.
fn feedback_due(first_seen: i64, total: u64, asked: bool, now: i64, after_days: u32, min: u32) -> bool {
    !asked && now - first_seen >= i64::from(after_days) * DAY_MS && total >= u64::from(min)
}

fn utc_day(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    }
}

/* ── Store ─────────────────────────────────────────────────────────────────── */

struct Snapshot {
    first_seen: i64,
    days: BTreeMap<String, u32>,
    total: u64,
    asked: bool,
}

fn read<R: Runtime>(app: &AppHandle<R>) -> Option<Snapshot> {
    let store = app.store(STORE_FILE).map_err(|e| log::warn!("stats store: {e}")).ok()?;
    let first_seen = match store.get("firstSeen").and_then(|v| v.as_i64()) {
        Some(value) => value,
        None => {
            // First run with stats: start the clock now (upgraders are timed from here too).
            let now = now_ms();
            store.set("firstSeen", json!(now));
            now
        }
    };
    let days = store
        .get("days")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let total = store.get("totalCaptures").and_then(|v| v.as_u64()).unwrap_or(0);
    let asked = store.get("feedback").and_then(|v| v.as_str().map(|s| s == "asked")).unwrap_or(false);
    Some(Snapshot { first_seen, days, total, asked })
}

fn write<R: Runtime>(app: &AppHandle<R>, key: &str, value: Value) {
    match app.store(STORE_FILE) {
        Ok(store) => {
            store.set(key, value);
            if let Err(error) = store.save() {
                log::warn!("could not save the stats store: {error}");
            }
        }
        Err(error) => log::warn!("stats store: {error}"),
    }
}

/// Count a capture that landed on the shelf. Local only; the next ping carries it.
pub fn record_capture<R: Runtime>(app: &AppHandle<R>) {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(mut snapshot) = read(app) else { return };
    bump(&mut snapshot.days, &utc_day(now_ms()), limits().insights.ping_max_days);
    write(app, "days", json!(snapshot.days));
    write(app, "totalCaptures", json!(snapshot.total + 1));
}

/* ── Ping ──────────────────────────────────────────────────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ping<'a> {
    install_id: String,
    version: String,
    os: &'a str,
    days: Vec<Value>,
}

fn ping<R: Runtime>(app: &AppHandle<R>) -> Result<(), ClientError> {
    let days = {
        let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        read(app).map(|s| s.days).unwrap_or_default()
    };
    let body = Ping {
        install_id: crate::cloud::drops::install_id(app),
        version: app.package_info().version.to_string(),
        os: os(),
        days: days.into_iter().map(|(day, captures)| json!({ "day": day, "captures": captures })).collect(),
    };
    client::post_json::<_, Value>("/stats/ping", &body, &[]).map(|_| ())
}

/// Ping 30 s after launch and then daily, on its own thread like `update::watch`.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_PING_DELAY);
        loop {
            // Offline is normal; the counts wait for the next ping.
            if let Err(error) = ping(&app) {
                log::debug!("stats ping failed: {error}");
            }
            std::thread::sleep(PING_INTERVAL);
        }
    });
}

/* ── Feedback and the mailing list (commands delegate here) ─────────────────── */

/// Whether the shelf should ask "Is Hopshot useful to you?" now.
pub fn is_feedback_due<R: Runtime>(app: &AppHandle<R>) -> bool {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(s) = read(app) else { return false };
    let caps = &limits().insights;
    feedback_due(s.first_seen, s.total, s.asked, now_ms(), caps.feedback_after_days, caps.feedback_min_captures)
}

/// Never ask again, whether answered or dismissed.
pub fn mark_feedback_asked<R: Runtime>(app: &AppHandle<R>) {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    write(app, "feedback", json!("asked"));
}

/// Send the answer. Marked asked first, so a network failure never makes it ask twice.
pub fn send_feedback<R: Runtime>(
    app: &AppHandle<R>,
    useful: bool,
    comment: Option<String>,
) -> Result<(), ClientError> {
    mark_feedback_asked(app);
    let max = limits().insights.feedback_comment_max_chars;
    let comment = comment
        .map(|text| text.trim().chars().take(max).collect::<String>())
        .filter(|text| !text.is_empty());
    let body = json!({
        "installId": crate::cloud::drops::install_id(app),
        "version": app.package_info().version.to_string(),
        "useful": useful,
        "comment": comment,
    });
    client::post_json::<_, Value>("/feedback", &body, &[]).map(|_| ())
}

/// Join the mailing list from the onboarding (double opt-in: the API emails a link).
pub fn subscribe(email: &str) -> Result<(), ClientError> {
    let body = json!({ "email": email.trim(), "source": "onboarding" });
    client::post_json::<_, Value>("/subscribe", &body, &[]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bump_counts_per_day_and_keeps_only_the_window() {
        let mut days = BTreeMap::new();
        bump(&mut days, "2026-11-01", 2);
        bump(&mut days, "2026-11-01", 2);
        bump(&mut days, "2026-11-02", 2);
        assert_eq!(days.get("2026-11-01"), Some(&2));
        bump(&mut days, "2026-11-03", 2);
        // The oldest day falls out; the ping window never grows past the limit.
        assert_eq!(days.keys().cloned().collect::<Vec<_>>(), ["2026-11-02", "2026-11-03"]);
    }

    #[test]
    fn feedback_is_asked_once_after_enough_days_and_captures() {
        let first = 0;
        let week = 7 * DAY_MS;
        assert!(!feedback_due(first, 10, false, week - 1, 7, 5), "too early");
        assert!(!feedback_due(first, 4, false, week, 7, 5), "too few captures");
        assert!(feedback_due(first, 5, false, week, 7, 5));
        assert!(!feedback_due(first, 50, true, week * 4, 7, 5), "never twice");
    }

    #[test]
    fn utc_day_is_iso() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_794_481_533_364), "2026-11-12");
    }

    #[test]
    fn the_limits_the_app_needs_are_present() {
        let caps = &limits().insights;
        assert!(caps.ping_max_days > 0);
        assert!(caps.feedback_after_days > 0);
        assert!(caps.feedback_comment_max_chars > 0);
    }
}

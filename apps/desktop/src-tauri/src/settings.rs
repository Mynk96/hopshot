//! Persisted app settings, written as `settings.json` in the app-data dir through
//! `tauri-plugin-store` (ARCHITECTURE §5.3, DESIGN S7).
//!
//! The Settings *screen* arrives in Phase 2.2; the keys the shelf and capture already read
//! live here now. Writes merge into whatever is on disk, so keys a newer build wrote
//! survive a downgrade instead of being dropped.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;
use thiserror::Error;

use crate::limits::limits;

/// File name under the app-data dir (ARCHITECTURE §5.3).
pub const STORE_FILE: &str = "settings.json";

/// PRD F1.1 defaults. `CmdOrCtrl` resolves to ⌘ on macOS and Ctrl on Windows, which is
/// exactly the ⌘⇧2 / Ctrl+Shift+2 pair the PRD asks for.
pub const DEFAULT_CAPTURE_HOTKEY: &str = "CmdOrCtrl+Shift+2";
pub const DEFAULT_SHELF_HOTKEY: &str = "CmdOrCtrl+Shift+1";

const HOUR_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("the settings store is unavailable: {0}")]
    Store(String),
}

/// DESIGN S7 → General → Theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// Which edge the shelf parks against (DESIGN S7 → Shelf → Position).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ShelfSide {
    Left,
    #[default]
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub capture_hotkey: String,
    pub shelf_hotkey: String,
    /// PRD F1.4: the separate full-screen hotkey is optional and unset by default.
    pub full_screen_hotkey: Option<String>,
    /// PRD F1.5 "copy it to the clipboard (setting, default ON)".
    pub copy_on_capture: bool,
    /// PRD F1.5 "show the shelf with the new item highlighted".
    pub show_shelf_on_capture: bool,
    /// PRD F2.7 "user picks 1 h / 24 h / 7 d; default 24 h". One of
    /// `limits.lifetime.itemTtlOptions`.
    pub item_ttl: String,
    /// DESIGN S7 → Shelf → Position.
    pub shelf_side: ShelfSide,
    /// PRD F2.2 "auto-hides after 8 s without hover (setting: 4 / 8 / 15 / never)".
    /// `None` is "never".
    pub auto_hide_seconds: Option<u32>,
    /// PRD F2.10, default OFF.
    pub remove_after_drag: bool,
    /// DESIGN S7 → General → Theme. The shelf and overlay always render dark.
    pub theme: Theme,
    /// PRD F1.7 — P1, so the toggle is shown disabled until that phase.
    pub catch_other_screenshots: bool,
    /// PRD F4.3 "Auto-sync (setting, default ON with Sync)": every new capture is encrypted
    /// and uploaded to the vault. Only has an effect once a phone is paired.
    pub auto_sync: bool,
    /// Random, local, and only used to count this install's sends against its own daily
    /// quota (ARCHITECTURE §7.9). Not a user identifier. Written on the first send.
    pub install_id: Option<String>,
    /// DESIGN S8: the first-launch onboarding has been finished or dismissed. False for a
    /// fresh install and for a settings.json written before onboarding existed, so every
    /// install sees it once.
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            capture_hotkey: DEFAULT_CAPTURE_HOTKEY.to_string(),
            shelf_hotkey: DEFAULT_SHELF_HOTKEY.to_string(),
            full_screen_hotkey: None,
            copy_on_capture: true,
            show_shelf_on_capture: true,
            item_ttl: "24h".to_string(),
            shelf_side: ShelfSide::Right,
            auto_hide_seconds: Some(8),
            remove_after_drag: false,
            theme: Theme::System,
            auto_sync: true,
            catch_other_screenshots: false,
            install_id: None,
            onboarded: false,
        }
    }
}

impl Settings {
    /// How long a new item lives, in ms (PRD F2.7).
    ///
    /// The allowed values come from `config/limits.json`; anything else on disk falls back
    /// to 24 h rather than giving an item an arbitrary lifetime (CLAUDE.md rule 2).
    pub fn item_ttl_ms(&self) -> i64 {
        if !limits()
            .lifetime
            .item_ttl_options
            .iter()
            .any(|option| option == &self.item_ttl)
        {
            log::warn!("itemTtl {:?} is not in limits.json; using 24h", self.item_ttl);
            return 24 * HOUR_MS;
        }
        parse_ttl(&self.item_ttl).unwrap_or(24 * HOUR_MS)
    }

    pub fn shelf_side_is_left(&self) -> bool {
        self.shelf_side == ShelfSide::Left
    }
}

/// `"1h"` / `"24h"` / `"7d"` → milliseconds.
fn parse_ttl(value: &str) -> Option<i64> {
    let (number, unit) = value.split_at(value.len().checked_sub(1)?);
    let number: i64 = number.parse().ok()?;
    match unit {
        "h" => Some(number * HOUR_MS),
        "d" => Some(number * 24 * HOUR_MS),
        _ => None,
    }
}

/// Read the stored settings, falling back to defaults for anything missing.
///
/// A value of the wrong type is a corrupt settings file rather than a reason to refuse to
/// start, so it is logged and the defaults are used.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Settings, SettingsError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|error| SettingsError::Store(error.to_string()))?;
    let stored: Map<String, Value> = store.entries().into_iter().collect();

    Ok(
        serde_json::from_value(Value::Object(stored)).unwrap_or_else(|error| {
            log::warn!("{STORE_FILE} holds values Hopshot can't read ({error}); using defaults");
            Settings::default()
        }),
    )
}

/// Merge `incoming` into the stored settings and return the result.
///
/// Accelerator syntax is checked by `hotkeys::validate_patch` before this is called, so a
/// malformed shortcut never reaches disk.
pub fn patch<R: Runtime>(
    app: &AppHandle<R>,
    incoming: Map<String, Value>,
) -> Result<Settings, SettingsError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|error| SettingsError::Store(error.to_string()))?;
    for (key, value) in incoming {
        store.set(key, value);
    }
    store
        .save()
        .map_err(|error| SettingsError::Store(error.to_string()))?;
    load(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A settings.json from 0.1.6 has no `onboarded` key; it must read as "not yet", so
    /// upgraders get the onboarding once instead of a deserialisation error.
    #[test]
    fn onboarding_is_pending_for_new_and_older_settings() {
        assert!(!Settings::default().onboarded);
        let older: Settings = serde_json::from_str(r#"{"captureHotkey":"CmdOrCtrl+Shift+2"}"#)
            .expect("an older settings file still loads");
        assert!(!older.onboarded);
        let done: Settings = serde_json::from_str(r#"{"onboarded":true}"#).expect("loads");
        assert!(done.onboarded);
    }

    #[test]
    fn defaults_match_prd_f1_1() {
        let settings = Settings::default();
        assert_eq!(settings.capture_hotkey, "CmdOrCtrl+Shift+2");
        assert_eq!(settings.shelf_hotkey, "CmdOrCtrl+Shift+1");
        // PRD F1.4: unset by default.
        assert_eq!(settings.full_screen_hotkey, None);
        // PRD F1.5: copying after a capture is on out of the box.
        assert!(settings.copy_on_capture);
    }

    #[test]
    fn shelf_defaults_match_the_prd() {
        let settings = Settings::default();
        // PRD F2.7 default 24 h.
        assert_eq!(settings.item_ttl, "24h");
        assert_eq!(settings.item_ttl_ms(), 24 * HOUR_MS);
        // PRD F2.2 default 8 s.
        assert_eq!(settings.auto_hide_seconds, Some(8));
        // PRD F2.10 default OFF.
        assert!(!settings.remove_after_drag);
        // PRD F2.1 right edge.
        assert!(!settings.shelf_side_is_left());
        // PRD F1.7 is P1 and off by default.
        assert!(!settings.catch_other_screenshots);
        assert_eq!(settings.theme, Theme::System);
    }

    #[test]
    fn every_ttl_option_in_the_limits_file_parses() {
        for option in &limits().lifetime.item_ttl_options {
            let settings = Settings {
                item_ttl: option.clone(),
                ..Settings::default()
            };
            assert!(settings.item_ttl_ms() > 0, "{option} did not parse");
        }
        assert_eq!(
            Settings {
                item_ttl: "1h".into(),
                ..Settings::default()
            }
            .item_ttl_ms(),
            HOUR_MS
        );
        assert_eq!(
            Settings {
                item_ttl: "7d".into(),
                ..Settings::default()
            }
            .item_ttl_ms(),
            7 * 24 * HOUR_MS
        );
    }

    /// A TTL that is not in limits.json must not silently become an arbitrary lifetime.
    #[test]
    fn an_unknown_ttl_falls_back_to_24h() {
        let settings = Settings {
            item_ttl: "99y".to_string(),
            ..Settings::default()
        };
        assert_eq!(settings.item_ttl_ms(), 24 * HOUR_MS);
    }

    #[test]
    fn missing_keys_fall_back_to_defaults() {
        let partial = serde_json::json!({ "captureHotkey": "CmdOrCtrl+Shift+9" });
        let settings: Settings = serde_json::from_value(partial).expect("partial settings");
        assert_eq!(settings.capture_hotkey, "CmdOrCtrl+Shift+9");
        assert_eq!(settings.shelf_hotkey, DEFAULT_SHELF_HOTKEY);
        assert_eq!(settings.item_ttl, "24h");
    }

    #[test]
    fn round_trips_through_camel_case_json() {
        let settings = Settings {
            full_screen_hotkey: Some("CmdOrCtrl+Shift+3".to_string()),
            shelf_side: ShelfSide::Left,
            auto_hide_seconds: None,
            ..Settings::default()
        };
        let json = serde_json::to_value(&settings).expect("serialize");
        assert_eq!(json["fullScreenHotkey"], "CmdOrCtrl+Shift+3");
        assert_eq!(json["shelfSide"], "left");
        assert_eq!(json["autoHideSeconds"], serde_json::Value::Null);
        assert_eq!(json["theme"], "system");

        let back: Settings = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, settings);
    }
}

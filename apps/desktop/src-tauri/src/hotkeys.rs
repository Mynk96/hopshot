//! Global shortcuts (PRD F1.1, F1.4) through `tauri-plugin-global-shortcut`.
//!
//! [`apply`] is a full re-apply: every shortcut Hopshot owns is dropped and the current
//! settings are registered from scratch. That makes it idempotent, so the Settings UI can
//! call it after any change without tracking what used to be bound.
//!
//! Conflicts come in three kinds and are reported, never silently swallowed (F1.1 wants
//! them visible in Settings):
//!   * the accelerator doesn't parse,
//!   * two actions ask for the same keys,
//!   * the OS refuses the registration because another app already holds the keys.

use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use thiserror::Error;

use crate::settings::Settings;

#[derive(Debug, Error)]
pub enum HotkeyError {
    #[error("{accelerator} isn't a shortcut Hopshot understands")]
    Unparsable { accelerator: String },
    #[error("{key} needs a shortcut")]
    Required { key: &'static str },
}

/// The things a global shortcut can trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    CaptureRegion,
    CaptureScreen,
    ShowShelf,
}

impl Action {
    /// The `settings.json` key this action reads its accelerator from.
    pub const fn setting_key(self) -> &'static str {
        match self {
            Action::CaptureRegion => "captureHotkey",
            Action::CaptureScreen => "fullScreenHotkey",
            Action::ShowShelf => "shelfHotkey",
        }
    }

    /// Menu label from DESIGN S1, reused in conflict messages.
    pub const fn label(self) -> &'static str {
        match self {
            Action::CaptureRegion => "Capture area",
            Action::CaptureScreen => "Capture full screen",
            Action::ShowShelf => "Show shelf",
        }
    }
}

/// A shortcut Hopshot asked for and did not get. `message` follows the DESIGN §5 voice:
/// short, plain, second person, no exclamation marks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub action: Action,
    pub setting_key: &'static str,
    pub accelerator: String,
    pub message: String,
}

/// Conflicts from the most recent [`apply`], held in Tauri state so Settings can read them
/// back without re-registering anything (F1.1).
#[derive(Default)]
pub struct Conflicts(Mutex<Vec<Conflict>>);

impl Conflicts {
    pub fn get(&self) -> Vec<Conflict> {
        // A poisoned lock means another thread panicked mid-write. The conflict list is
        // advisory, so recovering the value beats taking the process down (CLAUDE.md rule 7).
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn replace(&self, next: Vec<Conflict>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }
}

/// What [`resolve`] worked out from the settings, before the OS gets a say.
#[derive(Debug, Default)]
pub struct Resolved {
    pub bindings: Vec<(Action, Shortcut)>,
    pub conflicts: Vec<Conflict>,
}

/// Every action that currently has an accelerator configured, in menu order.
fn configured(settings: &Settings) -> Vec<(Action, String)> {
    let mut out = vec![
        (Action::CaptureRegion, settings.capture_hotkey.clone()),
        (Action::ShowShelf, settings.shelf_hotkey.clone()),
    ];
    if let Some(accelerator) = &settings.full_screen_hotkey {
        out.push((Action::CaptureScreen, accelerator.clone()));
    }
    out
}

/// Parse the configured accelerators and reject duplicates.
///
/// Pure on purpose: this is the half of registration that can be unit-tested without a
/// running app. Only [`apply`] can discover conflicts with *other* apps.
pub fn resolve(settings: &Settings) -> Resolved {
    let mut resolved = Resolved::default();

    for (action, accelerator) in configured(settings) {
        let Ok(shortcut) = Shortcut::from_str(&accelerator) else {
            resolved.conflicts.push(Conflict {
                action,
                setting_key: action.setting_key(),
                message: format!("{accelerator} isn't a shortcut Hopshot understands."),
                accelerator,
            });
            continue;
        };

        // The OS would only ever deliver one of them, so say which one is losing.
        if let Some((other, _)) = resolved.bindings.iter().find(|(_, s)| *s == shortcut) {
            resolved.conflicts.push(Conflict {
                action,
                setting_key: action.setting_key(),
                message: format!(
                    "{accelerator} is already set for {}. Pick different keys for {}.",
                    other.label(),
                    action.label()
                ),
                accelerator,
            });
            continue;
        }

        resolved.bindings.push((action, shortcut));
    }

    resolved
}

/// Drop every shortcut Hopshot owns, register the current settings, and report what failed.
///
/// The conflicts are stored for `get_settings` and also pushed to the UI as `toast` events
/// (ARCHITECTURE §5.4), so a shortcut that stopped working says so when it breaks.
pub fn apply<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Vec<Conflict> {
    let shortcuts = app.global_shortcut();
    if let Err(error) = shortcuts.unregister_all() {
        log::warn!("could not clear the previous shortcuts: {error}");
    }

    let Resolved {
        bindings,
        mut conflicts,
    } = resolve(settings);

    // Duplicates and unparsable accelerators are found before the OS is involved, so say so
    // here too — otherwise a shortcut silently missing from the log looks like a bug.
    for conflict in &conflicts {
        log::warn!("{} not bound: {}", conflict.action.label(), conflict.message);
    }

    for (action, shortcut) in bindings {
        let registered = shortcuts.on_shortcut(shortcut, move |app, _shortcut, event| {
            // Fire once per press; the plugin reports the release too.
            if event.state == ShortcutState::Pressed {
                dispatch(app, action);
            }
        });

        match registered {
            Ok(()) => log::info!("{} bound to {}", action.label(), shortcut.into_string()),
            Err(error) => {
                let accelerator = shortcut.into_string();
                log::warn!("{} could not bind {accelerator}: {error}", action.label());
                conflicts.push(Conflict {
                    action,
                    setting_key: action.setting_key(),
                    message: format!(
                        "Another app is already using {accelerator}. Pick different keys for {}.",
                        action.label()
                    ),
                    accelerator,
                });
            }
        }
    }

    for conflict in &conflicts {
        let _ = app.emit(
            "toast",
            serde_json::json!({ "kind": "error", "text": conflict.message }),
        );
    }

    app.state::<Conflicts>().replace(conflicts.clone());
    conflicts
}

/// Reject accelerator syntax before it reaches disk. Called by `set_settings`, the only
/// writer, so `settings.json` can never hold a shortcut that won't parse.
pub fn validate_patch(patch: &Map<String, Value>) -> Result<(), HotkeyError> {
    for action in [Action::CaptureRegion, Action::ShowShelf, Action::CaptureScreen] {
        let key = action.setting_key();
        let Some(value) = patch.get(key) else {
            continue;
        };

        // Only the optional full-screen hotkey may be cleared (PRD F1.4).
        if value.is_null() {
            if action == Action::CaptureScreen {
                continue;
            }
            return Err(HotkeyError::Required { key });
        }

        let accelerator = value.as_str().unwrap_or_default();
        if Shortcut::from_str(accelerator).is_err() {
            return Err(HotkeyError::Unparsable {
                accelerator: accelerator.to_string(),
            });
        }
    }
    Ok(())
}

/// Route a pressed shortcut to the module that owns the behaviour. Both targets are stubs
/// until Phase 1.2 (capture) and Phase 1.3 (shelf).
fn dispatch<R: Runtime>(app: &AppHandle<R>, action: Action) {
    match action {
        Action::CaptureRegion => crate::capture::start(app, crate::capture::Mode::Region),
        Action::CaptureScreen => crate::capture::start(app, crate::capture::Mode::Screen),
        Action::ShowShelf => crate::shelf::toggle(app),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_resolve_cleanly() {
        let resolved = resolve(&Settings::default());
        assert!(resolved.conflicts.is_empty(), "{:?}", resolved.conflicts);
        assert_eq!(
            resolved.bindings.iter().map(|(a, _)| *a).collect::<Vec<_>>(),
            vec![Action::CaptureRegion, Action::ShowShelf]
        );
    }

    #[test]
    fn the_optional_full_screen_hotkey_is_registered_when_set() {
        let settings = Settings {
            full_screen_hotkey: Some("CmdOrCtrl+Shift+3".to_string()),
            ..Settings::default()
        };
        let resolved = resolve(&settings);
        assert!(resolved.conflicts.is_empty());
        assert_eq!(resolved.bindings.len(), 3);
    }

    #[test]
    fn two_actions_on_the_same_keys_is_a_conflict() {
        let settings = Settings {
            shelf_hotkey: Settings::default().capture_hotkey,
            ..Settings::default()
        };
        let resolved = resolve(&settings);

        // The first one still works; the loser is named.
        assert_eq!(resolved.bindings.len(), 1);
        assert_eq!(resolved.bindings[0].0, Action::CaptureRegion);
        assert_eq!(resolved.conflicts.len(), 1);
        assert_eq!(resolved.conflicts[0].action, Action::ShowShelf);
        assert_eq!(resolved.conflicts[0].setting_key, "shelfHotkey");
        assert!(resolved.conflicts[0].message.contains("Capture area"));
    }

    #[test]
    fn an_unparsable_accelerator_is_a_conflict_not_a_panic() {
        let settings = Settings {
            capture_hotkey: "Ctrl+Shift+NotAKey".to_string(),
            ..Settings::default()
        };
        let resolved = resolve(&settings);

        // The other shortcut is unaffected.
        assert_eq!(resolved.bindings.len(), 1);
        assert_eq!(resolved.bindings[0].0, Action::ShowShelf);
        assert_eq!(resolved.conflicts.len(), 1);
        assert_eq!(resolved.conflicts[0].action, Action::CaptureRegion);
    }

    #[test]
    fn conflict_messages_follow_the_design_voice() {
        let settings = Settings {
            shelf_hotkey: Settings::default().capture_hotkey,
            capture_hotkey: "Ctrl+Shift+NotAKey".to_string(),
            ..Settings::default()
        };
        for conflict in resolve(&settings).conflicts {
            assert!(!conflict.message.contains('!'), "{}", conflict.message);
            assert!(conflict.message.ends_with('.'), "{}", conflict.message);
        }
    }

    #[test]
    fn validate_patch_accepts_a_good_accelerator() {
        let patch = serde_json::json!({ "captureHotkey": "CmdOrCtrl+Shift+5" });
        assert!(validate_patch(patch.as_object().expect("object")).is_ok());
    }

    #[test]
    fn validate_patch_rejects_nonsense_before_it_reaches_disk() {
        let patch = serde_json::json!({ "shelfHotkey": "Ctrl+Shift+NotAKey" });
        assert!(matches!(
            validate_patch(patch.as_object().expect("object")),
            Err(HotkeyError::Unparsable { .. })
        ));
    }

    #[test]
    fn only_the_full_screen_hotkey_may_be_cleared() {
        let clearable = serde_json::json!({ "fullScreenHotkey": null });
        assert!(validate_patch(clearable.as_object().expect("object")).is_ok());

        let required = serde_json::json!({ "captureHotkey": null });
        assert!(matches!(
            validate_patch(required.as_object().expect("object")),
            Err(HotkeyError::Required {
                key: "captureHotkey"
            })
        ));
    }

    #[test]
    fn keys_we_do_not_own_are_left_alone() {
        let patch = serde_json::json!({ "shelfSide": "left", "theme": "dark" });
        assert!(validate_patch(patch.as_object().expect("object")).is_ok());
    }
}

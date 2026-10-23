//! In-app updates (ARCHITECTURE §9).
//!
//! Hopshot checks quietly and **never installs without being asked**. It is a tray app that is
//! always running: replacing the binary and restarting mid-capture would drop the overlay and
//! read as a crash. So the background task only ever *finds* an update and says so; the
//! download starts on an explicit click.
//!
//! Every download is verified against a minisign public key compiled into the binary
//! (`plugins.updater.pubkey` in tauri.conf.json). An unsigned or tampered payload is refused
//! by the plugin before anything is written — that check is the whole reason this is safe to
//! ship to a paid app.
//!
//! The Microsoft Store build compiles with the `store` feature, where the plugin is never
//! registered and everything below becomes a stub: MSIX packages cannot replace themselves
//! and Store policy forbids trying. One switch decides both, so the two cannot disagree.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// An update that is ready to install, as the UI needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// The release notes, which for us is the body of the GitHub release.
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Emitted when the background check finds something. The UI listens for this the same way
/// the licence pane listens for `license:changed`.
pub const UPDATE_AVAILABLE: &str = "update:available";

/// How long after launch the first check runs.
///
/// Not immediate: launch already does the shelf store, the tray, the hotkeys and the vault
/// socket, and an update check is the least urgent of them.
const FIRST_CHECK_DELAY: std::time::Duration = std::time::Duration::from_secs(30);

/// And how often after that. A desktop app that is left running for weeks still needs to
/// notice a release, but checking more often than daily is just noise on GitHub.
const CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

#[cfg(not(feature = "store"))]
mod imp {
    use super::*;
    use tauri_plugin_updater::UpdaterExt;

    /// Can this build update itself at all?
    pub fn supported() -> bool {
        true
    }

    /// Ask the endpoint whether there is anything newer. `None` means up to date.
    pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
        let updater = app.updater().map_err(|error| error.to_string())?;

        match updater.check().await {
            Ok(Some(update)) => Ok(Some(UpdateInfo {
                version: update.version.clone(),
                notes: update.body.clone(),
                date: update.date.map(|date| date.to_string()),
            })),
            Ok(None) => Ok(None),
            // Offline is the common case and must not reach the user as an error.
            Err(error) => Err(error.to_string()),
        }
    }

    /// Download, verify, apply, restart.
    ///
    /// Re-checks rather than trusting a handle the UI found earlier: the click can come long
    /// after the check, and `Update` is not something to keep lying around.
    pub async fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let updater = app.updater().map_err(|error| error.to_string())?;

        let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
            return Err("There's no update to install.".into());
        };

        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|error| error.to_string())?;

        log::info!("update installed; restarting");
        // Does not return.
        app.restart();
    }
}

#[cfg(feature = "store")]
mod imp {
    use super::*;

    /// The Store updates the app itself, so this build must not try (ARCHITECTURE §9).
    pub fn supported() -> bool {
        false
    }

    pub async fn check<R: Runtime>(_app: &AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
        Ok(None)
    }

    pub async fn install<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
        Err("Updates for this build come from the Microsoft Store.".into())
    }
}

pub use imp::{check, install, supported};

/// Start the background check: once shortly after launch, then daily.
///
/// A plain thread that blocks on each check, matching `cloud::live` and `license::poll_claim`
/// rather than dragging a tokio dependency in for two sleeps. Failures are logged at debug and
/// dropped — being offline, or GitHub being briefly unreachable, is not something to tell the
/// user about, and the next tick tries again.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    if !supported() {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);

        loop {
            match tauri::async_runtime::block_on(check(&app)) {
                Ok(Some(info)) => {
                    log::info!("update available: {}", info.version);
                    use tauri::Emitter;
                    if let Err(error) = app.emit(UPDATE_AVAILABLE, &info) {
                        log::warn!("could not announce the update: {error}");
                    }
                }
                Ok(None) => log::debug!("no update available"),
                Err(error) => log::debug!("update check failed: {error}"),
            }

            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

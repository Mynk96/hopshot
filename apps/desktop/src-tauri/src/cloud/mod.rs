//! Cloudflare API client (ARCHITECTURE §7). Phase 3.2 onwards.

pub mod client;
pub mod drops;
pub mod live;
pub mod vault;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DeleteAllError {
    #[error(transparent)]
    Drops(#[from] drops::DropError),
    #[error(transparent)]
    Vault(#[from] vault::VaultError),
}

/// What "Delete all my cloud data" removed, for the confirmation line in Settings.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeletion {
    /// Send links taken offline.
    pub links: usize,
    /// Whether a phone vault existed and was deleted (synced items and paired phones).
    pub vault: bool,
}

/// "Delete all my cloud data" (DESIGN S7 Privacy): every send link, then the phone vault.
/// The shelf on this computer is untouched, which is what the confirm copy promises.
pub fn delete_all<R: Runtime>(app: &AppHandle<R>) -> Result<CloudDeletion, DeleteAllError> {
    let links = drops::delete_all(app)?;

    live::stop(app);
    let vault = match vault::delete_everything() {
        Ok(()) => true,
        // Never paired a phone: there is no vault to delete.
        Err(vault::VaultError::NotPaired) => false,
        Err(error) => return Err(error.into()),
    };

    Ok(CloudDeletion { links, vault })
}

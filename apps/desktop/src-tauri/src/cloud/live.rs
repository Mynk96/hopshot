//! The live vault socket (ARCHITECTURE §7.4, PRD F4.3/F4.5).
//!
//! One background thread per app run: mint a ticket, open a WebSocket, read events, and on
//! any failure back off and try again. If the socket cannot be held at all, fall back to
//! polling `GET /items?since=` every 15 s — slower than F4.3's 3 s target but never silent.
//!
//! Synchronous `tungstenite` on its own thread rather than async: the rest of the app is
//! blocking (`ureq`, `rusqlite`), and one long-lived connection does not justify an async
//! runtime.
//!
//! Nothing here can read item contents. Events carry ids and sealed metadata; the unsealing
//! happens in `cloud::vault` with the keychain key.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tungstenite::ClientRequestBuilder;

use crate::cloud::client;
use crate::cloud::vault::{self, ItemSummary};
use crate::secrets::VaultCredentials;

/// ARCHITECTURE §7.4: "clients fall back to polling every 15 s if the socket drops".
const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Reconnect backoff, capped so a long outage does not become a long silence.
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A read timeout turns a dead-but-open socket into a reconnect instead of a hang.
const READ_TIMEOUT: Duration = Duration::from_secs(70);

/// Server → client events (ARCHITECTURE §7.4).
///
/// `rename_all_fields` is load-bearing: the Worker sends `deviceId`, and without it
/// `device.revoked` fails to parse and this client never learns it has been unpaired.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum LiveEvent {
    #[serde(rename = "item.created")]
    ItemCreated { item: ItemSummary },
    #[serde(rename = "item.deleted")]
    ItemDeleted { id: String },
    #[serde(rename = "device.joined")]
    DeviceJoined {
        #[serde(default)]
        device: serde_json::Value,
    },
    #[serde(rename = "device.revoked")]
    DeviceRevoked { device_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    ticket: String,
}

/// Handle for stopping the connection loop.
#[derive(Clone)]
pub struct Live {
    stop: Arc<AtomicBool>,
}

impl Live {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Start the live connection for a vault. Returns immediately; the work is on a thread.
pub fn start<R: Runtime>(app: &AppHandle<R>, credentials: VaultCredentials) -> Live {
    let stop = Arc::new(AtomicBool::new(false));
    let handle = app.clone();
    let flag = stop.clone();

    std::thread::spawn(move || run(&handle, &credentials, &flag));

    Live { stop }
}

/// Managed state so the connection can be started once and stopped later.
struct Running(std::sync::Mutex<Option<Live>>);

/// Start the live connection if a vault exists and one is not already running.
///
/// Called at startup and again right after pairing — the second call matters because at
/// startup there is usually no vault yet, and without it the first phone would not be seen
/// until the app restarted.
pub fn ensure_running<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;

    let Ok(Some(credentials)) = vault::credentials() else {
        return;
    };

    // Managed on first use: `setup` runs before any vault exists.
    if app.try_state::<Running>().is_none() {
        app.manage(Running(std::sync::Mutex::new(None)));
    }

    let state = app.state::<Running>();
    let Ok(mut slot) = state.0.lock() else {
        log::warn!("the live-connection lock was poisoned");
        return;
    };

    if slot.is_some() {
        return;
    }
    *slot = Some(start(app, credentials));
}

/// Stop the live connection, if one is running.
pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;

    if let Some(state) = app.try_state::<Running>() {
        if let Ok(mut slot) = state.0.lock() {
            if let Some(live) = slot.take() {
                live.stop();
            }
        }
    }
}

/// Connect, read, reconnect. Returns only when asked to stop.
fn run<R: Runtime>(app: &AppHandle<R>, credentials: &VaultCredentials, stop: &AtomicBool) {
    let mut backoff = BACKOFF_START;
    // Items created while we were disconnected have to be caught up on, so the high-water
    // mark survives reconnects rather than restarting from zero each time.
    let mut since = 0i64;

    while !stop.load(Ordering::Relaxed) {
        // Reconcile first: whatever arrived while the socket was down is fetched over HTTP,
        // which is also the whole of the polling fallback when the socket never comes up.
        match catch_up(app, credentials, since) {
            Ok(Some(newest)) => since = newest,
            Ok(None) => {}
            Err(error) => log::warn!("vault catch-up failed: {error}"),
        }

        match hold_socket(app, credentials, stop, &mut since) {
            Ok(()) => {
                // A clean close is the server asking us to go away: revoked, or shutting
                // down. Reconnecting immediately would hammer it.
                log::info!("live socket closed cleanly");
                backoff = BACKOFF_START;
            }
            Err(LiveError::Revoked) => {
                // PRD F4.7: this device is no longer paired. Nothing to reconnect to.
                log::info!("this device was revoked; the live socket is done");
                return;
            }
            Err(error) => {
                log::warn!("live socket dropped: {error}");
            }
        }

        // Sleep in short slices so a quit does not wait out a 60-second backoff.
        let mut slept = Duration::ZERO;
        let slice = Duration::from_millis(250);
        while slept < backoff.min(POLL_INTERVAL) && !stop.load(Ordering::Relaxed) {
            std::thread::sleep(slice);
            slept += slice;
        }

        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

#[derive(Debug, thiserror::Error)]
enum LiveError {
    #[error("this device is no longer paired")]
    Revoked,
    #[error("{0}")]
    Transport(String),
}

/// Fetch anything newer than `since` and push it into the shelf.
///
/// Returns the newest `created_at` seen, so the caller can advance its high-water mark.
fn catch_up<R: Runtime>(
    app: &AppHandle<R>,
    credentials: &VaultCredentials,
    since: i64,
) -> Result<Option<i64>, vault::VaultError> {
    let items = vault::list(credentials, since)?;
    if items.is_empty() {
        return Ok(None);
    }

    let mut newest = since;
    // The API returns newest-first; take them oldest-first so the shelf ends up in order.
    for item in items.iter().rev() {
        newest = newest.max(item.created_at);
        receive(app, credentials, item);
    }

    Ok(Some(newest))
}

/// Open one socket and read it until it fails.
fn hold_socket<R: Runtime>(
    app: &AppHandle<R>,
    credentials: &VaultCredentials,
    stop: &AtomicBool,
    since: &mut i64,
) -> Result<(), LiveError> {
    let ticket: Ticket = client::post_json(
        &format!("/vaults/{}/live-ticket", credentials.vault_id),
        &serde_json::json!({}),
        &[("Authorization", &format!("Bearer {}", credentials.device_token))],
    )
    .map_err(|error| match &error {
        // A 401 on the ticket means the token is dead, not that the network is bad.
        client::ClientError::Api { code, .. } if code == "unauthorized" => LiveError::Revoked,
        _ => LiveError::Transport(error.to_string()),
    })?;

    // The socket URL is the API base with the scheme swapped.
    let base = client::base_url();
    let ws_base = base
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| base.strip_prefix("http://").map(|rest| format!("ws://{rest}")))
        .unwrap_or(base);

    let url = format!(
        "{ws_base}/vaults/{}/live?ticket={}",
        credentials.vault_id, ticket.ticket
    );

    let request = ClientRequestBuilder::new(
        url.parse()
            .map_err(|error: tungstenite::http::uri::InvalidUri| {
                LiveError::Transport(error.to_string())
            })?,
    );

    let (mut socket, _response) = tungstenite::connect(request)
        .map_err(|error| LiveError::Transport(error.to_string()))?;

    // Without a read timeout a half-open connection — the usual outcome of a laptop
    // sleeping or a NAT dropping state — blocks this thread forever and sync stops
    // silently, which is the worst failure mode available.
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_ref() {
        let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    } else if let tungstenite::stream::MaybeTlsStream::Rustls(tls) = socket.get_ref() {
        let _ = tls.get_ref().set_read_timeout(Some(READ_TIMEOUT));
    }

    log::info!("live socket open for vault {}", credentials.vault_id);

    while !stop.load(Ordering::Relaxed) {
        match socket.read() {
            Ok(tungstenite::Message::Text(text)) => {
                handle(app, credentials, &text, since);
            }
            Ok(tungstenite::Message::Close(frame)) => {
                // 1008 is the server telling us this device was revoked (VaultHub::kick).
                if frame.as_ref().is_some_and(|f| u16::from(f.code) == 1008) {
                    return Err(LiveError::Revoked);
                }
                return Ok(());
            }
            Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_)) => {}
            Ok(_) => {}
            Err(error) => return Err(LiveError::Transport(error.to_string())),
        }
    }

    let _ = socket.close(None);
    Ok(())
}

/// Decode one event and act on it.
fn handle<R: Runtime>(
    app: &AppHandle<R>,
    credentials: &VaultCredentials,
    text: &str,
    since: &mut i64,
) {
    // A payload we cannot parse is a server/client version skew, not a reason to drop the
    // connection: the next event may well be one we understand.
    let Ok(event) = serde_json::from_str::<LiveEvent>(text) else {
        log::warn!("unrecognised live event");
        return;
    };

    match event {
        LiveEvent::ItemCreated { item } => {
            *since = (*since).max(item.created_at);
            receive(app, credentials, &item);
        }
        LiveEvent::ItemDeleted { id } => {
            log::info!("vault item {id} was deleted elsewhere");
            crate::shelf::changed(app);
        }
        LiveEvent::DeviceJoined { .. } | LiveEvent::DeviceRevoked { .. } => {
            // Settings → Devices re-reads the list when it hears this.
            let _ = tauri::Emitter::emit(app, "devices:changed", ());
        }
    }
}

/// Pull one item down, unseal it and put it on the shelf (PRD F4.5).
fn receive<R: Runtime>(
    app: &AppHandle<R>,
    credentials: &VaultCredentials,
    item: &ItemSummary,
) {
    // Our own uploads come back on the socket too; adopting them would duplicate every
    // capture on the computer that made it.
    if item.source_device_id == credentials.device_id {
        return;
    }

    let meta = match vault::open_meta(credentials, &item.id, &item.meta) {
        Ok(meta) => meta,
        Err(error) => {
            // Almost always a key mismatch: the vault was re-created and this phone still
            // holds the old key. Not recoverable here, and not worth retrying.
            log::warn!("could not unseal metadata for {}: {error}", item.id);
            return;
        }
    };

    let png = match vault::download(credentials, &item.id) {
        Ok(png) => png,
        Err(error) => {
            log::warn!("could not fetch vault item {}: {error}", item.id);
            return;
        }
    };

    match crate::shelf::add_from_vault(app, &item.id, &png, &meta) {
        Ok(()) => log::info!("received {} from {}", meta.file_name, meta.origin_device.as_deref().unwrap_or("a device")),
        Err(error) => log::warn!("could not put vault item {} on the shelf: {error}", item.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_parse_into_their_variants() {
        let created = r#"{"type":"item.created","item":{"id":"abc","sourceDeviceId":"dev","size":10,"meta":"bWV0YQ","createdAt":5,"expiresAt":9}}"#;
        match serde_json::from_str::<LiveEvent>(created).expect("item.created") {
            LiveEvent::ItemCreated { item } => {
                assert_eq!(item.id, "abc");
                assert_eq!(item.source_device_id, "dev");
                assert_eq!(item.created_at, 5);
            }
            other => panic!("wrong variant: {other:?}"),
        }

        match serde_json::from_str::<LiveEvent>(r#"{"type":"item.deleted","id":"gone"}"#)
            .expect("item.deleted")
        {
            LiveEvent::ItemDeleted { id } => assert_eq!(id, "gone"),
            other => panic!("wrong variant: {other:?}"),
        }

        match serde_json::from_str::<LiveEvent>(r#"{"type":"device.revoked","deviceId":"d1"}"#)
            .expect("device.revoked")
        {
            LiveEvent::DeviceRevoked { device_id } => assert_eq!(device_id, "d1"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// Version skew must not take the connection down.
    #[test]
    fn an_unknown_event_type_is_not_fatal() {
        assert!(serde_json::from_str::<LiveEvent>(r#"{"type":"vault.exploded"}"#).is_err());
    }

    /// The backoff has to be bounded, or a long outage becomes a permanent one.
    #[test]
    fn the_backoff_is_capped() {
        let mut backoff = BACKOFF_START;
        for _ in 0..20 {
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
        assert_eq!(backoff, BACKOFF_MAX);
        assert!(BACKOFF_MAX <= Duration::from_secs(60));
    }

    #[test]
    fn stopping_is_visible_to_the_loop() {
        let live = Live {
            stop: Arc::new(AtomicBool::new(false)),
        };
        assert!(!live.stop.load(Ordering::Relaxed));
        live.stop();
        assert!(live.stop.load(Ordering::Relaxed));
    }
}

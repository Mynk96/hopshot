//! The `#[tauri::command]` surface (ARCHITECTURE §5.4). Thin by rule: validate input and
//! delegate to the modules below — no business logic here (CLAUDE.md rule 3).

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::{capture, cloud, hotkeys, license, settings, shelf};

/// Settings plus whatever Hopshot failed to bind, so the Settings screen can show both in
/// one round trip (PRD F1.1: "Conflicts are detected and shown in Settings").
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    pub settings: settings::Settings,
    pub hotkey_conflicts: Vec<hotkeys::Conflict>,
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<SettingsResponse, String> {
    Ok(SettingsResponse {
        settings: settings::load(&app).map_err(|error| error.to_string())?,
        hotkey_conflicts: app.state::<hotkeys::Conflicts>().get(),
    })
}

/// Merge a patch into `settings.json` and re-bind the global shortcuts.
#[tauri::command]
pub fn set_settings(app: AppHandle, patch: Map<String, Value>) -> Result<SettingsResponse, String> {
    hotkeys::validate_patch(&patch).map_err(|error| error.to_string())?;
    let settings = settings::patch(&app, patch).map_err(|error| error.to_string())?;
    let hotkey_conflicts = hotkeys::apply(&app, &settings);
    Ok(SettingsResponse {
        settings,
        hotkey_conflicts,
    })
}

#[tauri::command]
pub fn start_capture(app: AppHandle, mode: capture::Mode) {
    capture::start(&app, mode);
}

/// What this overlay should draw, for a webview that booted after `overlay:start` fired.
#[tauri::command]
pub fn overlay_pending(
    app: AppHandle,
    monitor_id: u32,
) -> Option<capture::overlay::OverlayStart> {
    capture::pending(&app, monitor_id)
}

/// The overlay finished a drag (ARCHITECTURE §5.4). `rect` is CSS px, monitor-local.
#[tauri::command]
pub fn overlay_commit(
    app: AppHandle,
    monitor_id: u32,
    rect: capture::SelectionRect,
) -> Result<String, String> {
    capture::commit(&app, monitor_id, rect)
        .map(|path| path.display().to_string())
        .map_err(|error| error.to_string())
}

/// `F` on the overlay — capture the whole monitor it is covering (PRD F1.3).
#[tauri::command]
pub fn overlay_commit_full(app: AppHandle, monitor_id: u32) -> Result<String, String> {
    capture::commit_full(&app, monitor_id)
        .map(|path| path.display().to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn overlay_cancel(app: AppHandle) {
    capture::cancel(&app);
}

/// `permissions_status()` (ARCHITECTURE §5.4).
#[tauri::command]
pub fn permissions_status() -> capture::permissions::ScreenAccess {
    capture::permissions::status()
}

#[tauri::command]
pub fn permissions_open_settings() {
    capture::permissions::open_settings();
}

#[tauri::command]
pub fn show_shelf(app: AppHandle) {
    shelf::show(&app);
}

#[tauri::command]
pub fn hide_shelf(app: AppHandle) {
    shelf::hide(&app);
}

/// The shelf measured its own content; park it against the screen edge at that height.
#[tauri::command]
pub fn resize_shelf(app: AppHandle, height: f64) {
    shelf::set_height(&app, height);
}

/* ── Vault: pairing, devices, cloud data (PRD F4, ARCHITECTURE §7.2) ──────── */

/// Is a phone paired with this computer yet (DESIGN S7 → Devices)?
#[tauri::command]
pub fn vault_status(app: AppHandle) -> Result<Option<String>, String> {
    let _ = &app;
    cloud::vault::credentials()
        .map(|found| found.map(|credentials| credentials.vault_id))
        .map_err(|error| error.to_string())
}

/// `pair_phone()` — mint an invite and return the QR for it (PRD F4.1).
///
/// The returned URL carries the invite code *and* the vault key in its fragment, so it is
/// only ever rendered as a QR on this machine; it is never logged or sent anywhere.
#[tauri::command]
pub fn pair_phone(app: AppHandle) -> Result<Pairing, String> {
    let install_id = cloud::drops::install_id(&app);
    let device_name = cloud::vault::hostname();

    let (url, expires_at) = cloud::vault::new_pairing(&install_id, &device_name)
        .map_err(|error| error.to_string())?;

    let qr_svg = cloud::drops::qr_svg(&url);

    // Starting the socket here means the computer hears `device.joined` and the first
    // item the phone sends without waiting for a restart.
    cloud::live::ensure_running(&app);

    Ok(Pairing {
        url,
        expires_at,
        qr_svg,
    })
}

/// A pairing QR (DESIGN S7). `url` stays in the UI; the fragment is the secret.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub url: String,
    pub expires_at: i64,
    pub qr_svg: String,
}

#[tauri::command]
pub fn list_devices(app: AppHandle) -> Result<Vec<cloud::vault::DeviceSummary>, String> {
    let _ = &app;
    cloud::vault::devices().map_err(|error| error.to_string())
}

/// Revoke a device (PRD F4.7). The server closes its socket as part of this.
#[tauri::command]
pub fn revoke_device(app: AppHandle, device_id: String) -> Result<(), String> {
    let _ = &app;
    cloud::vault::revoke(&device_id).map_err(|error| error.to_string())
}

/// "Delete all my cloud data" (DESIGN S7 → Privacy). The local shelf is untouched.
#[tauri::command]
pub fn delete_cloud_data(app: AppHandle) -> Result<(), String> {
    cloud::live::stop(&app);
    cloud::vault::delete_everything().map_err(|error| error.to_string())
}

/* ── Licence and the computer limit (PRD F8.3, DESIGN S9) ─────────────────── */

/// `license_status()` — may this computer run, and on what plan?
///
/// `None` means never licensed, which is the normal state during the trial.
#[tauri::command]
pub fn license_status(app: AppHandle) -> Result<Option<license::LicenseStatus>, String> {
    let _ = &app;
    license::status().map_err(|error| error.to_string())
}

/// DESIGN S9 "Move it here?" — free another computer and license this one.
#[tauri::command]
pub fn license_move_here(
    app: AppHandle,
    release_device_id: String,
) -> Result<license::LicenseStatus, String> {
    let _ = &app;
    license::move_here(&release_device_id).map_err(|error| error.to_string())
}

/// DESIGN S9 "Remove one to use it here" — free a slot on a Sync licence.
#[tauri::command]
pub fn license_remove_computer(app: AppHandle, device_id: String) -> Result<(), String> {
    let _ = &app;
    license::remove_computer(&device_id).map_err(|error| error.to_string())
}

/// Which phones this item can be sent to without a QR (DESIGN S4).
///
/// Empty means nothing is paired, and the send sheet shows a QR instead.
#[tauri::command]
pub fn paired_phones(app: AppHandle) -> Result<Vec<String>, String> {
    let _ = &app;
    // Offline is not an error here: it just means we cannot confirm a phone, and the sheet
    // falls back to the QR, which is the safe default.
    Ok(cloud::vault::paired_phones().unwrap_or_default())
}

/// `send_to_phones(id)` — put the item in the vault so it lands on the paired phones.
///
/// Returns the names it reached. An empty list means nothing was paired and the caller
/// should offer the QR.
#[tauri::command]
pub fn send_to_phones(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    cloud::vault::send_to_phones(&app, &id).map_err(|error| error.to_string())
}

/// Widen the shelf while the send sheet is open (DESIGN S4 wants a 260 px popover, which
/// does not fit in a 208 px window), and narrow it again on close.
#[tauri::command]
pub fn set_shelf_wide(app: AppHandle, wide: bool, height: f64) {
    let width = if wide {
        shelf::SHELF_WIDTH_WITH_SHEET
    } else {
        shelf::SHELF_WIDTH
    };
    shelf::set_size(&app, width, height);
}

/// Did the OS give the shelf a backdrop? Decides glass vs. solid (DESIGN §7).
#[tauri::command]
pub fn shelf_has_vibrancy(app: AppHandle) -> bool {
    shelf::has_vibrancy(&app)
}

/// `list_items()` (ARCHITECTURE §5.4).
#[tauri::command]
pub fn list_items(app: AppHandle) -> Result<Vec<shelf::store::Item>, String> {
    shelf::list(&app).map_err(|error| error.to_string())
}

/// `delete_item(id)` (ARCHITECTURE §5.4, PRD F2.6).
#[tauri::command]
pub fn delete_item(app: AppHandle, id: String) -> Result<(), String> {
    shelf::delete(&app, &id).map_err(|error| error.to_string())
}

/// `pin_item(id, pinned)` (ARCHITECTURE §5.4, PRD F2.11).
#[tauri::command]
pub fn pin_item(app: AppHandle, id: String, pinned: bool) -> Result<shelf::store::Item, String> {
    shelf::set_pinned(&app, &id, pinned).map_err(|error| error.to_string())
}

/// `copy_item(id)` (ARCHITECTURE §5.4, PRD F2.5).
#[tauri::command]
pub fn copy_item(app: AppHandle, id: String) -> Result<(), String> {
    shelf::copy(&app, &id).map_err(|error| error.to_string())
}

/// `prepare_drag(id) -> {path, icon}` (ARCHITECTURE §5.4, PRD F2.4).
#[tauri::command]
pub fn prepare_drag(app: AppHandle, id: String) -> Result<shelf::DragPaths, String> {
    shelf::prepare_drag(&app, &id).map_err(|error| error.to_string())
}

/// `drag_finished(id, dropped)` — the native drag loop ended (PRD F2.10).
///
/// `dropped` is false for a cancelled drag. Whether that means the item goes is the
/// "Remove after dragging out" setting, which Rust reads.
#[tauri::command]
pub fn drag_finished(app: AppHandle, id: String, dropped: bool) -> Result<(), String> {
    shelf::drag_finished(&app, &id, dropped).map_err(|error| error.to_string())
}

/// `save_item_as(id)` (ARCHITECTURE §5.4, PRD F2.9).
///
/// The native save dialog is blocking, so it runs on a worker thread; returning `None`
/// means the user dismissed it, which is not an error.
#[tauri::command]
pub async fn save_item_as(app: AppHandle, id: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let suggested = shelf::list(&app)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == id)
        .map(|item| item.file_name)
        .unwrap_or_else(|| "Screenshot.png".to_string());

    let chosen = app
        .dialog()
        .file()
        .set_file_name(&suggested)
        .add_filter("PNG image", &["png"])
        .blocking_save_file();

    let Some(destination) = chosen else {
        return Ok(None);
    };
    let destination = destination
        .into_path()
        .map_err(|error| error.to_string())?;

    shelf::save_as(&app, &id, &destination).map_err(|error| error.to_string())?;
    Ok(Some(destination.display().to_string()))
}

/// `reveal_item(id)` (ARCHITECTURE §5.4, PRD F2.6).
#[tauri::command]
pub fn reveal_item(app: AppHandle, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let path = shelf::path_of(&app, &id).map_err(|error| error.to_string())?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| error.to_string())
}

/// `send_drop(id, ttl) -> {url, expiresAt}` (ARCHITECTURE §5.4, PRD F3.1).
///
/// Encryption and upload are blocking, so this runs on a worker thread rather than
/// stalling the shelf.
///
/// An absent `ttl` takes the plan's first lifetime from `config/limits.json`, so the UI
/// never has to know the limits (CLAUDE.md rule 2).
#[tauri::command]
pub async fn send_drop(
    app: AppHandle,
    id: String,
    ttl: Option<String>,
) -> Result<crate::cloud::drops::Drop, String> {
    let plan = crate::license::current_plan(&app);
    let Some(ttl) = ttl.or_else(|| plan.default_drop_ttl().map(str::to_string)) else {
        return Err("No drop lifetime is configured.".to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::cloud::drops::send(&app, &id, &ttl).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `delete_drop(id)` (ARCHITECTURE §5.4, PRD F3.5).
#[tauri::command]
pub async fn delete_drop(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::cloud::drops::delete(&app, &id).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// DESIGN S7 → General → Launch at login.
///
/// The OS registration is the source of truth rather than a mirrored setting: the user can
/// remove the login item outside Hopshot, and a stale `true` in settings.json would then
/// show a switch that lies.
#[tauri::command]
pub fn get_launch_at_login(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    manager.is_enabled().map_err(|e| e.to_string())
}

/// What the Settings screen needs to decide which controls are locked (ARCHITECTURE §5.4
/// `get_plan`). Phase 4 replaces the stubbed plan with the real licence lookup.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStatus {
    pub plan: crate::limits::Plan,
    pub includes_sync: bool,
    pub shelf_capacity: u32,
    pub item_ttl_options: Vec<String>,
}

#[tauri::command]
pub fn get_plan(app: AppHandle) -> PlanStatus {
    let plan = crate::license::current_plan(&app);
    let limits = crate::limits::limits();

    PlanStatus {
        plan,
        includes_sync: plan.includes_sync(),
        shelf_capacity: limits.lifetime.shelf_capacity,
        item_ttl_options: limits.lifetime.item_ttl_options.clone(),
    }
}

/// Stub for the plans sheet a locked Sync control opens (DESIGN S6). Phase 4 builds it.
#[tauri::command]
pub fn open_plans(app: AppHandle) {
    log::info!("open_plans() — the plans sheet arrives in Phase 4");
    let _ = app.emit(
        "toast",
        serde_json::json!({ "kind": "info", "text": "Plans arrive in Phase 4" }),
    );
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    crate::show_settings_window(&app).map_err(|error| error.to_string())
}

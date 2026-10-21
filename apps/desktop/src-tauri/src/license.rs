//! Keyless activation: claim, restore, device limit, plan resolution (ARCHITECTURE §7.5).
//! Phase 4.

use tauri::{AppHandle, Runtime};

pub use crate::limits::Plan;

/// Stub: plan resolution lands in Phase 4. The tray menu already branches on this, so when
/// the real lookup arrives the menu becomes correct without touching lib.rs.
pub fn current_plan<R: Runtime>(_app: &AppHandle<R>) -> Plan {
    Plan::Trial
}

/// Stub: PRD F8.2 opens Stripe Checkout in the browser. Phase 4.
pub fn open_checkout<R: Runtime>(_app: &AppHandle<R>, plan: Plan) {
    log::info!("license::open_checkout({plan:?}) — stub until Phase 4");
}

// `start_pairing` is gone: pairing is implemented in `cloud::vault` and reached through
// Settings -> Devices. The stub here was wired to the tray menu, so the menu item silently
// did nothing.

//! Typed loader for `config/limits.json` — the ONLY place plan limits live (CLAUDE.md rule 2,
//! ARCHITECTURE §4). The TypeScript side loads the same file in `packages/shared/src/limits.ts`.
//! Never hard-code a limit anywhere else.

use std::sync::OnceLock;

use serde::Deserialize;

/// Compiled into the binary, so the limits can never drift from the repo at runtime.
const LIMITS_JSON: &str = include_str!("../../../../config/limits.json");

/// ARCHITECTURE §4 plan resolution order: expired → lifetime → sync.
///
/// `Expired` means "no active licence" — never bought, or bought and refunded. Hopshot is
/// pay-first (PRD F8.1): there is no trial, so every new install starts here with capture
/// paused until a purchase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Expired,
    Lifetime,
    Sync,
}

impl Plan {
    /// Whether this plan can use the vault — phone pairing and sync (ARCHITECTURE §4).
    ///
    /// Read from `config/limits.json` rather than hard-coded, so moving sync between plans
    /// is a config change (CLAUDE.md rule 2).
    pub fn includes_sync(self) -> bool {
        match self {
            Plan::Expired => false,
            Plan::Lifetime => limits().lifetime.vault,
            Plan::Sync => limits().sync.vault,
        }
    }

    /// The drop lifetimes this plan may pick from (PRD F3.1), in `config/limits.json` order.
    ///
    /// Sync widens the choice; everything else shares the Lifetime list — the same shape as
    /// [`crate::shelf::store::capacity_for`].
    pub fn drop_ttl_options(self) -> &'static [String] {
        match self {
            Plan::Sync => &limits().sync.drop_ttl_options,
            _ => &limits().lifetime.drop_ttl_options,
        }
    }

    /// The lifetime a drop gets when the caller does not name one: the first option in
    /// `config/limits.json`, never a literal (CLAUDE.md rule 2).
    pub fn default_drop_ttl(self) -> Option<&'static str> {
        self.drop_ttl_options().first().map(String::as_str)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifetimeLimits {
    pub shelf_capacity: u32,
    pub item_ttl_options: Vec<String>,
    pub drop_ttl_options: Vec<String>,
    pub drops_per_day: u32,
    pub max_image_bytes: u64,
    pub max_computers: u32,
    pub vault: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLimits {
    pub requires: String,
    pub drop_ttl_options: Vec<String>,
    pub drops_per_day: u32,
    pub vault: bool,
    pub max_phones: u32,
    pub max_computers: u32,
    pub vault_uploads_per_day: u32,
    pub vault_live_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerLimits {
    pub max_ciphertext_bytes: u64,
    pub invite_ttl_seconds: u64,
    pub live_ticket_ttl_seconds: u64,
    pub license_recheck_days: u32,
    pub license_offline_grace_days: u32,
    pub per_ip_drops_per_day: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub lifetime: LifetimeLimits,
    pub sync: SyncLimits,
    pub server: ServerLimits,
}

/// Parsed once on first use. Panics only if the bundled JSON is malformed, which the unit
/// test below catches at build time.
pub fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        serde_json::from_str(LIMITS_JSON).expect("config/limits.json does not match Limits")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_bundled_limits_file() {
        let l = limits();
        assert_eq!(l.lifetime.shelf_capacity, 100);
        assert_eq!(l.sync.requires, "lifetime");
    }

    #[test]
    fn matches_architecture_section_4() {
        let l = limits();
        assert_eq!(l.lifetime.shelf_capacity, 100);
        assert_eq!(l.lifetime.drops_per_day, 10);
        assert_eq!(l.lifetime.max_image_bytes, 10_485_760);
        // PRD F8.3: Lifetime is one computer; three come with Sync.
        assert_eq!(l.lifetime.max_computers, 1);
        assert_eq!(l.sync.max_computers, 3);
        assert!(!l.lifetime.vault);
        assert_eq!(l.lifetime.item_ttl_options, ["1h", "24h", "7d"]);
        assert_eq!(l.lifetime.drop_ttl_options, ["24h"]);

        assert_eq!(l.sync.drops_per_day, 200);
        assert!(l.sync.vault);
        assert_eq!(l.sync.max_phones, 3);
        assert_eq!(l.sync.vault_live_bytes, 1_073_741_824);

        assert_eq!(l.server.max_ciphertext_bytes, 12_582_912);
        assert_eq!(l.server.invite_ttl_seconds, 600);
        assert_eq!(l.server.live_ticket_ttl_seconds, 60);
        assert_eq!(l.server.per_ip_drops_per_day, 100);
    }

    /// Drives the SYNC badge on the tray menu's "Pair phone…" row (DESIGN S1).
    #[test]
    fn sync_availability_follows_the_limits_file() {
        assert!(Plan::Sync.includes_sync());
        assert!(!Plan::Lifetime.includes_sync(), "sync is a paid add-on");
        assert!(!Plan::Expired.includes_sync());
    }

    /// `send_drop` falls back to this when the shelf does not pick a lifetime, so every plan
    /// has to offer at least one.
    #[test]
    fn every_plan_has_a_default_drop_ttl() {
        for plan in [Plan::Expired, Plan::Lifetime, Plan::Sync] {
            assert!(plan.default_drop_ttl().is_some(), "{plan:?}");
        }
        assert_eq!(Plan::Lifetime.default_drop_ttl(), Some("24h"));
        assert_eq!(Plan::Sync.drop_ttl_options().len(), 3);
    }

    /// A drop can never be larger than the server will accept.
    #[test]
    fn ciphertext_cap_leaves_room_for_the_image_cap() {
        let l = limits();
        assert!(l.server.max_ciphertext_bytes > l.lifetime.max_image_bytes);
    }
}

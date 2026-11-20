# Design: Free plan with daily caps, $10 once for everything

Status: APPROVED (founder, 2026-11-20) · Repo: Mynk96/hopshot
Supersedes docs/designs/pay-first-10.md (pay-first, nothing free). Keeps its price: **$10 once**.

## Why
The 20 Nov funnel check: ~850 visits, 9 installer downloads, **0 new installs ever opened**, 0 checkouts since launch. A downloaded app that does nothing until you pay is the leak. Feedback from a visitor said the same: a limited free version would let people try it and then upgrade. Ads were suggested and rejected: they cut against the privacy pitch (CLAUDE.md rule 1) and would earn almost nothing at this scale.

## Decision

| | **Free** (no licence, plan `expired`) | **$10 once** (`bundle` → `sync`) |
|---|---|---|
| Captures | `free.capturesPerDay` = 10 a day (local midnight) | Unlimited |
| Shelf holds | `free.shelfCapacity` = 10 | `lifetime.shelfCapacity` = 100 |
| Pinned | `free.maxPins` = 3 | Unlimited |
| Item expiry | 1h / 24h / 7d (same as paid; the site says "you pick") | 1h / 24h / 7d |
| Drag, copy, save | ✓ | ✓ |
| Send to phone by QR | `free.dropsPerDay` = 3 a day, `free.dropTtlOptions` = 24h | `sync.dropsPerDay` = 200, 1h/24h/7d |
| Paired phone, phone → computer, live sync | — (`free.vault` = false) | ✓ (3 phones) |
| Computers | 1 | 3 |

All numbers live in `config/limits.json` (CLAUDE.md rule 2).

### Names
The wire and type name for "no licence" stays **`expired`** (`PlanName`, Rust `Plan::Expired`), read everywhere as "Free". Renaming it would change the licence-status response that installed builds parse, for no user-visible gain.

## Where each limit is enforced
- **Captures and pins: on the device.** `stats.rs` keeps `freeDay` (local day + count) and `license::plan_state` turns it into `capturesLeft` / `capture_paused`. `shelf::set_pinned` refuses a pin past `maxPins`. A determined user can reset a local counter; at $10 that is not worth fighting.
- **Shelf size:** `shelf::store::capacity_for(plan)` → the expiry sweep drops the oldest unpinned items past it, as it already did at 100.
- **QR sends: on the server.** `POST /drops` no longer refuses `expired`; `limitsFor("expired")` returns the free caps. Install ids are client-made, so a fresh id would reset the per-install count; a separate per-network counter (`drops_free_ip`, `server.freePerIpDropsPerDay` = 20) is what bounds Free. Worst case per network: 20 × 12 MiB live, each gone within 24 h.
- **Vault (paired phone): on the server**, unchanged: `vaultLimitsFor("expired").vault` is false, so `POST /vaults` is refused with copy pointing at the upgrade.
- **Deny by default:** `limitsFor` / `vaultLimitsFor` are exhaustive switches; an unknown plan gets zero sends and no vault (previously it fell through to Lifetime caps).

## UI
- **Shelf banner** (the old locked-banner slot): "7 of 10 free screenshots left today · Unlimited + a paired phone: $10 once" with **Unlock · $10 once**. At 0: "That's today's 10 free screenshots" (tinted), and the hotkey shows a toast instead of capturing.
- **Send sheet:** Free goes straight to the QR (no paired phone to ask about) with a line on the daily allowance. When the server says today's sends are used, the message is shown with **Unlock** and **Restore**.
- **Onboarding:** the Pay step becomes a plan choice; the primary button is **Start free**, and Try it follows either way.
- **Settings → License:** "You're on Free: …" with **Unlock Hopshot · $10 once**.
- **Phone viewer:** a free send shows a small "Sent with Hopshot · Get it free for Mac & Windows" link (`/drops/{id}/info` returns `free`); a paid send shows only Report.

## Refunds
A refund or revocation drops the install to Free, not to a locked app. Items already on the shelf stay; past the free shelf size the oldest unpinned ones go at the next sweep.

## Release order
1. **API first** (`services/api`): backward compatible. Installed v0.1.13 builds still lock capture locally until they update; the only server-side change they can see is that a send from an unlicensed install is allowed at the free caps.
2. **Desktop v0.1.14** through the updater: locked installs become Free.
3. **apps/web** deploy (/pricing, /download, /terms, the viewer link).
4. **marketing/site** last (separate PR, it deploys on merge): "Download free" only once the free build is live.

## Measure (two weeks after v0.1.14)
- Installs that open and capture (pings with `days` > 0).
- How many Free installs hit the capture cap, and how many of those buy.
- If almost nobody hits 10/day, lower it; if many hit it and few buy, the paid side needs work, not a lower cap.

# Hopshot — Technical Architecture

This is the build spec that goes with `PRD.md`. It's written so Claude Code can implement it phase by phase (see `BUILD_PLAN.md`).

---

## 1. System overview

```
┌──────────────────────────── User's computer ────────────────────────────┐
│  Hopshot desktop app (Tauri v2)                                          │
│   ├─ Rust core: hotkeys · capture (xcap) · crop · local store (SQLite)   │
│   │             · expiry · clipboard · AES-GCM · API client · keychain   │
│   └─ Web UI (React + TS): shelf · overlay · settings · onboarding        │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ HTTPS (ciphertext only) + WebSocket (live events)
┌───────────────▼──────────── Cloudflare ─────────────────────────────────┐
│  api.hopshot.xyz  — Worker (Hono)                                        │
│   ├─ R2 bucket     : encrypted blobs (d/…, v/…)                          │
│   ├─ D1 (SQLite)   : drops, vaults, devices, invites, items, usage       │
│   ├─ Durable Object: VaultHub (one per vault, WebSocket fan-out)         │
│   ├─ Cron (15 min) : delete expired rows + objects                       │
│   └─ Cron (15 min)  : delete expired drops and vault items + their R2 objects       │
│  hopshot.xyz      — Pages (Astro): landing · /d/:id viewer · /app PWA    │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ HTTPS (decrypts in the browser)
┌───────────────┴──────────── Phone ──────────────────────────────────────┐
│  Browser / installed PWA: viewer, pairing, feed, upload                  │
└──────────────────────────────────────────────────────────────────────────┘
Payments: Stripe (Checkout, Billing, customer portal, webhooks). Licenses live in D1.
```

**Main principle:** the server is a dumb, short-lived store for **encrypted** bytes. All keys live on user devices, and the server can't see images or file names.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Tauri v2** (Rust) | Small binaries (~10 MB), low RAM, one codebase for Mac + Windows |
| Desktop UI | React 18 + TypeScript + Vite + Tailwind CSS + Zustand | Familiar, and Claude Code is fluent in it |
| Screen capture | `xcap` crate (Monitor::all, capture_image) | Cross-platform, maintained |
| Image processing | `image` crate (crop, thumbnails, PNG encode) | Standard |
| Drag-out | `@crabnebula/tauri-plugin-drag` (`drag-rs`) | Native file drag on macOS + Windows, works with Tauri v2 |
| Clipboard | `arboard` crate (image + text) | Reliable image clipboard on both OSes |
| Hotkeys | `tauri-plugin-global-shortcut` | Official |
| Other Tauri plugins | `autostart`, `updater`, `single-instance`, `deep-link` (`hopshot://` links), `store`, `notification`, `opener`, `positioner`, `log` | Official |
| Local DB | `rusqlite` (bundled) | Tiny, reliable |
| Secrets | `keyring` crate | macOS Keychain / Windows Credential Manager |
| Crypto | `aes-gcm`, `rand`, `sha2`, `base64` | AES-256-GCM |
| HTTP / WS | `reqwest` (rustls), `tokio-tungstenite` | — |
| Window effects | `window-vibrancy` (+ `objc2`/`objc2-app-kit` on macOS, `windows` crate on Windows for window flags) | Native glass look; overlay above full-screen apps |
| API | Cloudflare Workers + **Hono** + R2 + D1 + Durable Objects + Cron Triggers | Near-zero cost at small scale, no egress fees, global |
| Web | **Astro** + React islands + `@vite-pwa/astro`, deployed on Cloudflare Pages | Fast landing page (SEO) plus the app pages in one project |
| Phone QR scanner | `qr-scanner` (npm) | For the iOS home-screen re-pair flow |
| QR generation | `qrcode` (npm) in desktop UI | — |
| Payments / licensing | **Stripe** (Checkout, Billing subscriptions, customer portal) through the `stripe` npm SDK in the Worker; purchases and licensed computers tracked by the Worker (no user-facing keys); email through **Resend** | Fallback: a merchant of record (e.g. Polar) if tax handling becomes a burden |
| CI/CD | GitHub Actions + `tauri-apps/tauri-action`, `wrangler` | Builds Mac on macOS runners |
| Monorepo | pnpm workspaces | — |

---

## 3. Repository layout

```
hopshot/
├─ CLAUDE.md                     # instructions for Claude Code
├─ PRD.md  BUILD_PLAN.md
├─ docs/ ARCHITECTURE.md DESIGN.md LAUNCH.md
├─ design/ mockups.html
├─ config/
│  └─ limits.json                # SINGLE source of truth for plans/limits (read by Rust, TS, Worker)
├─ packages/
│  ├─ shared/                    # TS types (API DTOs), limits loader, constants
│  └─ crypto/                    # TS HOP1 envelope (WebCrypto) + test vectors
│     └─ test-vectors.json       # shared with Rust tests
├─ apps/
│  ├─ desktop/
│  │  ├─ src/                    # React UI
│  │  │  ├─ windows/ shelf/ overlay/ settings/ onboarding/
│  │  │  ├─ components/ lib/ store/
│  │  └─ src-tauri/
│  │     ├─ src/
│  │     │  ├─ lib.rs            # app setup, plugins, tray, activation policy
│  │     │  ├─ commands.rs       # #[tauri::command] surface (thin)
│  │     │  ├─ hotkeys.rs
│  │     │  ├─ capture/ { mod.rs, overlay.rs, crop.rs, frames.rs }
│  │     │  ├─ shelf/   { store.rs, files.rs, expiry.rs, thumbs.rs }
│  │     │  ├─ clipboard.rs
│  │     │  ├─ crypto.rs
│  │     │  ├─ cloud/   { client.rs, drops.rs, vault.rs, live.rs }
│  │     │  ├─ license.rs  secrets.rs  settings.rs  limits.rs
│  │     │  └─ platform/ { macos.rs, windows.rs }
│  │     ├─ tauri.conf.json
│  │     └─ tauri.microsoftstore.conf.json
│  └─ web/                       # Astro site + PWA
│     └─ src/pages/ index.astro pricing.astro download.astro privacy.astro terms.astro
│                   d/[id].astro pair.astro app/index.astro
├─ services/
│  └─ api/                       # Cloudflare Worker
│     ├─ src/ index.ts routes/ { drops.ts vaults.ts pair.ts items.ts live.ts license.ts billing.ts webhooks.ts admin.ts report.ts }
│     │       do/VaultHub.ts  lib/ { auth.ts ratelimit.ts stripe.ts license.ts email.ts ids.ts }  emails/
│     ├─ migrations/ 0001_init.sql
│     └─ wrangler.toml
└─ .github/workflows/ desktop-release.yml  api-deploy.yml  web-deploy.yml  ci.yml
```

---

## 4. Plans and limits — `config/limits.json`

Every limit lives here. Rust reads it with `include_str!` + serde, TS imports it, and the Worker bundles it. **Never hard-code a limit anywhere else.**

```json
{
  "lifetime": {
    "shelfCapacity": 100,
    "itemTtlOptions": ["1h", "24h", "7d"],
    "dropTtlOptions": ["24h"],
    "dropsPerDay": 10,
    "maxImageBytes": 10485760,
    "maxComputers": 1,
    "vault": false
  },
  "sync": {
    "requires": "lifetime",
    "dropTtlOptions": ["1h", "24h", "7d"],
    "dropsPerDay": 200,
    "vault": true,
    "maxPhones": 3,
    "maxComputers": 3,
    "vaultUploadsPerDay": 500,
    "vaultLiveBytes": 1073741824
  },
  "server": {
    "maxCiphertextBytes": 12582912,
    "inviteTtlSeconds": 600,
    "liveTicketTtlSeconds": 60,
    "licenseRecheckDays": 7,
    "licenseOfflineGraceDays": 30,
    "perIpDropsPerDay": 100
  }
}
```

Plan resolution: `expired` (nothing bought, or bought and refunded) → `lifetime` (valid Lifetime licence) → `sync` (valid Lifetime licence + active Sync subscription; gets Lifetime limits overridden by the `sync` block).

Hopshot is **pay-first** (PRD F8.1): there is no trial, so every install starts `expired` with capture paused, and a licence is the only thing that grants a plan. `resolvePlan` therefore reads one header — `X-Hopshot-License` — and anything else is `expired`, which is also what makes a refund take the app away.

---

## 5. Desktop app

### 5.1 Process and windows

- **Menu-bar / tray app.** On macOS use `ActivationPolicy::Accessory` (no Dock icon). On Windows use a tray icon only, with no taskbar button except for Settings.
- **Single instance** (`tauri-plugin-single-instance`).
- Windows (Tauri labels):

| Label | Purpose | Flags |
|---|---|---|
| `shelf` | Floating shelf | frameless, transparent, always-on-top, skip taskbar, **non-activating** (macOS: NSPanel via `tauri-nspanel` or set `NSWindowStyleMaskNonactivatingPanel`; Windows: `WS_EX_NOACTIVATE`), visible on all workspaces |
| `overlay-{n}` | Capture overlay, one per monitor | frameless, transparent, always-on-top, skip taskbar; macOS level = `NSScreenSaverWindowLevel` + `canJoinAllSpaces | fullScreenAuxiliary`; created at startup and hidden (faster to show) |
| `settings` | Settings | normal window, 720×520 |
| `onboarding` | First run | normal window, 560×600, centered |

- macOS transparent windows need `"macOSPrivateApi": true` in `tauri.conf.json`. That's fine because we're not shipping to the Mac App Store.

### 5.2 Capture pipeline

```
hotkey ─▶ frames::grab_all()  (xcap Monitor::all → capture_image, keep RgbaImage per monitor in memory)
       ─▶ encode each frame for display (fast: BMP or PNG with Compression::Fast) and serve it via the
          custom protocol  frame://localhost/{monitorId}?v={nonce}
       ─▶ position + show overlay-{n} over each monitor (logical bounds), emit "overlay:start"
user drags ─▶ overlay UI sends {monitorId, x, y, w, h} in CSS px
       ─▶ crop::to_physical(rect, scale_factor) ─▶ crop frozen RgbaImage
       ─▶ shelf::store.add(png)  (write PNG + 320px thumb into app-data, insert row)
       ─▶ clipboard::set_image (if setting on) ─▶ hide overlays ─▶ show shelf, highlight item
       ─▶ if plan == sync && autoSync: cloud::vault.upload(item) in background
```

- **Performance budget:** hotkey → overlay visible < 300 ms on a 4K display. Measure `grab_all` and encode separately. If the encode is slow, send raw RGBA through the protocol as `image/bmp`.
- **Permissions (macOS):** check with `CGPreflightScreenCaptureAccess()` and request with `CGRequestScreenCaptureAccess()` (via `objc2`/`core-graphics` FFI). Without permission, xcap returns wallpaper-only images. Detect that and route the user to onboarding step 2.
- **Multi-monitor / DPI:** overlay windows use each monitor's *logical* position and size. Crop math uses that monitor's `scale_factor`. Unit-test crop math at 1.0, 1.25, 1.5 and 2.0.
- **Overlay UX:** dim layer rgba(0,0,0,0.35); the selection area shows undimmed pixels with a 1 px white border plus a 1 px dark outer border; W×H label follows the cursor; crosshair cursor; `Esc`, `F` and `Enter` as in the PRD (F1.3).

### 5.3 Local store

App-data dir (Tauri `app_data_dir()`):

```
captures/{id}.png
thumbs/{id}.png         (max 320 px wide)
drag/                   (staging copies with friendly names; purged hourly)
shelf.db                (SQLite)
settings.json           (tauri-plugin-store)
```

```sql
CREATE TABLE items (
  id              TEXT PRIMARY KEY,         -- 22-char base62, 128-bit random
  created_at      INTEGER NOT NULL,         -- unix ms
  expires_at      INTEGER,                  -- NULL = pinned
  source          TEXT NOT NULL,            -- 'capture' | 'clipboard' | 'folder' | 'phone' | 'computer'
  origin_device   TEXT,                     -- e.g. "Mayank's iPhone" for phone items
  file_name       TEXT NOT NULL,            -- "Screenshot 2026-09-29 at 14.03.22.png"
  path            TEXT NOT NULL,
  thumb_path      TEXT NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL,
  vault_item_id   TEXT,                     -- set when synced to vault
  drop_id         TEXT, drop_key TEXT, drop_delete_token TEXT, drop_expires_at INTEGER
);
CREATE INDEX idx_items_created ON items(created_at DESC);
```

- **Expiry job:** runs at start and every 10 min. It deletes rows where `expires_at < now` along with their files, and enforces capacity (it drops the oldest *unpinned* items beyond the plan's capacity).
- **Drag staging:** on drag start, hard-link (or copy) `captures/{id}.png` to `drag/{file_name}` so the drop target sees a friendly name. Then call `startDrag({ item: [stagedPath], icon: thumbPath })`.
- **Secrets** (`keyring`, service `xyz.hopshot`): `license_device_token`, `vault_id`, `vault_key`, `device_id`, `device_token`.

### 5.4 Tauri command surface (thin — logic stays in Rust modules)

```
list_items() -> Item[]                  delete_item(id)          pin_item(id, pinned)
copy_item(id)                           prepare_drag(id) -> {path, icon}
save_item_as(id)                        reveal_item(id)
start_capture(mode: 'region'|'screen')  overlay_commit(monitorId, rect) / overlay_cancel()
send_drop(id, ttl) -> {url, expiresAt}  delete_drop(id)
get_settings() / set_settings(patch)    get_plan() -> {plan: 'expired'|'lifetime'|'sync', capturePaused, syncEndsAt?, limits}
license_buy(plan) / license_claim(token) / license_restore(email) / license_restore_verify(code) / license_remove_device(id)
vault_create() / vault_invite() -> {pairUrl, expiresAt} / vault_devices() / vault_revoke(deviceId)
permissions_status() -> {screen: 'granted'|'denied'|'unknown'} / permissions_open_settings()
```

Events emitted to the UI: `shelf:changed`, `shelf:highlight {id}`, `overlay:start {monitorId, frameUrl}`, `sync:status`, `toast {kind, text}`, `plan:changed`.

---

## 6. Encryption — the HOP1 envelope

- **Algorithm:** AES-256-GCM, 96-bit random nonce, 128-bit tag.
- **Envelope bytes:** `"HOP1"` (4 bytes ASCII) ‖ `nonce` (12) ‖ `ciphertext‖tag`.
- **AAD:** UTF-8 of `hopshot/v1/{kind}/{id}`, where `kind ∈ {drop, item, meta}`. This binds the ciphertext to its ID, so blobs can't be swapped.
- **Keys:** 32 random bytes, encoded as **base64url without padding** (43 chars) whenever they appear in URLs.
- **IDs:** 22-char base62 from 128 random bits, generated **by the client**. The server rejects duplicates with 409.
- **Metadata** (`{name, mime, w, h, createdAt, origin}`) is encrypted separately with `kind = meta` and sent base64url-encoded in the `X-Hopshot-Meta` header.
- **Test vectors:** `packages/crypto/test-vectors.json` holds fixed key/nonce/plaintext/AAD → expected envelope. **Both** the Rust and TS test suites must pass the same vectors.

| Flow | Key | URL |
|---|---|---|
| Drop / QR / share link | fresh random key per drop | `https://hopshot.xyz/d/{id}#{key}` |
| Vault (paired devices) | one vault key, created on the first desktop | never in a URL, except once during pairing |
| Pairing | invite code + vault key | `https://hopshot.xyz/pair#{inviteCode}.{vaultKey}` |

URL fragments (`#…`) are never sent to the server. The web app must **never** log `location.hash` or send it to analytics.

**Revocation (v1):** revoking a device deletes its token, so it can no longer fetch anything. Vault key rotation is P2.

---

## 7. API (Cloudflare Worker, `https://api.hopshot.xyz/v1`)

Auth header for vault calls: `Authorization: Bearer {deviceToken}`. Tokens are 32 random bytes (base64url) and are stored as SHA-256 hashes. Plan is attached via `X-Hopshot-License: {licenseDeviceToken}` (checked against the `license_devices`, `licenses` and `subscriptions` tables in D1; no external call). All request/response bodies are JSON except blobs (`application/octet-stream`). Errors use the shape `{ "error": { "code": "limit_reached", "message": "…" } }`.

### 7.1 Drops (QR send + share links)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/drops/{id}?ttl=24h` | Body = HOP1 ciphertext. Headers: `X-Hopshot-Install: {installId}`, optional license headers. Checks TTL against plan, size ≤ `maxCiphertextBytes`, daily caps per install and per IP. → `201 {id, deleteToken, expiresAt}` |
| `GET` | `/drops/{id}` | → ciphertext; `404` if unknown, `410` if expired/deleted. `Cache-Control: no-store`. Increments `view_count`. |
| `GET` | `/drops/{id}/info` | → `{expiresAt, size}` (for the viewer countdown before download) |
| `DELETE` | `/drops/{id}` | `Authorization: Bearer {deleteToken}` → `204` |

### 7.2 Vaults, pairing, devices

| Method | Path | Notes |
|---|---|---|
| `POST` | `/vaults` | Sync only. Body `{deviceName, kind:"desktop"}` → `{vaultId, deviceId, deviceToken}` |
| `POST` | `/vaults/{vaultId}/invites` | Desktop token → `{code, expiresAt}` (10 min, single use) |
| `POST` | `/pair` | Body `{code, deviceName, kind:"phone"|"desktop"}` → `{vaultId, deviceId, deviceToken}`. Enforces `maxPhones` / `maxComputers`. At most 5 failed attempts per IP per 10 min. |
| `GET` | `/vaults/{vaultId}/devices` | → device list |
| `DELETE` | `/vaults/{vaultId}/devices/{deviceId}` | Revoke (desktop token only) |
| `DELETE` | `/vaults/{vaultId}` | "Delete all my cloud data": removes vault, devices, items and blobs |

### 7.3 Vault items

| Method | Path | Notes |
|---|---|---|
| `POST` | `/vaults/{vaultId}/items/{itemId}?ttl=24h` | Body = ciphertext; header `X-Hopshot-Meta` → `201 {itemId, expiresAt}`; then broadcasts `item.created` |
| `GET` | `/vaults/{vaultId}/items?since={ms}` | → `[{id, sourceDeviceId, size, meta, createdAt, expiresAt}]` |
| `GET` | `/vaults/{vaultId}/items/{itemId}/blob` | → ciphertext |
| `DELETE` | `/vaults/{vaultId}/items/{itemId}` | Broadcasts `item.deleted` |

### 7.4 Live updates

- `POST /vaults/{vaultId}/live-ticket` → `{ticket}` (valid 60 s, single use). Browsers can't set headers on WebSockets, so tickets are used instead.
- `GET /vaults/{vaultId}/live?ticket=…` → WebSocket upgrade forwarded to the **VaultHub** Durable Object (one per vault, using the hibernation API).
- Server → client events: `{"type":"item.created","item":{…}}`, `{"type":"item.deleted","id":"…"}`, `{"type":"device.joined","device":{…}}`, `{"type":"device.revoked","deviceId":"…"}`.
- Clients fall back to polling `GET …/items?since=` every 15 s if the socket drops.

### 7.5 Licenses and billing (Stripe)

**No trial.** Pay-first (PRD F8.1): a new install is `expired` and capture is paused until a purchase completes. The desktop decides this locally from the keychain so the hotkey path never waits on a request, and an install that has *never* reached the server is locked too — treating "unknown" as permissive would make staying offline a bypass.

**Stripe setup** (test mode first, then live; the India account used for pre-orders, payouts in INR):

| Product | Price | Lookup key | Metadata |
|---|---|---|---|
| Hopshot | one-time, $19 | `bundle` | `plan=bundle`, `sync_days=365` |
| _(retired)_ Hopshot Sync | was recurring, $24/year | — | Sync is now part of the one-time purchase |

One plan (PRD §7): `Purchasable` is `"bundle"` and nothing else, so `/license/buy/lifetime` is a 400. The `lifetime` *plan name* survives as the state a licence falls back to when Sync lapses. Code refers to prices only by **lookup key**. To change a price, create a new Price in the dashboard and transfer the lookup key to it; no deploy. Turn on the **customer portal** (update card, invoices, cancel at period end; no plan switching). Turn on Stripe's built-in emails for receipts, failed payments and expiring cards, plus Smart Retries. Turn **off** Stripe's free-trial reminder emails: Hopshot sends its own, and "trial" is the wrong word for an included year.

**Checkout** is created by the Worker, so the website and the app never hold Stripe keys:

- `GET /buy/{lifetime|bundle}?ref=` → Checkout Session with `mode=payment`, `customer_creation=always`, `billing_address_collection=required`, name collection on, `client_reference_id=ref`, `metadata.plan`, `success_url=https://hopshot.xyz/thanks?s={CHECKOUT_SESSION_ID}`, `cancel_url=https://hopshot.xyz/#pricing` → `303`. Stripe India requires the customer's name and billing address on export payments.
- _(retired)_ `POST /billing/sync-checkout` — there is no Sync subscription to sell. A pre-launch Lifetime holder who wants phone sync buys the current $19 licence.
- `GET /billing/add-card?t={token}` → Checkout Session with `mode=setup` for that customer. On completion, set the card as the Sync subscription's default payment method and resume it if paused.
- `POST /billing/portal` (device token header) and `GET /billing/manage?t={token}` → customer portal session → `303`.

**Licenses without keys** (`lib/license.ts`). A license is one paid Lifetime or bundle purchase, owned by the Stripe customer (the checkout email); one per Checkout Session, idempotent on the session ID. Users never see it. Each computer holds a **license device token** (32 random bytes in the keychain, stored hashed in `license_devices`) and sends it as `X-Hopshot-License`. A computer gets its token in one of three ways:

1. **In-app purchase (no input):** `POST /buy/start {plan, installId, label}` creates a `claims` row and a Checkout Session with `client_reference_id = claimId`, and returns `{url, claimId}`. The app opens the URL and polls `GET /claims/{claimId}?installId=` every 3 s (up to 30 min, resumed at next launch). When the webhook marks the claim paid, the poll returns the device token once.
2. **Link (website buyers, founders):** `hopshot://activate?t={token}`, signed, valid 30 days, reusable until the computer limit. The thanks page (`GET /buy/session/{id}`) and the `license_ready` email carry it, as a normal https link `https://hopshot.xyz/activate#t=…` that opens the app (and offers the download if it isn't installed). The desktop registers the `hopshot` scheme with `tauri-plugin-deep-link` and calls `POST /license/claim`.
3. **Restore (new computer, reinstall):** `POST /license/restore {email, installId}` always returns `202`; if that email owns a license, it emails a 6-digit code (10 min, 5 attempts) and an activation link. `POST /license/restore/verify {email, code, installId, label}` returns the device token.

**Computer limit, tracked automatically:** `computerLimit(license)` = `sync.maxComputers` (3) for a `bundle`, `lifetime.maxComputers` (1) for a pre-launch Lifetime licence. Registered on first unlock; a slot unused for 30 days is reclaimed silently, otherwise the app asks which computer to move from (DESIGN S9).

**Webhook** `POST /webhooks/stripe` (secret `STRIPE_WEBHOOK_SECRET`; verify with `stripe.webhooks.constructEventAsync` and `Stripe.createSubtleCryptoProvider()`; record event IDs in `stripe_events` and skip duplicates):

| Event | Action |
|---|---|
| `checkout.session.completed`, `mode=payment`, paid | upsert `customers`; create the license and mark the matching claim (`client_reference_id`) paid; for `plan=bundle`, save the card for later with `setup_future_usage: off_session` and create **no subscription** — the bundle's Sync year is tracked from `licenses.created_at`, and a subscription exists only once the customer confirms the renewal (F8.8). Superseded: price `sync_yearly`, `trial_end = now + sync_days`, no payment method, `trial_settings.end_behavior.missing_payment_method = pause`; send `license_ready` |
| `checkout.session.completed`, `mode=subscription` | upsert `customers` and `subscriptions` (a Lifetime owner added Sync) |
| `checkout.session.completed`, `mode=setup` | attach the card as the subscription's default payment method; resume it if paused |
| `customer.subscription.created / updated / deleted / paused / resumed` | upsert `subscriptions` (status, `trial_end`, `current_period_end`, `cancel_at_period_end`, `has_payment_method`); on `paused`, send the "Sync has paused" email |
| `charge.refunded` (full) | license → `refunded`; cancel the included Sync subscription |
| `charge.dispute.created` | license → `revoked`; email founder@hopshot.xyz |

**Resolving the plan:** an `active` `bundle` license → `sync`; an `active` `lifetime` license → `lifetime` (nothing creates one today); anything absent, refunded or revoked → `expired`. Read from D1 only, never Stripe, so a Stripe outage cannot lock out paying users.

**Transactional email:** `lib/email.ts` sends through Resend from `Hopshot <founder@hopshot.xyz>`; `emails_sent` makes every send idempotent.

| Email | Who | When |
|---|---|---|
| `license_ready` | new license | on purchase or founder import: **Open in Hopshot** button + "restore with this email on other computers" |
| `restore_code` | restore request | immediately: 6-digit code + activation link |

Templates live in `services/api/src/emails/` (HTML + text). Only two messages exist now — the receipt and the restore code — and both are transactional, so neither carries an unsubscribe link.

**Founders and testers:** `POST /admin/licenses` (`ADMIN_TOKEN`) with `{email, name?, plan: "lifetime"|"bundle", source: "founder"|"comp", syncStartsAt?}` creates or reuses the Stripe customer, creates the license and, for `bundle`, the Sync subscription with `trial_end = syncStartsAt + 365 days`, then sends `license_ready`. On launch day, `scripts/export-founders.mjs` lists the paid pre-order sessions into `founders.csv`, and each row is imported with `syncStartsAt` = the launch date (as the pre-order terms promise).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/trial/start` | Retired. Always answers a trial that has already ended (`active: false`, `endsAt == startedAt`), so v0.1.x builds that still call it pause capture and show their plans screen. A 404 would leave their cache empty, which those builds read as their most permissive state. Delete once no v0.1.x install remains. |
| `POST` | `/buy/start` | `{plan, installId, label}` → `{url, claimId}` (in-app purchase) |
| `GET` | `/claims/{claimId}` | `?installId=` → `{status:"pending"}`, or once paid `{deviceToken, plan}` (returned once) |
| `POST` | `/license/claim` | `{token, installId, label}` → `{deviceToken, plan, syncStatus?, syncEndsAt?}` or `409 device_limit` |
| `POST` | `/license/claim/finish` | `{pendingId, removeDeviceId}` → same as claim |
| `POST` | `/license/restore` | `{email, installId}` → always `202` (3/hour per email and per IP) |
| `POST` | `/license/restore/verify` | `{email, code, installId, label}` → same as claim |
| `GET` | `/license/status` | device token → `{plan, valid, syncStatus?, syncEndsAt?, email, devices}` |
| `POST` | `/license/devices/remove` | device token, `{id}` → `204` |
| `GET` | `/buy/{lifetime|bundle}` | → `303` to Stripe Checkout |
| `GET` | `/buy/session/{id}` | thanks page → `{plan, activateUrl}` for a paid session created less than 24 h ago |
| `POST` | `/billing/sync-checkout`, `/billing/portal` | device token → `{url}` |
| `GET` | `/billing/add-card`, `/billing/manage` | `?t={token}` → `303` |
| `POST` | `/webhooks/stripe` | → `200` |
| `POST` | `/admin/licenses` | admin token; founders and testers |
| `GET` | `/reminders/stop` | `?t={token}` → stops reminder emails |

Keep all Stripe calls in `lib/stripe.ts` (the `stripe` npm SDK with its fetch HTTP client). Worker secrets (`wrangler secret put`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `REMINDER_TOKEN_SECRET`, `ADMIN_TOKEN`, with test-mode values in a separate wrangler environment. Check Stripe's current Checkout, Billing (trials, pause) and webhook docs when implementing. Test with the Stripe CLI (`stripe listen`) and a **test clock** to run through the 365-day period.

### 7.6 Misc

- `POST /report` `{dropId, reason}`: stores the report and emails the owner via the Cloudflare Email Routing/Workers email binding or a simple webhook.
- `GET /health`

### 7.7 D1 schema (`migrations/0001_init.sql`)

```sql
CREATE TABLE drops (
  id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, size INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deleted_at INTEGER,
  delete_token_hash TEXT NOT NULL, view_count INTEGER NOT NULL DEFAULT 0,
  install_id TEXT, ip_hash TEXT, plan TEXT NOT NULL
);
CREATE INDEX idx_drops_expires ON drops(expires_at);

CREATE TABLE vaults (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL   -- owner = 'install:{installId}'; its licence is the authority (older rows may read 'trial:{installId}')
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('desktop','phone')),
  token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  last_seen_at INTEGER, revoked_at INTEGER
);
CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY, vault_id TEXT NOT NULL, created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER, failed_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE items (
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  source_device_id TEXT NOT NULL, r2_key TEXT NOT NULL, size INTEGER NOT NULL,
  meta TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX idx_items_vault_created ON items(vault_id, created_at DESC);
CREATE INDEX idx_items_expires ON items(expires_at);

CREATE TABLE customers (
  stripe_customer_id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT,
  created_at INTEGER NOT NULL, reminders_off_at INTEGER
);
CREATE INDEX idx_customers_email ON customers(email);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(stripe_customer_id),
  plan TEXT NOT NULL CHECK (plan IN ('lifetime','bundle')),
  source TEXT NOT NULL CHECK (source IN ('checkout','founder','comp')),
  checkout_session_id TEXT UNIQUE, payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','refunded','revoked')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_licenses_customer ON licenses(customer_id);
CREATE INDEX idx_licenses_pi ON licenses(payment_intent_id);
CREATE TABLE license_devices (
  id TEXT PRIMARY KEY, license_id TEXT NOT NULL REFERENCES licenses(id), install_id TEXT NOT NULL,
  label TEXT, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, removed_at INTEGER
);
CREATE INDEX idx_license_devices_license ON license_devices(license_id);
CREATE TABLE claims (                -- in-app purchases and pending 4th-computer choices
  id_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('purchase','device_limit')),
  install_id TEXT NOT NULL, label TEXT, plan TEXT, checkout_session_id TEXT, license_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', delivered_at INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE restore_codes (
  email TEXT NOT NULL, install_id TEXT NOT NULL, code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (email, install_id)
);
CREATE TABLE subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
  status TEXT NOT NULL,                 -- trialing | active | past_due | paused | canceled | ...
  trial_end INTEGER, current_period_end INTEGER, past_due_since INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0, has_payment_method INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
CREATE TABLE trials (             -- retired with the trial (PRD F8.1); kept so existing rows
  install_id TEXT PRIMARY KEY,    -- are not lost. Nothing reads or writes it. Drop in a
  started_at INTEGER NOT NULL,    -- migration once no v0.1.x install remains.
  ip_hash TEXT
);
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE emails_sent (           -- period_key is '' for one-off mail; kept for any future recurring send
  subject_id TEXT NOT NULL, kind TEXT NOT NULL, period_key TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL, PRIMARY KEY (subject_id, kind, period_key)
);
CREATE TABLE usage (
  day TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, subject, kind)
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, drop_id TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL
);
```

### 7.8 Retention

- **Cron every 15 min:** select expired `drops`/`items`, delete their R2 objects, then the rows; delete used or expired `invites`; drop `usage` rows older than 7 days.
- **R2 lifecycle rule** as a safety net: delete objects under the `d/` and `v/` prefixes 8 days after upload (the maximum TTL is 7 days).
- R2 keys: `d/{dropId}` and `v/{vaultId}/{itemId}`.
- **Cron daily (09:00 UTC):** declared but idle since Sync stopped renewing (§7.5).

### 7.9 Abuse and rate limits

- Lifetime drops: 10 per license per day, and 100 per IP-hash per day (so offices behind one IP aren't blocked).
- Upload size cap enforced by reading `Content-Length` before streaming to R2 (reject > 12 MB with `413`).
- IP hash = SHA-256(IP + daily-rotated salt). Raw IPs are never stored.
- `/pair` brute force: 5 failures per IP per 10 min, then `429`.

---

## 8. Web app (Astro on Cloudflare Pages)

| Route | Type | Purpose |
|---|---|---|
| `/` `/pricing` `/download` `/faq` `/changelog` `/privacy` `/terms` | Static | Marketing + legal (SEO) |
| `/d/[id]` | Static shell + React island | Drop viewer: read `#key` → `GET /drops/{id}/info` (countdown) → fetch blob → decrypt → show image. Buttons: Save/Share (`navigator.share({files})`), Download, Copy (where `ClipboardItem` is supported), Report. Footer growth link. |
| `/pair` | React island | Parse `#code.key` → `POST /pair` → store `{vaultId, deviceId, deviceToken, vaultKey}` in IndexedDB → redirect to `/app`. iOS: if not running standalone, show "Add to Home Screen" instructions and the re-scan note. |
| `/app` | PWA (React) | Feed grid, item view, upload (`<input type=file accept="image/*">`), live socket, pull-to-refresh, in-app QR scanner for re-pairing, device name setting, "Unpair". |
| `manifest.webmanifest` | — | `display: standalone`, icons, `share_target` (POST multipart → `/app/share-target`, handled in the service worker; Android only) |

- **Service worker:** cache the app shell; never cache API responses or decrypted images.
- **Storage:** IndexedDB via `idb-keyval`. Keep the vault key as a **non-extractable** WebCrypto `CryptoKey` after import where possible.
- **CSP:** `default-src 'self'; connect-src 'self' https://api.hopshot.xyz wss://api.hopshot.xyz; img-src 'self' blob: data:`.

---

## 9. Packaging, signing and distribution

| Target | Artifact | Signing | Updates |
|---|---|---|---|
| macOS (direct) | Universal `.dmg` (aarch64 + x86_64) | Developer ID Application + notarization (Apple Developer Program, $99/yr) via `tauri-action` | `tauri-plugin-updater` (minisign-signed `latest.json` on GitHub Releases) |
| Windows — **Microsoft Store** (primary) | MSIX built with Microsoft's `winapp` CLI from the Tauri release exe | **The Store signs it** (free individual registration) | Store |
| Windows (direct, secondary) | NSIS `.exe` | Unsigned at launch (SmartScreen warning; show "More info → Run anyway" on the download page). Add an OV certificate ($150–300/yr) later. | `tauri-plugin-updater` |

- **Azure Artifact Signing** isn't an option: individual developers must be in the US/Canada, and the organisation country list doesn't include India.
- Store build: compile with the Cargo feature `store`, which disables the updater, and use `tauri.microsoftstore.conf.json`. Confirm the WebView2 runtime requirement (preinstalled on Windows 11; nearly universal on Windows 10).
**Built (Windows).** `tauri-plugin-updater` is registered, `bundle.createUpdaterArtifacts`
is on, and `.github/workflows/release.yml` publishes `latest.json` beside the installer.
The app checks 30 s after launch and then daily, announces what it finds on `update:available`,
and **never installs without a click** — it is a tray app, and restarting someone mid-capture
reads as a crash. The endpoint is `releases/latest/download/latest.json`, so a draft release
can never reach anyone: publishing *is* releasing. macOS is unimplemented and must not be
claimed until it compiles.

The Store build carries the `store` Cargo feature, which stops the plugin being registered and
turns `update::{check, install}` into stubs; `tauri.microsoftstore.conf.json` also sets
`createUpdaterArtifacts: false`.

- **CI (`desktop-release.yml`):** on tag `v*` → matrix `macos-latest` (universal) + `windows-latest` → builds, signs (mac), notarizes, uploads to a draft GitHub Release, and generates `latest.json`. MSIX packaging is a separate job, uploaded manually to Partner Center.
- **Secrets:** `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `CLOUDFLARE_API_TOKEN`.

---

## 10. Testing strategy

| Layer | Tooling | Must cover |
|---|---|---|
| Rust | `cargo test` | crop math across scale factors, HOP1 vs shared vectors, expiry/capacity rules, file naming, limits loading |
| Crypto TS | Vitest | same vectors; tampered AAD/nonce fails |
| Worker | Vitest + `@cloudflare/vitest-pool-workers` | every route: happy path, limits, auth, expiry → 410, pairing brute-force lockout, cron cleanup |
| Web | Vitest + Playwright | viewer decrypts a known drop; key never in network requests; pair → feed flow (mock API) |
| Manual QA | `docs/LAUNCH.md` checklist | drag-out matrix (PRD §9), multi-monitor/DPI, macOS permission flow, full-screen apps, sleep/wake, offline |

---

## 11. Running costs (estimate)

| Item | Cost |
|---|---|
| Apple Developer Program | $99 / year (required) |
| Microsoft Store individual account | Free |
| Domain | ~$10–20 / year |
| Cloudflare (Workers, R2, D1, DO, Pages) | $0–5 / month at launch scale (Workers Paid $5/mo recommended for headroom) |
| Stripe fees (India account, international cards) | ~4.3% + 2% currency conversion per payment; +0.7% on subscription payments |
| Resend (email) | Free tier at launch volume |
| Windows OV certificate (optional, later) | $150–300 / year |

Storage cost per user is negligible: everything is deleted within ≤ 7 days, images are capped at 10 MB, and R2 has no egress fees.

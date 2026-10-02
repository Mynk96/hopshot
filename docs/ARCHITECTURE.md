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
│   └─ Cron (15 min) : delete expired rows + objects                       │
│  hopshot.xyz      — Pages (Astro): landing · /d/:id viewer · /app PWA    │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ HTTPS (decrypts in the browser)
┌───────────────┴──────────── Phone ──────────────────────────────────────┐
│  Browser / installed PWA: viewer, pairing, feed, upload                  │
└──────────────────────────────────────────────────────────────────────────┘
Payments: Polar (checkout + license keys). The Worker proxies license calls.
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
| Other Tauri plugins | `autostart`, `updater`, `single-instance`, `store`, `notification`, `opener`, `positioner`, `log` | Official |
| Local DB | `rusqlite` (bundled) | Tiny, reliable |
| Secrets | `keyring` crate | macOS Keychain / Windows Credential Manager |
| Crypto | `aes-gcm`, `rand`, `sha2`, `base64` | AES-256-GCM |
| HTTP / WS | `reqwest` (rustls), `tokio-tungstenite` | — |
| Window effects | `window-vibrancy` (+ `objc2`/`objc2-app-kit` on macOS, `windows` crate on Windows for window flags) | Native glass look; overlay above full-screen apps |
| API | Cloudflare Workers + **Hono** + R2 + D1 + Durable Objects + Cron Triggers | Near-zero cost at small scale, no egress fees, global |
| Web | **Astro** + React islands + `@vite-pwa/astro`, deployed on Cloudflare Pages | Fast landing page (SEO) plus the app pages in one project |
| Phone QR scanner | `qr-scanner` (npm) | For the iOS home-screen re-pair flow |
| QR generation | `qrcode` (npm) in desktop UI | — |
| Payments / licensing | **Polar** (merchant of record, license keys, India payouts) | Fallback: Lemon Squeezy |
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
│     ├─ src/ index.ts routes/ { drops.ts vaults.ts pair.ts items.ts live.ts license.ts report.ts }
│     │       do/VaultHub.ts  lib/ { auth.ts ratelimit.ts polar.ts ids.ts }
│     ├─ migrations/ 0001_init.sql
│     └─ wrangler.toml
└─ .github/workflows/ desktop-release.yml  api-deploy.yml  web-deploy.yml  ci.yml
```

---

## 4. Plans and limits — `config/limits.json`

Every limit lives here. Rust reads it with `include_str!` + serde, TS imports it, and the Worker bundles it. **Never hard-code a limit anywhere else.**

```json
{
  "trial": {
    "days": 7,
    "includes": "sync"
  },
  "lifetime": {
    "shelfCapacity": 100,
    "itemTtlOptions": ["1h", "24h", "7d"],
    "dropTtlOptions": ["24h"],
    "dropsPerDay": 10,
    "maxImageBytes": 10485760,
    "maxComputers": 3,
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
    "vaultLiveBytes": 1073741824,
    "paymentGraceDays": 7
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

Plan resolution: `expired` (trial over, nothing bought) → `trial` (within 7 days of first launch; gets Sync limits) → `lifetime` (valid Lifetime key) → `sync` (valid Lifetime key + active Sync subscription; gets Lifetime limits overridden by the `sync` block).

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
       ─▶ if plan ∈ {trial, sync} && autoSync: cloud::vault.upload(item) in background
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
- **Secrets** (`keyring`, service `xyz.hopshot`): `license_key`, `license_activation_id`, `vault_id`, `vault_key`, `device_id`, `device_token`.

### 5.4 Tauri command surface (thin — logic stays in Rust modules)

```
list_items() -> Item[]                  delete_item(id)          pin_item(id, pinned)
copy_item(id)                           prepare_drag(id) -> {path, icon}
save_item_as(id)                        reveal_item(id)
start_capture(mode: 'region'|'screen')  overlay_commit(monitorId, rect) / overlay_cancel()
send_drop(id, ttl) -> {url, expiresAt}  delete_drop(id)
get_settings() / set_settings(patch)    get_plan() -> {plan: 'trial'|'expired'|'lifetime'|'sync', trialEndsAt?, syncRenewsAt?, limits}
license_activate(key) / license_deactivate()
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

Auth header for vault calls: `Authorization: Bearer {deviceToken}`. Tokens are 32 random bytes (base64url) and are stored as SHA-256 hashes. Plan is attached via `X-Hopshot-License: {licenseKey}` plus `X-Hopshot-Activation: {activationId}` (validated against Polar and cached for 24 h in D1). All request/response bodies are JSON except blobs (`application/octet-stream`). Errors use the shape `{ "error": { "code": "limit_reached", "message": "…" } }`.

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
| `POST` | `/vaults` | Trial or Sync only. Body `{deviceName, kind:"desktop"}` → `{vaultId, deviceId, deviceToken}` |
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

### 7.5 Trial and license (proxy to Polar)

**Trial:** the desktop records its first-launch time locally (keychain) and calls `POST /trial/start {installId}` once → `{trialEndsAt}`. The server keeps `trials(install_id, started_at)` so cloud features (drops, vault) stop at the same moment. Reinstall abuse is possible and acceptable at this price.

**Polar setup:** product *Hopshot Lifetime* (one-time, license-key benefit, 3 activations) and product *Hopshot Sync* (subscription, yearly + monthly prices). The Worker resolves the plan from the license key, then checks whether the same Polar customer has an active Sync subscription (cache 24 h; honour `paymentGraceDays`).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/license/activate` | `{key, label}` → calls Polar's license-key activate API → `{plan:"lifetime"|"sync", activationId, syncRenewsAt?}`. Enforces 3 activations (configure the limit on the Polar product). |
| `POST` | `/license/validate` | `{key, activationId}` → `{plan, valid, syncRenewsAt?}` |
| `POST` | `/trial/start` | `{installId}` → `{trialEndsAt}` (idempotent) |
| `POST` | `/license/deactivate` | `{key, activationId}` → `204` |

Check Polar's current license-key API docs when implementing. Keep all Polar-specific code in `lib/polar.ts` so switching to Lemon Squeezy only touches one file.

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
  id TEXT PRIMARY KEY, license_key_hash TEXT NOT NULL, created_at INTEGER NOT NULL
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

CREATE TABLE licenses (
  key_hash TEXT PRIMARY KEY, plan TEXT NOT NULL CHECK (plan IN ('lifetime','sync')),
  valid INTEGER NOT NULL, sync_renews_at INTEGER, checked_at INTEGER NOT NULL
);
CREATE TABLE trials (
  install_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ip_hash TEXT
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

### 7.9 Abuse and rate limits

- Lifetime drops: 10 per license per day (trial: per install), and 100 per IP-hash per day (so offices behind one IP aren't blocked).
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
| Polar fees | ~5% + $0.50 per sale |
| Windows OV certificate (optional, later) | $150–300 / year |

Storage cost per user is negligible: everything is deleted within ≤ 7 days, images are capped at 10 MB, and R2 has no egress fees.

# Hopshot — Build Plan with Claude Code

A 4-week plan (about 28 working days, one person) broken into phases. Each phase has **copy-paste prompts** for Claude Code, a definition of done, and a manual test. The riskiest parts (overlay, non-activating shelf, drag-out on both OSes) come **first**, so if something is impossible you find out on day 2, not day 20.

---

## How to work with Claude Code on this project

1. Put this whole pack in an empty folder, `git init`, and commit it. `CLAUDE.md` in the repo root is read automatically at the start of every session.
2. **One phase = one or more fresh sessions.** Use `/clear` between phases so old context doesn't leak in.
3. For every prompt below, start in **plan mode** (Shift+Tab to toggle). Read the plan, correct it, then let it implement.
4. Commit after every green step (`git commit` yourself, or ask Claude Code to commit). Small commits make it easy to roll back a bad direction.
5. When something platform-specific breaks, paste the **exact** error and say which OS. Don't paraphrase.
6. You need **both machines**: your Windows laptop for daily work, and a Mac (borrowed, rented or cloud) at least on Days 2–3, 6, 16 and 20+. CI builds the Mac app, but only a real Mac can test it.

---

## Day 0 — Accounts and setup (do this before coding; some take days to approve)

- [ ] **Apple Developer Program** ($99/yr). Enrol as an individual or as BAS Technologies (needs a D-U-N-S number, which is slower). Approval can take 1–2 days.
- [ ] **Microsoft Partner Center** individual developer account (free). Reserve the app name "Hopshot".
- [ ] **Cloudflare** account; buy or move the domain; create an R2 bucket `hopshot-blobs`, a D1 database `hopshot`, and a Pages project.
- [ ] **Stripe** (the account used for pre-orders). In **test mode** first: create the three products and prices from ARCHITECTURE §7.5 (lookup keys `lifetime`, `bundle`, `sync_yearly`; metadata `plan`, `sync_days`); turn on the customer portal (update card, invoices, cancel at period end); turn on receipt, failed-payment and expiring-card emails and Smart Retries; turn off free-trial reminder emails. Repeat in live mode before launch. Add the webhook endpoint `https://api.hopshot.xyz/v1/webhooks/stripe` once the API is deployed. Keep the pre-order Payment Links running until launch.
- [ ] **Resend** account for transactional email: verify `hopshot.xyz` (add its DNS records in Cloudflare) so purchase, restore and renewal emails send from founder@hopshot.xyz.
- [ ] **GitHub** private repo; add the secrets listed in ARCHITECTURE §9 as you get them.
- [ ] Name: **Hopshot**, domain **hopshot.xyz** (owned). Do a quick USPTO/WIPO trademark search. Keep the name in one place (`packages/shared/src/brand.ts` + Tauri `productName`).
- [ ] Toolchain on both machines: Rust stable, Node 20+, pnpm, Tauri v2 prerequisites (Xcode CLT on Mac; MSVC Build Tools + WebView2 on Windows), `wrangler`.

---

## Phase 0 — Scaffold (Day 1, ~2 hours)

**Prompt 0.1**
```
Read CLAUDE.md, PRD.md and docs/ARCHITECTURE.md (§2–§4).
Scaffold the monorepo exactly as in ARCHITECTURE §3 using pnpm workspaces:
- apps/desktop: Tauri v2 + React 18 + TypeScript + Vite + Tailwind. Map the DESIGN.md §2 tokens to CSS variables and a Tailwind theme (light + dark).
- apps/web: Astro + React integration + Tailwind, with the same tokens.
- services/api: Cloudflare Worker with Hono, wrangler.toml with R2 (BUCKET), D1 (DB), Durable Object (VAULT_HUB) bindings and a 15-min cron; empty route files.
- packages/crypto and packages/shared as TS libraries.
- config/limits.json with the content from ARCHITECTURE §4, plus a typed loader in packages/shared and a Rust loader (limits.rs using include_str! + serde).
- Root scripts so every command in CLAUDE.md "Commands" works.
- .github/workflows/ci.yml: TS lint/typecheck/tests, cargo test + clippy on ubuntu, and cargo check for macOS and Windows targets.
Don't implement features yet. Show me the tree and the result of running each command.
```

**Done when:** `pnpm i` works, `pnpm -F desktop tauri dev` opens a blank window, CI is green.

---

## Phase 1 — The risky spikes: overlay, shelf window, drag-out (Days 1–3)

**Prompt 1.1: tray app + hotkeys**
```
Implement PRD F1.1 and the tray menu from DESIGN S1:
- Tray/menu-bar app, no Dock icon on macOS (ActivationPolicy::Accessory), single instance.
- Global shortcuts from settings (defaults Cmd/Ctrl+Shift+2 capture, Cmd/Ctrl+Shift+1 show shelf) via tauri-plugin-global-shortcut, re-registered when settings change, with conflict errors surfaced.
- Tray menu items wired to stub commands.
Put platform code in platform/macos.rs and platform/windows.rs.
```

**Prompt 1.2: capture + overlay (the hardest part)**
```
Implement the capture pipeline from ARCHITECTURE §5.2 and PRD F1.2–F1.5 (region + full screen):
- frames::grab_all() with xcap for all monitors; log timings.
- Pre-created, hidden overlay windows (one per monitor) positioned on each monitor's logical bounds. Serve the frozen frame through a custom protocol frame://localhost/{monitorId}.
- macOS: overlay at NSScreenSaverWindowLevel with canJoinAllSpaces|fullScreenAuxiliary so it covers full-screen apps and the menu bar. Windows: WS_EX_TOOLWINDOW, always-on-top, no taskbar entry.
- Overlay UI per DESIGN S2 (dim, undimmed selection, white inner/black outer border, mono W×H label, hint pill, Esc/F/Enter/click behaviours).
- crop::to_physical with unit tests for scale factors 1.0, 1.25, 1.5 and 2.0 and a monitor with a negative origin.
- Save the PNG into app-data/captures and log the path (the shelf comes next phase).
- macOS permission check: permissions_status() using CGPreflightScreenCaptureAccess; if denied, show a toast and don't open the overlay.
Target: hotkey → overlay visible < 300 ms on a 4K display. Report the measured timings.
```

**Prompt 1.3: shelf window + drag-out spike**
```
Create the `shelf` window as specified in ARCHITECTURE §5.1: frameless, transparent, always-on-top, visible on all workspaces, NON-ACTIVATING (macOS NSPanel via tauri-nspanel or equivalent; Windows WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW), with window-vibrancy (macOS HudWindow, Windows 11 acrylic, solid fallback on Windows 10).
Show a hard-coded list of the PNGs in app-data/captures as cards.
Add @crabnebula/tauri-plugin-drag: on drag start, copy/hard-link the file into app-data/drag/ with a friendly name "Screenshot YYYY-MM-DD at HH.MM.SS.png" and call startDrag with the file and its thumbnail.
Also add click-to-copy using arboard.
I will test dragging into Gmail, Slack web, WhatsApp Web and ChatGPT on both OSes.
```

**Done when (release gate for the whole project):** on **both** OSes you can press the hotkey over a full-screen app, select, and drag the result into Gmail and ChatGPT, and the shelf never steals focus from the browser. **If any of these fails after a real effort, stop and reassess before building the rest.**

---

## Phase 2 — Shelf for real (Days 4–6)

**Prompt 2.1: local store, expiry, shelf UI**
```
Implement PRD F2 (P0 items) and DESIGN S3 fully:
- shelf/store.rs with the SQLite schema from ARCHITECTURE §5.3, thumbnails (320px), file naming, and capacity rules from limits.json (plan = trial for now).
- shelf/expiry.rs: run at startup and every 10 min; unit tests for expiry + capacity (pinned items excluded).
- Commands from ARCHITECTURE §5.4 (list/delete/copy/prepare_drag/save_as/reveal) and events (shelf:changed, shelf:highlight, toast).
- React shelf matching design/mockups.html: header, cards with time chip (warning colour under 1h), hover action bar, More menu, toast, empty state, footer, keyboard navigation (DESIGN §7), show/hide rules and auto-hide timer (F2.2), left/right side setting.
- After a capture: add to shelf, copy to clipboard (setting), show shelf with the new item highlighted.
```

**Prompt 2.2: settings (local parts)**
```
Implement the Settings window (DESIGN S7) for General and Shelf sections using tauri-plugin-store, including hotkey recording with conflict detection, launch at login (tauri-plugin-autostart), theme, shelf side, auto-hide, remove-after-drag. Sync-only controls show a lock for Lifetime users and open a Plans sheet stub. Devices/License/Privacy/About can be placeholders for now.
```

**Done when:** you can use Hopshot for a full working day on Windows without touching the Desktop/Downloads folder, and items disappear after 24 h (test by temporarily setting the TTL to 2 min).

---

## Phase 3 — Encrypted drops + phone viewer (Days 7–9)

**Prompt 3.1: crypto package + vectors**
```
Implement the HOP1 envelope from ARCHITECTURE §6 in packages/crypto (WebCrypto) and in src-tauri/src/crypto.rs (aes-gcm). Generate packages/crypto/test-vectors.json (fixed key/nonce/AAD/plaintext → envelope, plus tamper cases) and make BOTH test suites load and pass the same file. Add base62 ID and base64url key helpers in both languages.
```

**Prompt 3.2: API — drops**
```
Implement in services/api: migrations/0001_init.sql (ARCHITECTURE §7.7), the drops routes (§7.1), rate limits (§7.9), the cron cleanup (§7.8), /health and /report.
Use the limits from config/limits.json. Plan detection: treat every request as Lifetime for now, but keep a resolvePlan() function to fill in during Phase 4.
Write vitest tests (workers pool) for: upload ok, oversize 413, daily cap 429, bad TTL for plan 403, get → ciphertext, expired → 410, delete with token, cron removes rows + R2 objects.
```

**Prompt 3.3: desktop send-to-phone + web viewer**
```
Desktop: implement send_drop / delete_drop (PRD F3, F5): encrypt → POST → store the drop fields on the item → QR popover exactly like DESIGN S4 (loading, QR on a white tile with the logo, link + Copy, expiry line, Delete now, Done). "Copy link" on a card uses the same flow.
Web: implement /d/[id] (ARCHITECTURE §8, DESIGN S6): read the key from location.hash, fetch info + blob, decrypt, show the image, Save/Share via navigator.share({files}) with Download fallback, live countdown, expired/deleted/bad-link states, footer growth link, Report.
Add a Playwright test proving the key never appears in any network request.
Deploy the API to a staging Worker and the web to Pages preview so I can scan from my real phone.
```

**Done when:** you capture on Windows, scan the QR with an iPhone and an Android phone, save the image to Photos, and "Delete now" makes the link show "expired".

---

## Phase 4 — Trial, licensing, Sync: pairing, phone app, live sync (Days 10–13)

**Prompt 4.1: licensing**
```
Implement PRD F8 and ARCHITECTURE §7.5 with Stripe (read Stripe's current Checkout, Billing trial/pause and webhook docs first). Trial: local first-launch record + POST /trial/start. Worker: migrations for customers, licenses, license_devices, claims, restore_codes, subscriptions, stripe_events and emails_sent; lib/stripe.ts (stripe npm SDK, fetch HTTP client), lib/license.ts (purchases, device tokens, the automatic 3-computer limit; no user-facing keys), lib/email.ts (Resend) and the email templates; routes /buy, /buy/start, /buy/session, /claims, /billing/*, /license/* (claim, restore, status, devices), /webhooks/stripe (signature-verified, idempotent), /admin/licenses and /reminders/stop; the bundle flow that creates a 365-day, no-card Sync subscription that pauses at the end; the daily renewal-email cron; resolvePlan() returning expired | trial | lifetime | sync from D1 only. Tests: webhook handlers with recorded Stripe fixtures, duplicate events, refunds and disputes revoking licenses, the automatic 3-computer limit (reuse, 30-day replacement, 409 choice), each email stage, and a Stripe test-clock run through the 365 days (card added → charged on the end date; no card → paused). Desktop: license.rs (device token in the keychain, in-app purchase polling, hopshot://activate links via tauri-plugin-deep-link, email restore, the 4th-computer prompt), re-validate every 7 days, 30-day offline grace, plan:changed event; the trial-ended state (PRD F8.1a), Sync-lapsed behaviour (F8.7), the Sync-year-ending footer reminder (F8.8), Settings → License (DESIGN S7) with the computers list and "Manage Sync", and the Plans sheet (DESIGN S9) opening /buy/start or /billing/sync-checkout. Web: hopshot.xyz/thanks (shows **Open in Hopshot**) and hopshot.xyz/activate (opens hopshot://activate, and offers the download if nothing happens within 2 s). Plan limits from limits.json apply immediately without restart.
```

**Prompt 4.2: vault + pairing + devices (API + desktop)**
```
Implement ARCHITECTURE §7.2–§7.4: vaults, invites, /pair with brute-force lockout, devices list/revoke, vault items, live tickets and the VaultHub Durable Object (hibernation API) broadcasting item.created/item.deleted/device.*.
Desktop: cloud/vault.rs + cloud/live.rs: create the vault on first pairing (trial or Sync), show the pairing QR (https://hopshot.xyz/pair#{code}.{vaultKey}), auto-sync new captures when the setting is on, receive phone items into the shelf with a source badge and pop the shelf out (PRD F4.5), reconnect with backoff and fall back to 15s polling. Settings → Devices per DESIGN S7.
Tests for every route including device limits and revoked tokens.
```

**Prompt 4.3: phone PWA**
```
Implement /pair and /app in apps/web per ARCHITECTURE §8 and DESIGN S5:
- /pair: parse the fragment, POST /pair, store credentials in IndexedDB (vault key as a non-extractable CryptoKey), success screen with Add to Home Screen instructions. Detect iOS non-standalone and explain the re-scan step (PRD F4.8).
- /app: feed grid, item view (Share/Save/Copy/Delete), upload button (photo picker) that encrypts and uploads to the vault, live socket with polling fallback, in-app QR scanner (qr-scanner) for iOS re-pairing, Unpair.
- PWA manifest + service worker via @vite-pwa/astro; share_target for Android; never cache API or decrypted images.
```

**Done when:** pair an iPhone and an Android phone; a capture on the laptop appears on both phones in under 3 s; a photo uploaded from the phone appears on the shelf and drags into Gmail; revoking a phone stops it instantly.

---

## Phase 5 — Onboarding, polish, hardening (Days 14–16)

**Prompt 5.1**
```
Implement onboarding (PRD F7, DESIGN S8) with the live macOS permission check, the "Try it" step that completes on the first capture, and the stats opt-in. Finish Settings (Privacy incl. "Delete all my cloud data", About incl. version).
Then do a hardening pass: every error state and microcopy line in DESIGN §5, offline handling, upload retries with backoff, sleep/wake (re-register hotkeys, reconnect socket), multiple monitors being plugged/unplugged (rebuild overlay windows), reduced motion, keyboard access, focus rings. List anything you couldn't verify on this OS.
```

**Prompt 5.2: performance check**
```
Measure and report: idle RAM, idle CPU, cold start, hotkey→overlay latency on 1080p and 4K, installer size. Compare them with PRD G4 targets and fix the biggest offender.
```

---

## Phase 6 — Packaging, signing, updates, website (Days 17–19)

**Prompt 6.1: release pipeline**
```
Create .github/workflows/desktop-release.yml per ARCHITECTURE §9: on tag v*, build macOS universal (sign + notarize with the Apple secrets) and Windows NSIS with tauri-action, generate updater artifacts + latest.json on a draft GitHub Release. Configure tauri-plugin-updater (check at launch + every 24h, background download, ask to restart). Add the `store` Cargo feature that disables the updater, tauri.microsoftstore.conf.json, and a separate job/script that packages an MSIX with Microsoft's winapp CLI for Partner Center upload. Document the manual Store upload steps in docs/RELEASING.md.
```

**Prompt 6.2: website**
```
Build the marketing pages in apps/web: / (hero with the 20-second demo video placeholder, 3 feature blocks, Lifetime vs Lifetime + Sync table from PRD §7, FAQ, footer), /pricing, /download (auto-detect OS; Microsoft Store badge first for Windows; a direct .exe with a short "Windows protected your PC → More info → Run anyway" note), /privacy, /terms (acceptable use + takedown), /changelog. Use the DESIGN tokens, make it fast (Lighthouse ≥ 95), with Open Graph images and basic SEO metadata. Copy should be plain and short.
```

**Done when:** a tagged release produces a notarized DMG that opens without warnings on a clean Mac, an NSIS installer, and an MSIX that installs locally; the website is live on the real domain.

---

## Phase 7 — Private beta (Days 20–24)

- Recruit 20–30 testers (friends, the Indie Hackers community, colleagues; aim for half on Windows). Give them Lifetime + Sync with `POST /admin/licenses` (plan `bundle`, source `comp`).
- Ask for 3 things: (1) any place drag-out failed (app + OS + browser), (2) anything confusing in the first 5 minutes, (3) would they pay $19 once, and would they add Sync for $24/year — why or why not.
- Run the **PRD §9 drag-out matrix** and the QA checklist in `docs/LAUNCH.md` on both OSes.

**Prompt 7.1 (use as often as needed)**
```
Here is beta feedback / a bug report: <paste>. Reproduce it from the description, find the root cause, fix it with a test where possible, and tell me how to verify on <OS>.
```

---

## Phase 8 — Launch (Days 25–28)

Follow `docs/LAUNCH.md`.

---

## After launch — maintenance budget

- About 2 hours a week: triage email, fix crashes, bump dependencies monthly.
- Before each new macOS/Windows major release: test the capture, overlay and permission flows on the beta.
- Only build P1 items (window capture, catch other screenshots, pin, second computer) if users ask for them repeatedly.

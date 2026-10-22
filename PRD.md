# Hopshot — Product Requirements Document

| | |
|---|---|
| **Product** | Hopshot ([hopshot.xyz](https://hopshot.xyz)) |
| **Owner** | Mayank (PM + engineering) |
| **Status** | v1.0 draft — ready for build |
| **Date** | 29 Sep 2026 |
| **Platforms** | macOS 13+ (Apple Silicon + Intel), Windows 10 (22H2) / 11, phone via web app (iOS Safari, Android Chrome) |
| **Target launch** | 4 weeks from build start |
| **Related docs** | `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, `design/mockups.html`, `BUILD_PLAN.md`, `docs/LAUNCH.md` |

---

## 1. Summary

Hopshot is a tiny desktop app for Mac and Windows. Press a hotkey, grab part of the screen, and the screenshot lands on a floating **shelf** instead of your Desktop or Downloads folder. From the shelf you can:

- **drag it straight into any website or app** (Gmail, Slack, Jira, ChatGPT, WhatsApp Web…),
- **copy it**, or
- **get it on your phone** in one step (scan a QR code, or it appears automatically on a paired phone).

Everything expires on its own (24 hours by default). Nothing piles up on your disk, and nothing stays on our servers. Cloud copies are end-to-end encrypted, so the server can't read them.

**One-line pitch:** *"Screenshots that don't clutter your computer — drag them anywhere, open them on your phone, gone tomorrow."*

---

## 2. Problem

People take screenshots mainly to **move them somewhere else right away** — into a chat, a ticket, an email, an AI prompt — or to look at them on another device. Today's flow is clumsy:

1. **Disk clutter.** Screenshots pile up on the Desktop and in Downloads. Most are used once and never deleted.
2. **The upload dance.** Save → switch to the browser → click "Attach" → find the file in a file picker → upload. Pasting works in some apps but not others, and pasting loses the file name.
3. **Computer ↔ phone friction.** To get a screenshot onto a phone (or a phone screenshot onto a laptop), people email or WhatsApp it to themselves.
4. **Existing tools are either too big or single-platform.** CleanShot X, Dropover, Yoink and ScreenFloat are Mac-only. ShareX (Windows) is powerful but cluttered. Gyazo uploads everything permanently to its cloud, and its free plan only lets you view your last 10 captures.

**Gap Hopshot fills:** one small, clean app that does *capture → shelf → drag anywhere → phone* on **both Mac and Windows**, with temporary, encrypted cloud storage.

---

## 3. Goals and non-goals

### 3.1 Product goals (v1)

| # | Goal | Measured by |
|---|---|---|
| G1 | Capture-to-use in under 3 seconds with no file saved in user folders | Time from hotkey to successful drag/copy (internal test) |
| G2 | Drag-out works in the top web apps on both OSes | Compatibility matrix (§9) passes 100% of P0 targets |
| G3 | Get a screenshot onto a phone in 2 actions or fewer | Lifetime: click phone icon → scan. Sync: automatic |
| G4 | Feels native, light and fast | Idle RAM < 80 MB, installer < 15 MB, cold start < 1.5 s |
| G5 | Private by design | Server stores only ciphertext; everything expires |

### 3.2 Business goals

- Launch on Product Hunt, Reddit, Hacker News and indie directories within 4 weeks of build start.
- Earn a small, steady side income from one-time **Lifetime** sales plus recurring **Sync** subscriptions. **This is not a quick-cash or fully passive product**: expect ongoing maintenance for OS updates, certificates and support.
- 30-day targets (goals, not predictions): 1,500 downloads, 40% activation, 10% trial → paid, 25% of buyers adding Sync.

### 3.3 Non-goals (v1) — do not build

- Annotation or markup editor (arrows, blur, text)
- Screen recording, GIFs, scrolling capture
- OCR / text extraction
- Permanent hosting, galleries or history beyond 7 days
- Teams, shared workspaces, SSO
- Native iOS/Android apps (the phone side is a web app)
- Linux
- Mac App Store build
- AI features of any kind

These may come later, but only if v1 shows real demand.

---

## 4. Target users

| Persona | Description | Main job |
|---|---|---|
| **P1 — The Web Worker** (primary) | Knowledge worker, support agent, PM, marketer, dev. Lives in browser tabs. Takes 10–40 screenshots a day. | "Get this bit of screen into that web app **now**." |
| **P2 — The Two-Device Person** | Uses a laptop plus a phone and moves images between them several times a week. | "Get this screenshot onto my phone" / "get my phone screenshot onto my laptop." |
| **P3 — The Tidy Windows User** | Windows 10/11 user who envies Mac shelf apps (Dropover/Yoink) and finds ShareX overwhelming. | "A clean, simple capture tool that doesn't fill my Pictures folder." |

**Beachhead:** Windows users (P3 plus P1 on Windows). The Mac-only competitors don't serve them, and Windows is the larger market. Mac support matters for credibility and for people who use both.

---

## 5. Key user stories

| ID | As a… | I want to… | So that… | Priority |
|---|---|---|---|---|
| US-1 | web worker | press a hotkey, drag a region, and have it ready to use | I don't break my flow | P0 |
| US-2 | web worker | drag the screenshot from the shelf straight into a web page | I skip saving and the file picker | P0 |
| US-3 | web worker | click a shelf item to copy it | I can paste into apps that don't accept drops | P0 |
| US-4 | tidy user | have screenshots disappear automatically | my disk stays clean | P0 |
| US-5 | two-device person | click "phone" and scan a QR code | the image opens on my phone without email or chat | P0 |
| US-6 | two-device person | pair my phone once and see new captures there automatically | I never scan again | P0 (Sync) |
| US-7 | two-device person | send a photo/screenshot from my phone to my computer's shelf | I can drag it into a web app on my laptop | P0 (Sync) |
| US-8 | web worker | copy an expiring link to share with a colleague | they can see it without an account | P0 (Sync: longer expiry) |
| US-9 | any user | have screenshots I take with other tools (Win+Shift+S, ⌘⇧4) land on my shelf too | I don't have to change habits | P1 |
| US-10 | any user | pin an item so it doesn't expire | I keep something I still need | P1 |
| US-11 | Sync user | link my second computer (e.g., Mac + Windows PC) | my shelf follows me across computers | P1 (Sync) |
| US-12 | new user | be walked through permissions and a first capture | the app works on first try | P0 |

---

## 6. Functional requirements

Priority key: **P0** = must ship at launch · **P1** = ship in the first 2–4 weeks after launch if P0 is stable · **P2** = later / only if asked for.

### F1 — Capture (P0)

| Req | Description | Acceptance criteria |
|---|---|---|
| F1.1 | **Global hotkey for region capture.** Default ⌘⇧2 (macOS) / Ctrl+Shift+2 (Windows). User can change it. | Works while any app is focused, including full-screen apps. Conflicts are detected and shown in Settings. |
| F1.2 | **Region selection overlay.** A frozen, dimmed image of every monitor appears; user drags a rectangle; a live W×H label shows pixel size. | Opens in < 300 ms after the hotkey. Works across multiple monitors with different scaling (100/125/150/200%). Captured pixels match the physical resolution. |
| F1.3 | **Overlay shortcuts.** `Esc` cancels · `F` captures the whole current monitor · `Enter` captures the current selection · click without dragging captures the monitor under the cursor. | All shortcuts work on both OSes. |
| F1.4 | **Full-screen capture** from the tray menu (and an optional separate hotkey, unset by default). | Captures the monitor under the cursor. |
| F1.5 | **After capture:** save the PNG into Hopshot's private app-data folder (not Desktop/Downloads/Pictures), add it to the shelf, copy it to the clipboard (setting, default ON), and show the shelf with the new item highlighted. | The item is on the shelf in < 500 ms after mouse-up. |
| F1.6 | **Window capture** (hover to highlight a window, click to capture). | — **P1** |
| F1.7 | **Catch other screenshots** (US-9): optional watcher that adds images from the clipboard and/or the OS screenshot folder to the shelf. Off by default; toggle in Settings → Shelf. | — **P1** |

### F2 — Shelf (P0)

| Req | Description | Acceptance criteria |
|---|---|---|
| F2.1 | **Floating shelf window**: always-on-top, frameless, at the right screen edge (left/right setting), newest item on top. | Doesn't steal focus from the active app when it appears. |
| F2.2 | **Show/hide.** Shows on capture, on the "toggle shelf" hotkey (default ⌘⇧1 / Ctrl+Shift+1), on tray icon click, and when a phone item arrives. Auto-hides after 8 s without hover (setting: 4 s / 8 s / 15 s / never). A pin button keeps it open. | — |
| F2.3 | **Item card**: thumbnail, age/time-left chip ("23h"), source badge when not a capture ("from iPhone", "from clipboard"). | — |
| F2.4 | **Drag out** (core feature): dragging a thumbnail starts a native OS file drag with a real PNG file named `Screenshot 2026-09-29 at 14.03.22.png`. | Works in every target in the compatibility matrix (§9). |
| F2.5 | **Click to copy** the image to the clipboard; a "Copied" toast confirms. | Pasting works in Chrome, Edge, Safari, Slack desktop, Word. |
| F2.6 | **Hover actions:** Copy · Send to phone · Copy link · Reveal/Save as… · Delete. | Keyboard: arrow keys select, `⌘C`/`Ctrl+C` copies, `Delete` removes. |
| F2.7 | **Auto-expiry.** Items and their files are deleted when they expire (user picks 1 h / 24 h / 7 d; default 24 h). A cleanup job runs at launch and every 10 minutes. | Nothing is left in app-data after expiry. |
| F2.8 | **Capacity:** 100 items (the oldest unpinned item drops off). | — |
| F2.9 | **Save as…** writes a copy wherever the user chooses (for things they want to keep). | — |
| F2.10 | **Remove after drag** setting (default OFF). | — |
| F2.11 | **Pin item** so it never expires (local only; server copies still expire). | — **P1** |
| F2.12 | **Empty state** with the hotkey hint. | — |

### F3 — Send to phone with a QR code (P0, Lifetime)

| Req | Description | Acceptance criteria |
|---|---|---|
| F3.1 | **Phone button** on an item encrypts it on the device (AES-256-GCM, fresh random key), uploads the ciphertext, and shows a QR popover. | The popover appears in < 2 s for a 1 MB image on a 20 Mbps connection. |
| F3.2 | The QR encodes `https://hopshot.xyz/d/{id}#{key}`. The key lives only in the URL fragment, which browsers never send to the server. | The server never receives the key (verified by a test). |
| F3.3 | **Viewer page** on the phone downloads the ciphertext, decrypts it in the browser, and shows the image with **Save/Share** (Web Share API with files) and **Download** buttons, plus a live "Expires in…" countdown. | Works on iOS Safari 16+ and Android Chrome 110+. |
| F3.4 | **Limits (Lifetime):** 24 h expiry, 10 sends per day, 10 MB per image. Sync: 200 per day, up to 7 d. | A friendly limit message offers Sync. |
| F3.5 | **Delete now** in the popover removes the server copy immediately. | Viewer shows "This drop was deleted or has expired." |
| F3.6 | The viewer footer shows a small "Sent with Hopshot — for Mac & Windows" link. This is the built-in growth loop. | — |

### F4 — Paired phone feed (P0, Sync)

| Req | Description | Acceptance criteria |
|---|---|---|
| F4.1 | **Pair phone** (Settings → Devices, or tray menu): the desktop shows a QR code for `https://hopshot.xyz/pair#{inviteCode}.{vaultKey}`. The invite code is single-use and valid for 10 minutes. | Pairing completes in < 30 s end to end. |
| F4.2 | The phone opens the **Hopshot web app** (installable PWA), stores its device token and the vault key locally, and shows the feed. | — |
| F4.3 | **Auto-sync** (setting, default ON with Sync): every new capture is encrypted and uploaded to the vault and appears on paired phones within 3 s. | Live update over WebSocket; falls back to polling every 15 s. |
| F4.4 | **Phone feed:** grid of items newest first; tap to open with Share / Save / Copy / Delete; pull to refresh. | — |
| F4.5 | **Phone → computer:** an upload button on the phone (photo picker or camera) sends an image to the vault; it lands on the desktop shelf with a "from iPhone" badge, and the shelf pops out. | Arrives within 3 s. |
| F4.6 | **Android share target:** "Share → Hopshot" from any app on Android (PWA share_target). iOS doesn't support this for web apps, so iOS users use the upload button. | — |
| F4.7 | **Manage devices:** list the paired devices with a revoke button. Sync allows up to 3 phones. | A revoked device loses access right away. |
| F4.8 | **iOS install quirk:** on iOS, a home-screen web app has separate storage from Safari. After adding Hopshot to the home screen, the user scans the pairing QR once more using the web app's built-in scanner. The UI explains this clearly. | Verified on a real iPhone. |

### F5 — Share links (P0; longer expiry needs Sync)

| Req | Description |
|---|---|
| F5.1 | **Copy link** on an item uses the same encrypted-drop mechanism as F3 and copies `https://hopshot.xyz/d/{id}#{key}` to the clipboard. |
| F5.2 | Lifetime links expire after 24 h. Sync can pick 1 h / 24 h / 7 d. |
| F5.3 | **Delete link** at any time from the item's menu. |

### F6 — Settings (P0)

Sections: **General** (launch at login, hotkeys, after-capture actions, theme) · **Shelf** (side, auto-hide delay, item expiry, capacity info, remove after drag, catch other screenshots [P1]) · **Devices** (pair phone, list/revoke, auto-sync toggle) · **License** (plan, activate/deactivate key, buy) · **Privacy** (anonymous stats opt-in, crash reports opt-in, "delete all my cloud data") · **About** (version, check for updates, links).

### F7 — Onboarding (P0)

1. **Welcome:** a one-sentence value statement and the hotkey.
2. **Permissions (macOS only):** explain the Screen Recording permission → "Open System Settings" button → a live check that turns green when granted. Also note that macOS may ask again monthly (this is a macOS behaviour, not a bug).
3. **Try it:** "Press ⌘⇧2 and select anything." The step completes when the first capture lands, and the shelf is shown with a hint: "Now drag this into any browser tab."
4. **Optional:** pair your phone (Sync, included in the trial) or try Send to phone.
5. **Stats opt-in** checkbox (unchecked by default).

### F8 — Trial, licensing and purchase (P0)

| Req | Description |
|---|---|
| F8.1 | **7-day free trial of everything** (including Sync) starts on first launch: no account, no card. A small "Trial · 5 days left" chip shows in the shelf footer. |
| F8.1a | **When the trial ends** without a purchase, capture is paused; the shelf stays readable and draggable until its items expire, and a plans screen offers Lifetime or Lifetime + Sync. Paired phones stop receiving new items. |
| F8.2 | **Buy** opens Stripe Checkout in the browser (`api.hopshot.xyz/v1/buy/{lifetime|bundle}`) for **Lifetime** or **Lifetime + Sync** (Lifetime plus the first year of Sync, paid once). Checkout asks for name and billing address (required for export payments from India). There is **no license key**: the purchase belongs to the checkout email and unlocks the app automatically (F8.3). **Add Sync** (Lifetime owners) opens Stripe Checkout for the $24/year subscription for the same customer. **Manage Sync** opens the Stripe customer portal (card, invoices, cancel). |
| F8.3 | **Activation without keys.** Each computer gets a hidden device token kept in the OS keychain. **(a) Bought in the app:** the app unlocks by itself a few seconds after payment; no input. **(b) Bought on the website (and founders):** the thanks page and the purchase email have an **Open in Hopshot** button that unlocks the app in one click. **(c) New computer or reinstall:** "Already bought? Restore" → enter the purchase email → click the link in the email (or type its 6-digit code). **Computer limit, counted automatically:** **Lifetime = 1 computer**; **Lifetime + Sync = up to 3** while Sync is active. A computer over the limit silently takes the slot of one unused for 30+ days; otherwise the app asks which computer to move from (Lifetime: "Hopshot is active on {other computer}. Move it here?" with an **Add Sync to use up to 3 computers** link). **If Sync ends**, the most recently used computer stays licensed and the others show the same move-or-renew screen; nothing on them is deleted. Settings → License lists the computers, each with Remove. |
| F8.4 | **Offline:** the license is re-checked every 7 days; paid plans keep working for 30 days offline. |
| F8.5 | Paid features unlock instantly; no restart. |
| F8.7 | **Sync lapses:** if Sync is cancelled, its included year ends without a card, or a renewal payment fails (Stripe retries; 7-day grace), Sync features stop at the end of the paid period. Lifetime features keep working forever. Items already on the user's devices stay until they expire. |
| F8.6 | If Hopshot isn't installed yet when the user clicks **Open in Hopshot**, the page offers the download; the link keeps working after install (valid 30 days, up to the purchase's computer limit). |
| F8.8 | **Sync renewal at $24/year.** **(a) Included year** (Lifetime + Sync buyers, and $19 founders from the public launch date): Sync starts as a Stripe subscription with 365 free days and **no card on file**, so nobody is charged by surprise. Hopshot emails **7 days before** the year ends, and the app shows a reminder in the shelf footer; both link to a page where the user adds a card. Adding a card any time before the end keeps Sync running, and the first $24 charge happens on the end date (no lost days). With no card, the subscription pauses on the end date, Hopshot emails "Sync has paused (the app keeps working)", and adding a card later resumes it. **(b) Paid yearly Sync** auto-renews; Hopshot emails **30 days before** each renewal with the date, the amount and a one-click manage/cancel link. Reminder emails have a "stop these reminders" link; renewal notices for paid subscriptions are always sent. |
| F8.9 | **Refunds** (14 days after purchase): refunding a payment in Stripe revokes its license automatically and cancels any included Sync; the app falls back to the trial-ended state at its next check. |

### F9 — Updates (P0)

- **Direct downloads (Mac DMG, Windows installer):** built-in updater checks at launch and every 24 h, downloads in the background and asks to restart. Update packages are signed.
- **Microsoft Store builds:** the Store handles updates, and the built-in updater is disabled.

### F10 — Link a second computer (P1, Sync)

On computer A: Settings → Devices → "Link another computer" shows a 12-character code (`ABCD-EFGH-JKLM`). On computer B: "Join with code". The server holds the vault key encrypted under that code for 10 minutes, single use, with at most 5 attempts. Both computers then share one shelf.

---

## 7. Pricing and packaging

No free plan. Everyone starts with a **7-day free trial of everything**, then picks one of two options.

| | **Lifetime: $19 once** ($12 at launch) | **Sync add-on: $24/year** |
|---|---|---|
| What it is | The app, forever, on 1 computer | Cloud features on top of Lifetime (requires Lifetime) |
| Hotkey capture, shelf, drag out, copy | ✅ | ✅ |
| Shelf size / item expiry | 100 / 1 h, 24 h or 7 d, pin (P1) | same |
| Catch other screenshots, window capture (P1) | ✅ | ✅ |
| Send to phone via QR + share links | 10/day, 24 h | 200/day, up to 7 d |
| Paired phone feed (auto-sync) | — | ✅ up to 3 phones |
| Phone → computer | — | ✅ |
| Computers it runs on | 1 | up to 3, Mac + PC in any mix |
| One shelf across computers, e.g. Mac + PC (P1) | — | ✅ |
| Updates | all 1.x updates | all 1.x updates |
| If you stop paying | — | Cloud features stop; Lifetime keeps working |

**Lifetime + Sync bundle:** Lifetime plus the first year of Sync, paid once; Sync then continues at $24/year only if the buyer adds a card (F8.8).

**Founder pre-order (validation phase only):** $19 = Lifetime + the first year of Sync (normally $43). Limited to the first 200 buyers, with a full refund at any time until 14 days after the app ships. On launch day, founders get an email with an **Open in Hopshot** button, created automatically from their Stripe payments (and $19 founders get their Sync year, starting that day); there is nothing to redeem or type.

**Launch pricing:** Lifetime **$12** and Lifetime + Sync **$19** (Lifetime + the first year of Sync), the same as founder prices, for a limited launch period. After that: Lifetime $19 and Lifetime + Sync $43 (or a small bundle discount). The site shows $19 / $43 struck through, so the price must actually go up when the launch period ends.

**Pricing reasons**

- **One-time for what costs nothing to run, subscription for what does.** Local features have no running cost, so they're sold once. Sync uses servers every day, so it's billed yearly. CleanShot X uses the same split (one-time app + cloud subscription).
- **Lifetime is one computer; more computers come with Sync.** Someone using Hopshot on two computers almost always wants the same shelf on both, which is what Sync does.
- **Sync is an add-on, not a separate app plan.** Nobody loses the app if they cancel, which makes the subscription an easy yes and keeps support simple.
- **No free plan, but a full trial.** A free plan mostly attracts people who never pay. A 7-day trial of everything (including Sync) shows the full "wow" (capture on laptop → appears on phone) and then asks for money.
- **Yearly only at launch.** One Sync price is simpler to explain and to remind people about. A monthly price can be added later as a second Stripe Price without code changes.
- **Comparable prices:** Gyazo Pro is $4.99/month; CleanShot X is about $35 one-time plus a monthly cloud plan; Dropover and Yoink are under $15 one-time. $19 + $24/year sits in the middle.
- **Payments: Stripe, directly.** BAS Technologies is the seller, and Hopshot tracks purchases and computers itself (no license keys). Foreign sales are exports of services, zero-rated for GST under a LUT; Indian customers pay 18% GST. EU/UK VAT on consumer sales is a known, accepted risk at launch: revisit with the CA if EU/UK sales grow, and move to a merchant of record (e.g. Polar) if it becomes a burden.
- **Net per sale** (Stripe India, international card in USD: 4.3% + 2% currency conversion, plus 0.7% Stripe Billing on subscriptions): ≈ $11.25 for Lifetime at $12, ≈ $17.80 for Lifetime + Sync at $19, ≈ $22.30 per yearly Sync renewal.
- **Rough revenue picture:** 100 Lifetime buyers = $1,900 once. 100 Sync subscribers = about $2,400 every year (~$200 a month recurring).
- A 2.x major version *may* be a paid upgrade later. Say "all 1.x updates included" on the pricing page and nothing more.

---

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| **Performance** | Idle RAM < 80 MB · idle CPU ≈ 0% · overlay appears < 300 ms after the hotkey · cold start < 1.5 s · installer < 15 MB |
| **Privacy** | Images leave the device only when the user sends/shares them or has turned on auto-sync. Everything is end-to-end encrypted, the server stores only ciphertext, and keys never reach the server. No accounts. |
| **Security** | Device tokens, the vault key and the license device token are stored in the OS keychain (macOS Keychain / Windows Credential Manager). Tokens are hashed on the server. All traffic uses TLS. Uploads are rate-limited per IP and per vault. |
| **Retention** | Server deletes drops and vault items at expiry. A storage lifecycle rule acts as a second safety net. Invites expire after 10 min. |
| **Reliability** | If the network fails, the local shelf keeps working; uploads retry 3 times with backoff and then show a clear error. |
| **Accessibility** | Full keyboard control of the shelf and settings, visible focus rings, contrast ≥ 4.5:1, respects reduced-motion. |
| **Localisation** | English only in v1. Keep strings in one file so translation is easy later. |
| **Telemetry** | Opt-in only. Anonymous events (no images, no filenames, no IPs stored). Opt-in crash reports. |
| **Compliance** | Privacy policy, terms (including acceptable use), an abuse report link on every viewer page, and a takedown process (a drop can be deleted by ID). |

---

## 9. Drag-out compatibility matrix (release gate)

Test on both **macOS** and **Windows** in Chrome, Edge and Safari (Mac only) plus the desktop apps listed. P0 targets must pass before launch.

| Target | Type | Priority |
|---|---|---|
| Gmail compose (attachment + inline) | Web | P0 |
| Slack (web + desktop) | Web/App | P0 |
| WhatsApp Web | Web | P0 |
| ChatGPT / Claude.ai prompt box | Web | P0 |
| Jira / Linear / GitHub issue comment | Web | P0 |
| Google Docs / Notion | Web | P0 |
| Microsoft Teams | App | P1 |
| Outlook (new) / Word | App | P1 |
| Figma | Web/App | P1 |
| Finder / File Explorer (drop = save copy) | OS | P0 |

---

## 10. Success metrics

| Metric | Definition | 30-day target |
|---|---|---|
| Downloads | Website + Microsoft Store installs | 1,500 |
| Activation | % of installs with ≥ 3 captures within 24 h | 40% |
| Core action | % of active users who drag-out or send-to-phone at least once | 60% |
| Week-2 retention | % of activated users who capture in days 8–14 | 20% |
| Trial → paid | Purchases / activated trials | 10% |
| Sync attach | % of buyers who add Sync | 25% |
| Sync renewal | % of yearly Sync subscribers who renew (measured at month 12) | 60% |
| Refund rate | Refunds / purchases | < 5% |
| Crash-free sessions | Opt-in crash data | > 99.5% |

**Decision at day 60 after launch:** if organic sales (Lifetime + new Sync) are under 20 per month after the launch spike, move to maintenance mode (bug fixes and OS compatibility only) and stop adding features.

---

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Windows code signing isn't available cheaply from India.** Azure Artifact Signing is limited to individual developers in the US/Canada and organisations in a short list of countries that doesn't include India. | Direct `.exe` downloads show a SmartScreen "Windows protected your PC" warning. | Make the **Microsoft Store** the main Windows channel: individual registration is free, and the Store signs MSIX packages. Offer the direct installer as a secondary option with clear "More info → Run anyway" instructions. Buy an OV certificate ($150–300/yr) once direct sales justify it. |
| **macOS re-asks for Screen Recording permission** (Sequoia and later, roughly monthly). | Users think the app is broken. | Explain it during onboarding; detect a missing permission and show a friendly one-click fix. |
| **Drag-out behaves differently per app/OS.** | The core promise fails in some targets. | The compatibility matrix is a release gate. Offer "Copy" as a universal fallback. Use a real temporary PNG file with a proper name. |
| **Overlay above full-screen apps / menu bar (macOS) or with mixed DPI (Windows).** | Capture looks broken. | Spike this on day 1–2 of the build (see `BUILD_PLAN.md` Phase 1). Set native window level/collection behaviour on macOS; use per-monitor windows on Windows. |
| **Abuse:** anonymous encrypted drops used to host bad content. | Legal/hosting risk. | 24 h default and 7 d maximum, daily caps, 10 MB size cap, IP rate limits, a report link, delete-by-ID takedowns, and terms of service. |
| **iOS home-screen web app storage is separate from Safari.** | Pairing seems lost after "Add to Home Screen". | Built-in QR scanner inside the web app; clear instructions (F4.8). |
| **Ongoing maintenance** (OS updates, certificates, support). | "Passive income" turns into unpaid work. | Keep scope tiny; auto-updates; FAQ page; support by email only; a 2-hour-per-week maintenance budget. |
| **Name/trademark** ("Hopshot" is also the name of an indie Steam game, a different category). | Confusion in search; possible dispute. | Search USPTO/WIPO before launch; reserve the name in Microsoft Partner Center; file a trademark once revenue justifies it; keep the name in one config constant. |
| **Needs a Mac for testing.** | Mac bugs can't be reproduced on Windows. | Borrow or rent a Mac (or a cloud Mac) for weeks 1, 3 and 4; build Mac binaries in GitHub Actions. |

---

## 12. Release plan (summary)

| Week | Milestone |
|---|---|
| 1 | Desktop core: tray app, hotkey, capture overlay (Mac + Win), shelf, drag-out, copy, expiry |
| 2 | Backend + encrypted drops + QR send + viewer page; settings; onboarding |
| 3 | Trial + licensing (Stripe: Lifetime, Lifetime + Sync, Sync renewals), vault pairing, phone web app (feed + upload), live sync; packaging/signing; private beta (20 users) |
| 4 | Fix beta issues, landing page, Store listing, launch assets → **launch week** |

Details: `BUILD_PLAN.md`. Launch checklist: `docs/LAUNCH.md`.

---

## 13. Open questions

1. Trademark search for "Hopshot" (USPTO/WIPO) and Microsoft Store name reservation.
2. Store version pricing: the Store listing is a free download with the in-app 7-day trial and Stripe checkout (Microsoft allows non-game apps to use their own payment system; confirm current Store policy before submitting).
3. Founder pre-order: cap at 200 buyers or at 7 days, whichever comes first?
4. Is it worth making Window capture (F1.6) P0 for Mac users, who expect it from ⌘⇧4 + Space?

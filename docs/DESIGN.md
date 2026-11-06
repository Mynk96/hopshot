# Hopshot — Design Spec

Visual reference: open `design/mockups.html` in a browser. It's clickable, and it has a light/dark toggle. This document is the source of truth for tokens, components, states and copy.

---

## 1. Design principles

1. **Invisible until needed.** Hopshot never steals focus and never shows a Dock/taskbar icon. The shelf slides in, does its job and slides away.
2. **One gesture per job.** Drag to use, click to copy, one button to send to the phone.
3. **Native, not webby.** Use system fonts, native vibrancy (macOS) and acrylic/Mica (Windows 11), OS-appropriate shortcuts and wording ("Finder" vs "File Explorer", ⌘ vs Ctrl).
4. **Calm about time.** Expiry is shown as a small neutral chip, never as an alarm. Only the last hour turns amber.
5. **Private by default, and says so briefly.** "End-to-end encrypted · gone in 24h", never a paragraph.

---

## 2. Design tokens

### 2.1 Color

| Token | Dark (default for shelf/overlay) | Light |
|---|---|---|
| `--surface` (glass panel) | `rgba(24,24,28,0.78)` + blur 24px | `rgba(250,250,250,0.82)` + blur 24px |
| `--surface-solid` (fallback, Win10) | `#1C1C21` | `#F7F7F8` |
| `--surface-2` (cards, inputs) | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.04)` |
| `--surface-3` (hover) | `rgba(255,255,255,0.10)` | `rgba(0,0,0,0.07)` |
| `--border` | `rgba(255,255,255,0.10)` | `rgba(0,0,0,0.08)` |
| `--text` | `#F4F4F5` | `#18181B` |
| `--text-2` | `#A1A1AA` | `#52525B` |
| `--text-3` | `#71717A` | `#71717A` |
| `--accent` | `#FF6B2C` | `#FF6B2C` |
| `--accent-hover` | `#FF8347` | `#F25E1F` |
| `--on-accent` (text on accent) | `#1B0F08` | `#1B0F08` |
| `--accent-text` (links/labels) | `#FF9A6B` | `#C2410C` |
| `--success` | `#34D399` | `#059669` |
| `--warning` (last hour) | `#FBBF24` | `#B45309` |
| `--danger` | `#FF5A5F` | `#DC2626` |
| `--focus` ring | `0 0 0 2px var(--accent)` | same |
| Overlay dim | `rgba(0,0,0,0.35)` | same |

White text on `#FF6B2C` fails contrast, so primary buttons always use `--on-accent` (near-black) text.

### 2.2 Typography

- **Font stack:** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif`
- **Mono** (sizes, codes): `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace`

| Style | Size / line-height / weight | Use |
|---|---|---|
| `caption` | 11 / 14 / 500 | chips, badges |
| `small` | 12 / 16 / 400 | secondary text |
| `body` | 13 / 18 / 400 | default UI text |
| `body-strong` | 13 / 18 / 600 | labels, buttons |
| `title` | 15 / 20 / 600 | panel titles |
| `heading` | 20 / 26 / 650 | settings headings, onboarding |
| `display` | 28 / 34 / 700 | onboarding hero, landing |

### 2.2a Elevated surfaces (floating panels)

`--surface-2` and `--surface-3` are 4–10 % **tints**, meant to sit on top of an opaque
surface. They are not panel backgrounds: used as one on a transparent window, the panel is
~90 % see-through and its text is unreadable over the wallpaper. Popovers, menus and toasts
use these instead, and they are opaque.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--surface-raised` | `#26262C` | `#FFFFFF` | popover / menu / toast background |
| `--surface-raised-2` | `rgba(255,255,255,.07)` | `rgba(0,0,0,.05)` | rows, inputs, code inside a raised panel |
| `--raised-border` | `rgba(255,255,255,.14)` | `rgba(0,0,0,.10)` | hairline on a raised panel |
| `--hover` | `rgba(255,255,255,.08)` | `rgba(0,0,0,.06)` | pointer hover on any control |
| `--press` | `rgba(255,255,255,.14)` | `rgba(0,0,0,.11)` | pressed |
| `--scrim` | `rgba(0,0,0,.62)` | same | chip/action-bar backing **over a screenshot** |
| `--on-scrim` | `#FFFFFF` | same | text/icons on a scrim |
| `--card-letterbox` | `#101014` | same | bars around a thumbnail that does not fill its card |
| `--shadow-raised` | `0 16px 48px rgba(0,0,0,.30), 0 2px 8px rgba(0,0,0,.16), 0 0 0 1px var(--raised-border)` | | floating-panel elevation |

`--scrim`, `--on-scrim` and `--card-letterbox` do **not** swap with the theme: their backdrop
is a screenshot, not the UI surface.

**`backdrop-filter` only blurs page content.** On a `transparent: true` window it cannot
blur the desktop behind the window — Chromium samples the backdrop inside the compositing
context only. Real glass comes from the OS (Windows acrylic, macOS vibrancy), so
`backdrop-filter` is used solely where the thing behind it is in the page: the card action
bar and chips, which sit over the thumbnail.

**The glass fallback is wired, not aspirational.** `platform::configure_shelf` returns
whether the OS actually applied a backdrop; the shelf reads it via `shelf_has_vibrancy` and
sets `html.no-vibrancy`, which redefines `--surface` to `--surface-solid` (see §7).

### 2.3 Space, radius, elevation, motion

- **Spacing:** 4-pt grid (4, 8, 12, 16, 20, 24, 32).
- **Radius:** panel 14 · card/thumbnail 10 · button/input 8 · chip 999.
- **Shadow (floating):** `0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px var(--border)`.
- **Motion:**
  - Shelf enter: slide 16 px from the edge + fade, 180 ms, `cubic-bezier(.2,.8,.2,1)`. Exit: 140 ms.
  - New item: scale .96 → 1 plus an accent ring that fades out over 900 ms.
  - Toast: fade/slide 8 px, 160 ms, auto-dismiss after 1.6 s.
  - `prefers-reduced-motion`: fades only, no slides or scales.
- **Icons:** Lucide at 16 px, 1.75 stroke. Names: `copy`, `smartphone`, `link`, `trash-2`, `pin`, `folder-down`, `x`, `settings`, `check`, `qr-code`, `upload`, `share`, `download`.

---

## 3. Components

| Component | Spec |
|---|---|
| **Button** | Height 30 (compact 26), padding 0 12, radius 8, `body-strong`. Variants: `primary` (accent/on-accent), `secondary` (surface-2 + border), `ghost`, `danger-ghost`. States: hover, pressed (scale .98), focus ring, disabled (40% opacity). |
| **Icon button** | 28×28, radius 8, ghost; tooltip after 400 ms; `aria-label` required. |
| **Chip** | Height 18, padding 0 6, `caption`, surface-2. Time chip turns `--warning` text under 1 h left. |
| **Badge (source)** | Chip with an icon: "iPhone", "Clipboard", "Windows PC". |
| **Thumbnail card** | 184×115 (16:10), `object-fit: cover`, radius 10, 1 px border. Hover: lift 1 px + action bar. Selected: 2 px accent ring. Dragging: 50% opacity in place. |
| **Action bar** | Appears on hover/focus at the bottom of the card: glass pill with 4 icon buttons (Copy, Phone, Link, More ▾). More → Save as…, Reveal, Pin, Delete link, Delete. |
| **Toast** | Floating pill at the top of the shelf: icon + one short line. |
| **Popover (QR)** | 260 wide, anchored to the card's left side (right side if the shelf is on the left), glass, radius 14. |
| **Switch** | 32×18, accent when on. |
| **Segmented control** | For expiry (1h / 24h / 7d) and shelf side (Left / Right). Sync-only options show a small lock (for Lifetime users) and open the plans sheet on click. |
| **Keycap** | Mono 11 px, 1 px border, radius 5, padding 1 5, e.g. `⌘` `⇧` `2`. |

---

## 4. Screens and states

### S1 — Tray / menu-bar menu (native menu)

```
Capture area                ⌘⇧2
Capture full screen
Show shelf                  ⌘⇧1
Send last to phone
─────────────
Pair phone…            (SYNC badge if not on Sync)
Settings…                   ⌘,
Buy Hopshot — $19      (unlicensed only)
─────────────
Quit Hopshot                ⌘Q
```

Windows shows `Ctrl+Shift+2` etc. Tray icon: a monochrome template image (macOS) or a 16/20/24/32 px icon (Windows).

### S2 — Capture overlay

- Frozen screen, dimmed. Crosshair cursor.
- **Idle:** centered hint pill near the top: `Drag to capture · F full screen · Esc cancel`.
- **Dragging:** the selection is undimmed with a 1 px white inner border and a 1 px black outer border. A mono size label (`1280 × 720`) sits below-right of the cursor and flips inside near screen edges.
- **Committed:** 80 ms white flash inside the selection (skipped with reduced motion), then the overlay hides.

### S3 — Shelf (the core screen)

- **Size:** 208 px wide; height fits its content up to 80% of the screen, then scrolls. Margin 12 px from the screen edge, vertically centered.
- **Header (36 px):** app mark + "Hopshot" (`title`), item count chip, pin-open toggle, settings, close.
- **List:** newest first, 8 px gap.
- **Footer:** `12 items · Gone in 24h` — the privacy line, which is the point of the product. Offline → `Offline — sending paused`. There is no countdown chip and no plan banner: the shelf is free, so there is nothing to count down or unlock (docs/designs/free-shelf-phone-trial.md). When an update is pending, `· Update to 0.1.3` is appended — a plain underlined word, no badge and no colour, that opens Settings → About rather than installing in place (ARCHITECTURE §9).

**States**

| State | What shows |
|---|---|
| Empty | Illustration-free: "Nothing here yet" + keycaps `⌘ ⇧ 2` + "Screenshots land here, not on your desktop." |
| New capture | Card slides in at the top with the accent ring; toast "Copied to clipboard" (if on) |
| Hover | Action bar; time chip stays visible |
| Dragging | Card at 50%; after a successful drop, toast "Dropped" (and remove it if the setting is on) |
| From phone | Badge "iPhone"; shelf auto-opens; toast "New from Mayank's iPhone" |
| Uploading | Thin 2 px progress bar at the bottom of the card |
| Upload error | Small danger dot on the card + toast "Couldn't send — Retry" |
| Offline | Footer: "Offline — sending paused" |
| Capacity reached (100) | Oldest unpinned card fades out when a new one arrives |
| Unlicensed (nothing bought, or refunded) | Capture, shelf, drag and copy all work; no banner. The phone is the paid part: the Send to phone sheet shows the offer instead (S4, "Unlicensed"). |

### S4 — Send to phone (QR popover)

- Title "Scan with your phone".
- QR 180×180 on a white tile (always light, for scan reliability) with the Hopshot mark in the center.
- Below it: the link in mono (truncated) + Copy button.
- A line showing `Expires in 24h · End-to-end encrypted`.
- Actions: `Delete now` (danger-ghost), `Done`.
- **Sync + paired:** instead of the QR, show "Sent to Mayank's iPhone ✓" with a "Show QR instead" link.
- Loading: QR placeholder with a shimmer and "Encrypting…" → "Uploading 62%".
- **Unlicensed** (nothing bought): the sheet makes no request. Title **"Phone · $19 once"**, body "Send to phone, share links and a paired phone feed. Pay once, no subscription. 14-day refund, no questions." Actions `Buy · $19 once` (primary, opens Checkout) and `Already bought? Restore` (ghost, opens Settings → License). This is the only place the shelf asks for money: at the moment of intent, never as a nag.

### S5 — Phone web app (`/app`)

- **Top bar:** "Hopshot" + a sync dot + menu (Device name, Unpair, Help).
- **Feed:** 2-column grid of 16:10 cards, time chips; sticky day separators aren't needed (everything is < 7 days old).
- **FAB:** `+ Send to computer` → system photo picker.
- **Item view:** full-bleed image, bottom bar with `Share` · `Save` · `Copy` · `Delete`.
- **Empty:** "Take a screenshot on your computer — it shows up here."
- **Pairing success:** a big check, "Paired with Mayank's MacBook", and a button **Add to Home Screen** with platform instructions. On iOS, add the note "After adding, open Hopshot from your Home Screen and tap *Scan to finish*."

### S6 — Drop viewer (`/d/:id`)

- Minimal page: image centered on a neutral background, the file name, and `Expires in 23h 12m`.
- **Buttons:** `Save to Photos` / `Share` (mobile), `Download`, `Copy`.
- **Footer:** "Sent with **Hopshot** — screenshots that clean up after themselves. For Mac & Windows →" · `Report`.
- **States:** decrypting (spinner), expired/deleted ("This drop has expired. Drops disappear after 24 hours."), bad link ("This link is incomplete — ask the sender to copy it again.").

### S7 — Settings (720×520, sidebar + content)

- **General:** Launch at login · Capture hotkey · Show shelf hotkey · After capture: [✓] Copy to clipboard [✓] Show shelf · Theme: System / Light / Dark.
- **Shelf:** Position Left/Right · Auto-hide 4s/8s/15s/Never · Keep items 1h / **24h** / 7d · Remove after drag · Catch other screenshots (P1).
- **Devices:** paired list (icon, name, last seen, Revoke) · `Pair a phone` · `Link another computer` (P1) · Auto-sync captures to my devices.
- **License:** plan card (Lifetime / Lifetime + Sync with the date Sync runs until, plus **Manage Sync**; or the plans block with both prices and the 14-day refund when nothing is bought) and the purchase email; **Computers (n of 3)** with Remove on each; `Buy Hopshot`, `Add Sync` or `Manage subscription`; when nothing is bought, **Already bought? Restore** (PRD F8.3c — the path for a reinstall or a second computer). No key field anywhere.
- **Privacy:** Anonymous usage stats (off) · Crash reports (off) · `Delete all my cloud data` (danger, with a confirm step).
- **About:** the running version (read from the binary, never hard-coded), then the update
  block: `Check for updates` → `You're up to date` or `Hopshot 0.1.3 is available` with
  `Install and restart` and the line "Installing closes Hopshot and reopens it. Your shelf is
  kept." Hidden entirely in the Microsoft Store build. Then Website, Support email, Licenses.

### S8 — Onboarding (560×600)

1. **Welcome:** display text "Screenshots that clean up after themselves." + 3 bullets (Drag anywhere · Open on your phone · Gone in 24h) → `Get started`.
2. **Permission (macOS only):** "Hopshot needs Screen Recording permission to capture your screen." → `Open System Settings`. A live status row goes from ◌ Waiting… to ✓ Granted. Small print: "macOS may ask you to confirm this again from time to time."
3. **Try it:** keycaps animation `⌘ ⇧ 2` → "Select anything on your screen." Completes automatically when the first capture lands, then shows "Now drag it from the shelf into any browser tab."
4. **Done:** "Buy Hopshot to start capturing — $19 once, everything included. 14-day refund, no questions." → `See plans` / `Finish`, plus a stats opt-in checkbox (unchecked).

### S9 — Plans sheet

- One column (PRD §7 has one plan). Owners whose Sync has lapsed see the renewal instead.
- Price block: **$19 once**, everything included, first year of Sync bundled, then $24/year opt-in. A licence whose Sync has lapsed sees only **Add Sync · $24/year**.
- Buttons: `Buy Hopshot · $19` (primary) · `Already bought? Restore`.
- After a Buy click the sheet shows "Finish paying in your browser…" and unlocks by itself when payment completes ("You're all set"). Restore: email field → "Check your email" → the link opens the app, or a 6-digit code field.
- Over the computer limit. **Lifetime (1):** "Hopshot is active on {other computer}. Move it here?" with **Move here** (primary) and a small link **Add Sync to use up to 3 computers**. **Lifetime + Sync (3):** "Hopshot is on 3 computers. Remove one to use it here." with the list (name, last used) and Remove buttons. After Sync ends, extra computers show the Lifetime version with **Renew Sync** as the link.
- Trust line: "Secure checkout by Stripe · 14-day refund".

---

## 5. Microcopy

| Moment | Copy |
|---|---|
| Copied | "Copied" |
| Dropped | "Dropped" |
| Sent to phone (paired) | "Sent to {device}" |
| Limit (Lifetime drops) | "That's 10 sends today. Sync raises it to 200." |
| Capacity | "Shelf holds 100. Oldest one made room." |
| Phone offer (unlicensed) | "Phone · $19 once" / "Send to phone, share links and a paired phone feed. Pay once, no subscription. 14-day refund, no questions." |
| Sync lapsed | "Sync is off — your phone won't get new screenshots. Everything else still works." |
| Expired item clicked (race) | "That one just expired." |
| Permission missing | "Hopshot can't see your screen yet. Fix in one click →" |
| Offline | "Offline — sending paused" |
| Delete all cloud data confirm | "Delete everything Hopshot stored online? Your shelf on this computer stays." |
| Pair expired | "This pairing code expired. Make a new one on your computer." |

Voice: short, plain, friendly. Never "Oops!" or exclamation marks in errors. Use "you" and "your".

---

## 6. App icon (brief for designer / generation)

A rounded square (macOS squircle / Windows 11 style) with a deep charcoal gradient background (#24242A → #121216). In the center is a short horizontal orange (#FF6B2C) "shelf" line with a slightly tilted white photo card resting on it, and a tiny dog-ear corner on the card. No text. It must read well at 16 px: the shelf line + card silhouette.

---

## 7. Accessibility

- Every icon button has an `aria-label` and a tooltip.
- Shelf keyboard: `↑/↓` select, `Enter` copy, `⌘/Ctrl+C` copy, `P` send to phone, `L` copy link, `Delete` remove, `Esc` hide.
- Focus rings are always visible when using the keyboard (`:focus-visible`).
- Contrast: body text ≥ 4.5:1 on glass. Check against both a white and a black wallpaper, since the glass is translucent. Fall back to `--surface-solid` when "Reduce transparency" is on (macOS) or on Windows 10.

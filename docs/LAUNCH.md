# Hopshot — Launch Plan and Checklists

## 1. Release QA checklist (run on macOS AND Windows before every public release)

**Capture**
- [ ] Hotkey works over: a normal window, a full-screen app/video, the desktop, the Start menu / menu bar
- [ ] Multi-monitor with different scaling (e.g., 100% laptop + 150% external); capture on each monitor; crop is pixel-exact
- [ ] Esc / F / Enter / click-without-drag behave as in PRD F1.3
- [ ] macOS: fresh install → permission flow → capture works; revoke the permission → friendly fix message

**Shelf**
- [ ] Doesn't steal focus: typing in the browser continues while the shelf shows
- [ ] Drag-out passes every P0 target in PRD §9
- [ ] Copy / Save as / Reveal / Delete / keyboard navigation
- [ ] Expiry (set the TTL to 2 min in a debug build) and capacity of 100
- [ ] Sleep → wake: hotkeys still work, sync reconnects

**Cloud**
- [ ] QR send → iPhone Safari + Android Chrome → Save to Photos works
- [ ] Delete now → link shows expired
- [ ] Lifetime daily send limit message shows at the 11th send
- [ ] Trial: countdown chip, "trial ending" message, trial-ended state (capture paused, shelf readable), buying unlocks instantly
- [ ] Sync: pairing, auto-sync < 3 s, phone → shelf, revoke, "Delete all my cloud data"
- [ ] Offline: shelf works, sends queue/fail gracefully

**Install / update / license**
- [ ] Clean install on a fresh user account; uninstall leaves no files outside app-data
- [ ] Update from the previous version via the updater (direct builds)
- [ ] Buying in the app unlocks it with no input; the **Open in Hopshot** link and email restore both work; a computer over the limit (Lifetime 1, Lifetime + Sync 3) takes an unused slot or asks which computer to move from; ending Sync leaves only the most recent computer licensed
- [ ] Store MSIX installs and runs; the updater is disabled in the Store build

---

## 2. Launch assets (prepare in Phase 7)

| Asset | Spec |
|---|---|
| **Demo video (the most important asset)** | 20–30 s, no voice-over, captions. Script: hotkey → select → drag into Gmail → click phone → scan → it's on the phone → "gone in 24h". Record on Windows *and* Mac. |
| GIFs | 3 loops: drag-out, send-to-phone, phone → laptop (for Reddit/X) |
| Screenshots | 5 at 1270×760 (Product Hunt) + Store sizes; light and dark |
| Icon | 1024 px master + all sizes (DESIGN §6) |
| Tagline (≤ 60 chars) | "Screenshots that drag anywhere and clean up after themselves" |
| Short description | "Hopshot puts every screenshot on a floating shelf. Drag it into any website, send it to your phone, and it's gone in 24 hours. Mac & Windows." |
| Landing page | Live, with Download (7-day trial) + Lifetime and Sync checkout; FAQ covers privacy, SmartScreen, macOS permission and refunds |
| Support | founder@hopshot.xyz + a short FAQ; canned replies for the top 5 questions |
| Launch pricing | Lifetime $12 and Lifetime + Sync $19 for a limited launch period, then $19 / $43; change a price by moving its Stripe lookup key (no deploy). Site buttons go to `https://api.hopshot.xyz/v1/buy/{lifetime|bundle}?ref=…` |
| Founders | Launch day: run `scripts/export-founders.mjs`, import each row with `POST /admin/licenses` (syncStartsAt = launch date); keys go out by email automatically. Then switch the site's pre-order buttons to the `/buy` links |

---

## 2b. Stripe and secrets setup (do once, before the first real sale)

Hopshot has no licence keys, so Stripe *is* the licensing system: a verified webhook is the
only thing that mints a licence. Everything below has to exist before the buy buttons work.

### Three Prices

| Env var | What | Mode |
|---|---|---|
| `STRIPE_PRICE_LIFETIME` | $12 launch ($19 after) | one-time |
| `STRIPE_PRICE_BUNDLE` | $19 launch ($43 after) — Lifetime **and** the first year of Sync | one-time |
| `STRIPE_PRICE_SYNC_YEARLY` | $24/year | **recurring, yearly** |

Price ids are not secrets; they live in `services/api/wrangler.toml` under `[vars]`. Give each
one a **lookup key** so a price change is a dashboard edit rather than a deploy.

The bundle is deliberately a one-time price, not a subscription with a trial: the $19 is
charged at checkout, and the card is saved (`setup_future_usage: off_session`) so that the
renewal a year later is one click. **Nothing renews automatically** — see §2c.

### Three secrets

Never in `wrangler.toml`, never in the repo:

```bash
npx wrangler secret put STRIPE_SECRET_KEY --config services/api/wrangler.toml
```

Also `STRIPE_WEBHOOK_SECRET` and `RESEND_API_KEY` the same way.

### Webhook endpoint

`https://api.hopshot.xyz/v1/webhooks/stripe`, subscribed to exactly these:

- `checkout.session.completed` — mints the licence and fulfils the claim the app is polling
- `charge.refunded`, `charge.dispute.created` — deactivate it again
- `customer.subscription.created`, `.updated`, `.deleted` — keep `subscriptions` in step
- `invoice.paid`, `invoice.payment_failed` — start and clear the `past_due` grace window

Then enable the **Customer Portal** (Settings → Billing → Customer portal), which is what
Settings → License → Manage Sync opens. Allow cancellation and payment-method updates.

## 2c. How the Sync renewal works (PRD F8.8)

The bundle includes the first year of Sync. It does **not** auto-renew — that is a deliberate
product decision, not a missing feature:

1. A daily 09:00 UTC cron finds bundles whose year ends within 10 days.
2. Each gets **one** email (deduplicated per licence per year through `emails_sent`) with a
   single-use link: *"Nothing will be charged. If you want to keep syncing…"*
3. The link burns the token and redirects into Checkout for `STRIPE_PRICE_SYNC_YEARLY`,
   against the saved card.
4. If they do nothing, Sync stops: phones unpair and the computer limit drops from 3 to 1.
   **Lifetime keeps working forever** — shelf, capture, drag-out and share links.

Settings → License shows the end date while Sync is live, so nobody learns about it on the day.

### Verify it before launch

Run the test clock. It fast-forwards a simulated year in about a minute and charges a
year-old card, which is the one thing code review cannot tell you:

```bash
STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_SYNC_YEARLY=price_... node scripts/test-renewal-clock.mjs
```

`FAIL=1` uses a card that declines off-session, to exercise the `past_due` path and the
`limits.sync.paymentGraceDays` window. The script refuses to run against a live key and
deletes its test clock (and the customer, charge and subscription with it) when it finishes.

### India / RBI

Recurring card mandates on Indian cards need an e-mandate, and registration fails above
₹15,000 without additional authentication. $24/year is well inside that, but confirm with
Stripe support that your account can take recurring INR mandates before relying on renewal
revenue.

---

## 3. Channel plan

| When | Channel | Notes |
|---|---|---|
| Launch −14 days | **BetaList**, **Uneed**, **Microsoft Store** submission | The BetaList free queue can take weeks; Store review can take a few days, so submit early |
| Launch −7 days | Product Hunt "coming soon" page; tell beta testers the date | Ask testers to follow the page (don't ask for upvotes; PH penalises that) |
| **Launch day (Tue/Wed/Thu)** | **Product Hunt** | Goes live 12:01 AM Pacific = 12:31 PM IST (before 1 Nov) or 1:31 PM IST (after US clocks change on 1 Nov). Post the maker comment right away; reply to everything all day. |
| Launch day +2–3 h | **Show HN** | Title: `Show HN: Hopshot – screenshots land on a shelf, drag anywhere, gone in 24h`. Link to the site. The first comment covers what it does, how the encryption works (key in URL fragment) and why Tauri. |
| Launch day + 1 | **Reddit**: r/SideProject, r/macapps, r/Windows11, r/software, r/productivity | Read each subreddit's self-promotion rules first; use the right flair; one subreddit per day; lead with the GIF and the problem, not the price. |
| Launch day + 1–3 | **Indie Hackers** (launch post + "how I built it" story), X/LinkedIn thread with the video | Your founder story (a CSMS founder building a tiny utility) is itself a hook |
| Launch week | **AlternativeTo** (list as an alternative to Dropover, Yoink, Gyazo, ShareX, CleanShot X), **SaaSHub**, **Product Hunt alternatives pages** | These bring slow, steady long-term traffic |
| Launch +2–4 weeks | SEO pages: "Dropover for Windows", "send screenshot to phone", "drag screenshot into browser", "screenshot without saving" | One focused page each, with the demo GIF |

---

## 4. Post templates

**Product Hunt maker comment**
> Hi PH 👋 I'm Mayank. I kept filling my Desktop with screenshots I used once, then digging through file pickers to upload them, then WhatsApp-ing them to myself to see them on my phone.
>
> Hopshot fixes that: press a hotkey, grab part of the screen, and it lands on a small floating shelf. Drag it straight into Gmail/Slack/ChatGPT, or scan a QR code to open it on your phone. Everything disappears after 24 hours, and anything that goes online is end-to-end encrypted (the key never reaches our server).
>
> Try everything free for 7 days on Mac and Windows. Then it's $19 once ($15 this week). Add Sync ($24/year) and every capture lands on your phone automatically, and you can send photos back to your laptop.
>
> I'd love to hear where drag-and-drop *doesn't* work for you. That's the thing I'm testing hardest.

**Reddit (r/SideProject style)**
> **I built a tiny screenshot shelf for Windows & Mac: drag screenshots into any website, open them on your phone, they delete themselves after 24h**
>
> [GIF]
>
> Why: [one line about the Desktop clutter / upload dance]. Mac has Dropover/Yoink, but I couldn't find a clean equivalent on Windows, so I built one with Tauri (≈10 MB).
>
> What it does: … · What it doesn't do (on purpose): annotation, video, permanent hosting.
>
> 7-day free trial, then $19 once. There's an optional Sync subscription for phone and multi-computer sync. Happy to answer anything about how it works under the hood.

---

## 5. Launch-week metrics to watch (daily)

Visitors → downloads (by OS and channel) → activation (≥ 3 captures) → send-to-phone usage → trials started → Lifetime purchases → Sync add-ons → refunds → crash-free rate. Keep a simple spreadsheet; at day 7 and day 30, compare with PRD §10 and write down one lesson per channel.

## 6. Day-60 decision

See PRD §10: if organic sales are under 20 a month after the launch spike, switch to maintenance mode. If they're above that, build the P1 items users asked for most, and consider an OV certificate for direct Windows downloads.

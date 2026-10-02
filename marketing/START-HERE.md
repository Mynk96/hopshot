# Hopshot validation kit — start here

Goal: find out in 3 days, before writing any code, whether people will **pay** for Hopshot.

```
site/index.html      the landing page (nothing to install)
site/terms.html      pre-order terms (refund policy)
site/privacy.html    privacy policy
site/fonts/          self-hosted Inter + JetBrains Mono (open-source licences included)
site/og.png          preview image shown when the link is shared
assets/              demo video (mp4), GIF and still image for posts
POSTS.md             ready-to-post drafts for every channel, with schedule
tracker.csv          results sheet (open in Excel / Google Sheets)
```

Total setup time: about 45 minutes.

---

## Step 1 — Payment link (15 min)

Pick **one**.

### Option A: Stripe Payment Link (recommended)

**0. Account checks (Indian Stripe accounts)**
- International payments only work on a **registered business** account (company, LLP or sole proprietorship), not an individual one.
- **Settings → Business → Update details:** make sure **"I am exporting products to customers located outside India"** is ticked, and choose transaction purpose code **P0807 — Off-site software exports**.
- If the account belongs to BAS Technologies, add Hopshot as a product line: put `hopshot.xyz` in the business website/description so Stripe's review doesn't hold payouts.
- Payouts arrive in INR. International cards go through 3D Secure automatically.

**1. Public details and branding** (Settings)
- **Public details:** support email `founder@hopshot.xyz`, terms URL `https://hopshot.xyz/terms.html`, privacy URL `https://hopshot.xyz/privacy.html`, and a shortened statement descriptor such as `HOPSHOT`.
- **Branding:** upload the Hopshot icon and set the accent colour `#FF6B2C`.

**2. Products** — start in **test mode**. Product catalog → **Add product**, twice:
- `Hopshot — Lifetime + Sync (Founder pre-order)`: **$19.00 USD, one-off**. Description: `Lifetime license for Hopshot desktop software (Windows & macOS) plus 12 months of Sync. Ships November 2026. Full refund anytime before launch.`
- `Hopshot — Lifetime (Founder pre-order)`: **$12.00 USD, one-off**. Description: `Lifetime license for Hopshot desktop software (Windows & macOS). Ships November 2026. Full refund anytime before launch.`

**3. Payment Links → New**, once per product, with these options:
- **Collect customer names:** on, required. **Collect customer addresses:** billing address. *Required for Indian accounts: international payments without the buyer's name and billing address fail.*
- **Limit the number of payments:** 200.
- **Require customers to accept your terms of service:** on.
- **After payment → Don't show confirmation page → redirect** to `https://hopshot.xyz/?founder=1`.
- Optional: **Allow promotion codes**, for launch discounts or beta testers.

**4. Test:** pay once with test card `4242 4242 4242 4242` (any future date, any CVC). Check that you land back on the page with the green "You're in!" banner, and that the payment in the dashboard shows the name, address and client reference ID.

**5. Go live:** switch off test mode, recreate both products and links in live mode, and paste the two live links into `CONFIG` (Step 3).

**Tracking:** the page adds `client_reference_id=<channel>` to the checkout link, so every payment shows which post it came from.

### Option B: Razorpay Payment Page

- **International payments must be enabled** on your account (it's a request in the dashboard and can take a few days). Without it, only Indian buyers can pay, and the test won't tell you much.
- Create a Payment Page: $19 USD (or the ₹ equivalent), collect email, and redirect to `…/?founder=1` after payment if the option exists.
- Per-channel tracking isn't automatic. Compare when payments arrive with when you posted.

### About taxes

For these pre-orders, *you* are the seller, so GST/export invoicing and, strictly speaking, foreign digital-sales taxes are your responsibility. For a few dozen test sales, keep clean records and check with your CA (I'm not a tax advisor). For the real launch, a merchant of record such as Polar or Lemon Squeezy handles global tax for you, which is why the PRD uses Polar.

---

## Step 2 — Waitlist (5 min)

1. Create a free **Buttondown** account and note your username.
2. Your form address is `https://buttondown.com/api/emails/embed-subscribe/YOUR-USERNAME`
3. The page also sends three extra fields with each signup: `source` (which post), `wants_sync` (yes/blank) and `os` (windows/mac/both). They appear as subscriber metadata in Buttondown.

---

## Step 3 — Edit the CONFIG block (2 min)

Open `site/index.html` and find the **CONFIG** block near the bottom:

```js
const CONFIG = {
  checkoutSync: "https://buy.stripe.com/…",      // $19 Lifetime + Sync link (main offer)
  checkoutLifetime: "https://buy.stripe.com/…",  // $12 Lifetime link
  provider: "stripe",                             // or "razorpay"
  waitlistAction: "https://buttondown.com/api/emails/embed-subscribe/…",
  contactEmail: "founder@hopshot.xyz",
  founderName: "Mayank",                          // "" hides the founder note
  founderPhoto: ""                                // optional photo file, e.g. "me.jpg"
};
```

The contact address is already set to `founder@hopshot.xyz` everywhere (see Step 4 for forwarding it to your inbox).

Until the checkout links are set, the buy buttons scroll to the email signup, so nothing breaks if you deploy early.

---

## Step 4 — Deploy from GitHub (Cloudflare Pages)

1. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** (if it offers "Import a repository" for Workers, switch to the **Pages** tab).
2. Authorise GitHub for **only** the `hopshot` repo, then select it.
3. Build settings:
   - Production branch: `main`
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `marketing/site`
4. **Save and Deploy.** You get `https://hopshot.pages.dev`.
5. Project → **Custom domains** → add `hopshot.xyz` and `www.hopshot.xyz` (DNS records are created for you).
6. Project → **Metrics** → turn on **Web Analytics**.
7. From now on, every push to `main` that changes `marketing/site` redeploys the site. Other branches get preview URLs.

Menu names in Cloudflare/Stripe change from time to time. If something isn't where I said, tell me what you see.

---

## Step 5 — Post (3 days)

Follow `POSTS.md`. Every link carries `?ref=<channel>`, so signups and payments are tagged with where they came from. Post in the evening IST (US morning), and reply to every comment for the first 2 hours.

If you'd like, I can post from your browser while you watch and approve each post.

---

## Step 6 — Decide (day 4)

Fill in `tracker.csv` each evening (visits from Cloudflare, emails from Buttondown, payments from Stripe).

| After 3 days (assuming ~500+ visitors) | Decision |
|---|---|
| **10+ founder pre-orders** (either option) | **Build it.** Start Phase 0 of BUILD_PLAN.md. |
| 3–9 pre-orders, or 50+ waitlist emails | Unclear. Change the headline/demo, post in 2–3 new places, and run 4 more days. |
| Under 3 pre-orders and under 30 emails | **Don't build.** Refund anyone who paid, thank them, and move on with a month saved. |

Also note: how many buyers chose Lifetime + Sync ($19) vs Lifetime only ($12), what share of waitlist signups ticked "Sync" (does the subscription have demand?), and the Windows/Mac split (which platform to build first).

**If you stop the project,** refund every pre-order through Stripe/Razorpay and send one short email. Keeping that promise matters more than the money.

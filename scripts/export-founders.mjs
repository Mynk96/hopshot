// export-founders.mjs: list everyone who paid for a Hopshot founder pre-order on Stripe.
//
// Reads the paid Checkout Sessions of the two pre-order Payment Links and writes founders.csv:
//   email,name,plan,amount,currency,paid_at,session_id,payment_intent
// plan = "lifetime" ($12 link) or "bundle" ($19 link: Lifetime + 1 year of Sync from launch day).
// Fully refunded payments are skipped. On launch day, each row is imported with
// POST /v1/admin/licenses (ARCHITECTURE §7.5), which creates the license and emails the key.
//
// Run (Node 18+), with a restricted read-only key (read: Checkout Sessions, Payment Links,
// PaymentIntents, Charges):
//   STRIPE_KEY=rk_live_... node scripts/export-founders.mjs
// Never commit founders.csv (it is in .gitignore).

import { writeFileSync } from "node:fs";

const KEY = process.env.STRIPE_KEY;
if (!KEY) throw new Error("Set STRIPE_KEY (a restricted read-only key)");
const OUT = process.env.OUT || "founders.csv";

const LINKS = {
  lifetime: process.env.LINK_LIFETIME || "https://buy.stripe.com/eVqfZj9u6d94gyQdl1dby09", // $12
  bundle: process.env.LINK_BUNDLE || "https://buy.stripe.com/eVqbJ335Ied882kft9dby08",     // $19
};

async function get(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) [].concat(v).forEach((x) => qs.append(k, x));
  const res = await fetch(`https://api.stripe.com/v1/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function* all(path, params) {
  let starting_after;
  for (;;) {
    const page = await get(path, { limit: 100, ...params, ...(starting_after && { starting_after }) });
    yield* page.data;
    if (!page.has_more) return;
    starting_after = page.data.at(-1).id;
  }
}

// Map each Payment Link URL to its plink_ ID.
const ids = {};
for await (const pl of all("payment_links", {})) {
  for (const [plan, url] of Object.entries(LINKS)) if (pl.url === url) ids[plan] = pl.id;
}
for (const plan of Object.keys(LINKS)) if (!ids[plan]) throw new Error(`Payment Link not found for ${plan}: ${LINKS[plan]}`);

const csv = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
const rows = [["email", "name", "plan", "amount", "currency", "paid_at", "session_id", "payment_intent"]];
const seen = new Set();
let skipped = 0;

for (const [plan, plink] of Object.entries(ids)) {
  for await (const s of all("checkout/sessions", {
    payment_link: plink,
    status: "complete",
    "expand[]": "data.payment_intent.latest_charge",
  })) {
    if (s.payment_status !== "paid") continue;
    const charge = s.payment_intent?.latest_charge;
    if (charge?.refunded) { skipped++; continue; } // fully refunded
    const email = (s.customer_details?.email || "").toLowerCase();
    if (!email) continue;
    if (seen.has(`${email}|${plan}`)) console.warn(`note: ${email} bought ${plan} more than once`);
    seen.add(`${email}|${plan}`);
    rows.push([
      email,
      s.customer_details?.name || "",
      plan,
      (s.amount_total / 100).toFixed(2),
      s.currency,
      new Date(s.created * 1000).toISOString(),
      s.id,
      s.payment_intent?.id || "",
    ]);
  }
}

writeFileSync(OUT, rows.map((r) => r.map(csv).join(",")).join("\n") + "\n");
const count = (p) => rows.filter((r) => r[2] === p).length;
console.log(`${OUT}: ${rows.length - 1} founders (lifetime ${count("lifetime")}, bundle ${count("bundle")}); ${skipped} refunded skipped`);

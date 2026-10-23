// test-renewal-clock.mjs: prove the Sync renewal works a year from now, today.
//
// The opt-in renewal (PRD F8.8) has one failure mode you cannot find by reading the code: the
// card saved at purchase has to still be chargeable 365 days later, and the yearly price has
// to actually bill when the customer confirms. A Stripe **test clock** lets us fast-forward a
// simulated year in about a minute and watch what really happens.
//
// What it does, in test mode only:
//   1. creates a test clock at now
//   2. creates a customer frozen to that clock
//   3. charges $19 for the bundle with `setup_future_usage: off_session`, exactly as
//      createCheckout does — so the card is saved the same way
//   4. advances the clock 365 days
//   5. subscribes to STRIPE_PRICE_SYNC_YEARLY off-session, as the renewal Checkout would
//   6. reports whether the first invoice was actually paid
//   7. deletes the clock and everything attached to it
//
// Run with a **test-mode** secret key. Nothing here touches live data, and it refuses to run
// against a live key:
//
//   STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_SYNC_YEARLY=price_... node scripts/test-renewal-clock.mjs
//
// Add FAIL=1 to use Stripe's "card declines on renewal" test card instead, which is how you
// check the past_due path and the grace window:
//
//   FAIL=1 STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_SYNC_YEARLY=price_... node scripts/test-renewal-clock.mjs
//
// Keep the clock for inspection in the dashboard with KEEP=1.

const KEY = process.env.STRIPE_SECRET_KEY;
const PRICE = process.env.STRIPE_PRICE_SYNC_YEARLY;

if (!KEY) throw new Error("Set STRIPE_SECRET_KEY (a test-mode secret key)");
if (!KEY.startsWith("sk_test_") && !KEY.startsWith("rk_test_")) {
  // Advancing a clock creates real invoices on a real customer. This guard is the difference
  // between a simulation and charging someone.
  throw new Error("Refusing to run: STRIPE_SECRET_KEY is not a test-mode key");
}
if (!PRICE) throw new Error("Set STRIPE_PRICE_SYNC_YEARLY (the $24/year recurring price id)");

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const KEEP = process.env.KEEP === "1";

/*
 * `pm_card_*` tokens are Stripe's own test payment methods, not card numbers:
 *   visa                    — succeeds forever
 *   chargeCustomerFail      — attaches and charges once, then declines off-session, which is
 *                             exactly the "card died during the year" case the grace window
 *                             in limits.sync.paymentGraceDays exists for
 */
const PAYMENT_METHOD = process.env.FAIL === "1" ? "pm_card_chargeCustomerFail" : "pm_card_visa";

async function stripe(path, params, method = "POST") {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) body.append(key, String(value));
  }

  const url = `https://api.stripe.com/v1/${path}${method === "GET" && body.size ? `?${body}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : body,
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${json.error?.message ?? ""}`);
  }
  return json;
}

/** A clock advance is asynchronous; nothing may be read until it is `ready`. */
async function waitForClock(id) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const clock = await stripe(`test_helpers/test_clocks/${id}`, {}, "GET");
    if (clock.status === "ready") return clock;
    if (clock.status === "internal_failure") throw new Error("the test clock failed internally");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("the test clock did not settle in three minutes");
}

function date(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

let clockId;

try {
  const startedAt = Math.floor(Date.now() / 1000);

  const clock = await stripe("test_helpers/test_clocks", {
    frozen_time: startedAt,
    name: "Hopshot Sync renewal",
  });
  clockId = clock.id;
  console.log(`clock ${clockId} frozen at ${date(startedAt)}`);

  const customer = await stripe("customers", {
    email: `renewal-test+${startedAt}@hopshot.xyz`,
    test_clock: clockId,
  });

  // Attached before the charge so the PaymentIntent can be confirmed off-session, which is
  // what a completed Checkout leaves behind.
  const method = await stripe(`payment_methods/${PAYMENT_METHOD}/attach`, {
    customer: customer.id,
  });

  // Step 3: the $19 bundle, saving the card the way createCheckout does.
  const purchase = await stripe("payment_intents", {
    amount: 1900,
    currency: "usd",
    customer: customer.id,
    payment_method: method.id,
    setup_future_usage: "off_session",
    confirm: "true",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
  });
  console.log(`bundle charged: ${purchase.status} ($${purchase.amount / 100})`);

  if (purchase.status !== "succeeded") {
    throw new Error(`the purchase did not succeed: ${purchase.status}`);
  }

  // Step 4: a simulated year passes. This is the whole point — the card below is a year old.
  const renewalAt = startedAt + YEAR_SECONDS;
  console.log(`advancing to ${date(renewalAt)}…`);
  await stripe(`test_helpers/test_clocks/${clockId}/advance`, { frozen_time: renewalAt });
  await waitForClock(clockId);

  /*
   * Step 5: what `GET /license/renew/{token}` leads to. The renewal Checkout runs
   * mode=subscription against this same customer, so the saved card is what gets charged —
   * `off_session: true` makes Stripe treat it as a merchant-initiated payment, which is the
   * stricter test (3DS cannot be prompted, so a card that now needs it will decline).
   */
  const subscription = await stripe("subscriptions", {
    customer: customer.id,
    "items[0][price]": PRICE,
    default_payment_method: method.id,
    off_session: "true",
    "payment_behavior": "allow_incomplete",
    "expand[0]": "latest_invoice",
  });

  const invoice = subscription.latest_invoice;
  console.log(
    `subscription ${subscription.id}: ${subscription.status}` +
      (invoice ? ` · invoice ${invoice.status} ($${(invoice.amount_due ?? 0) / 100})` : ""),
  );

  // Step 6: the verdict. `active` + a paid invoice is the renewal working; `past_due` or
  // `incomplete` is the case the grace window and the dunning email have to cover.
  const paid = subscription.status === "active" && invoice?.status === "paid";

  if (paid) {
    console.log("\nPASS — the year-old card renewed Sync off-session.");
    console.log(`Next renewal would be ${date(subscription.current_period_end)}.`);
  } else {
    console.log(`\nThe renewal did not complete: subscription ${subscription.status}.`);
    if (process.env.FAIL === "1") {
      console.log("Expected with FAIL=1 — this is the past_due path.");
      console.log(
        "Your API should now receive invoice.payment_failed, start the grace window from it,",
      );
      console.log(
        `and keep Sync alive for paymentGraceDays before dropping to one computer.`,
      );
    } else {
      console.log("Investigate before launch: a declined renewal here is a declined renewal live.");
    }
  }

  console.log(`\nWebhook events to confirm arrived at your Worker, for clock ${clockId}:`);
  console.log("  customer.subscription.created   -> subscriptions row, status active");
  console.log("  invoice.paid                    -> past_due_since cleared");
  console.log("  invoice.payment_failed          -> past_due_since set (FAIL=1 only)");
  console.log(
    "Test clocks deliver real webhooks, so check the Worker's logs or the Stripe event log.",
  );
} finally {
  if (clockId && !KEEP) {
    // Deleting the clock deletes the customer, the charge and the subscription with it, so a
    // failed run leaves nothing behind in the test dashboard.
    await stripe(`test_helpers/test_clocks/${clockId}`, {}, "DELETE").catch((error) =>
      console.warn(`could not delete clock ${clockId}: ${error.message}`),
    );
    console.log(`\nclock ${clockId} deleted`);
  } else if (clockId) {
    console.log(`\nclock ${clockId} kept (KEEP=1) — delete it in the Stripe dashboard`);
  }
}

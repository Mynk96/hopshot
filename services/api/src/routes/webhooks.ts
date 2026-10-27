import { Hono } from "hono";

import { sendReceipt } from "../lib/email.ts";
import {
  fulfilClaim,
  isNewEvent,
  recordPurchase,
  revokeByPaymentIntent,
} from "../lib/license.ts";
import { verifyWebhook } from "../lib/stripe.ts";

/**
 * `POST /webhooks/stripe` (ARCHITECTURE §7.5).
 *
 * **The trust boundary for licensing.** A forged event here mints a licence, so the raw body
 * is signature-verified before it is parsed and anything is written. Every handler is
 * idempotent, because Stripe delivers at least once and retries for days.
 *
 * Always answers 200 once the signature is good, even if a handler fails — a non-2xx makes
 * Stripe retry, and a handler that fails deterministically would be retried forever. Failures
 * are logged instead.
 */
export const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post("/stripe", async (c) => {
  // The raw text, not a parsed body: the signature covers the exact bytes sent.
  const raw = await c.req.text();
  const event = await verifyWebhook(c.env, raw, c.req.header("Stripe-Signature") ?? null);

  // Deliberately vague: a prober must not learn whether it was the secret, the timestamp or
  // the digest that failed.
  if (!event) return c.json({ error: { code: "bad_request", message: "Invalid." } }, 400);

  // Recorded first and acted on only if the insert was new, so a redelivery is a no-op.
  if (!(await isNewEvent(c.env, event.id, event.type))) {
    return c.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await onCheckoutCompleted(c.env, event.data.object);
        break;

      // A refund or a dispute takes the licence away; without this a chargeback would
      // leave the app unlocked forever.
      case "charge.refunded":
        await onRefund(c.env, event.data.object, "refunded");
        break;
      case "charge.dispute.created":
        await onRefund(c.env, event.data.object, "revoked");
        break;

      default:
        // Everything else is recorded and ignored, which is what keeps the handler list
        // short rather than growing with Stripe's event catalogue.
        break;
    }
  } catch (error) {
    // Logged rather than returned: see the note above about retry storms.
    console.error(`stripe webhook ${event.type} failed`, error);
  }

  return c.json({ received: true });
});

type Session = {
  id?: string;
  customer?: string | null;
  payment_status?: string;
  payment_intent?: string | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  metadata?: Record<string, string> | null;
  /** Minor units, after any promotion code — i.e. what was actually charged. */
  amount_total?: number | null;
  currency?: string | null;
  /** Seconds, as everything in a Stripe object is. */
  created?: number | null;
};

async function onCheckoutCompleted(env: Env, object: Record<string, unknown>): Promise<void> {
  const session = object as Session;

  // `completed` can fire for an unpaid session (e.g. a delayed payment method). Only a paid
  // one may produce a licence.
  if (session.payment_status !== "paid") {
    console.log("checkout completed but not paid; no licence issued");
    return;
  }

  const email = session.customer_details?.email;
  const customerId = session.customer;
  const claim = session.metadata?.claim;
  const plan = session.metadata?.plan;

  if (!session.id || !customerId || !email || !claim) {
    console.warn("checkout session missing the fields needed to issue a licence");
    return;
  }
  if (plan !== "lifetime" && plan !== "bundle") {
    console.warn(`checkout session has an unknown plan: ${String(plan)}`);
    return;
  }

  const licenseId = await recordPurchase(env, {
    customerId,
    email,
    name: session.customer_details?.name ?? null,
    plan,
    sessionId: session.id,
    paymentIntentId: session.payment_intent ?? null,
  });

  // The app is polling this; marking it ready is what unlocks the app (PRD F8.3).
  await fulfilClaim(env, claim, licenseId);

  // After the claim, so a mail failure can never delay the unlock. The amount and date come
  // from the session rather than from `Date.now()`: a webhook Stripe retries for two days
  // must still produce a receipt that says when the payment happened.
  await sendReceipt(env, {
    email,
    plan,
    licenseId,
    name: session.customer_details?.name ?? null,
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? null,
    paidAt: typeof session.created === "number" ? session.created * 1000 : null,
  });

  console.log(`licence ${licenseId} issued (${plan})`);
}



async function onRefund(
  env: Env,
  object: Record<string, unknown>,
  reason: "refunded" | "revoked",
): Promise<void> {
  const charge = object as { payment_intent?: string | null };
  if (!charge.payment_intent) {
    console.warn(`${reason} event had no payment intent`);
    return;
  }

  const changed = await revokeByPaymentIntent(env, charge.payment_intent, reason);
  console.log(`${reason}: ${changed} licence(s) deactivated`);
}

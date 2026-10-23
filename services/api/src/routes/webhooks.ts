import { Hono } from "hono";

import { sendReceipt } from "../lib/email.ts";
import {
  fulfilClaim,
  isNewEvent,
  recordPurchase,
  revokeByPaymentIntent,
  upsertSubscription,
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
  const event = await verifyWebhook(
    c.env,
    raw,
    c.req.header("Stripe-Signature") ?? null,
  );

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

      /*
       * Sync subscriptions (PRD F8.8). All four land in one place because `syncActive` only
       * cares about the latest status, and Stripe does not guarantee delivery order — so the
       * upsert is keyed on the subscription id and the most recent write wins.
       */
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await onSubscription(c.env, event.data.object, event.type);
        break;

      // Recorded so `past_due` starts its grace window from the first failure.
      case "invoice.payment_failed":
      case "invoice.paid":
        await onInvoice(c.env, event.data.object);
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

  // After the claim, so a mail failure can never delay the unlock.
  await sendReceipt(env, email, plan, licenseId);

  console.log(`licence ${licenseId} issued (${plan})`);
}

type Subscription = {
  id?: string;
  customer?: string | null;
  status?: string;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  default_payment_method?: string | null;
};

async function onSubscription(
  env: Env,
  object: Record<string, unknown>,
  type: string,
): Promise<void> {
  const subscription = object as Subscription;
  if (!subscription.id || !subscription.customer) {
    console.warn("subscription event missing id or customer");
    return;
  }

  // A deletion is terminal whatever the object still says, so it is forced rather than
  // trusted: Stripe sends `canceled` here, but being explicit means a future status rename
  // cannot silently leave Sync switched on.
  const status = type === "customer.subscription.deleted" ? "canceled" : subscription.status;

  await upsertSubscription(env, {
    id: subscription.id,
    customerId: subscription.customer,
    status: status ?? "canceled",
    // Stripe sends seconds; everything in D1 is ms.
    currentPeriodEnd: subscription.current_period_end
      ? subscription.current_period_end * 1000
      : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
    hasPaymentMethod: Boolean(subscription.default_payment_method),
  });

  console.log(`subscription ${subscription.id} -> ${status ?? "canceled"}`);
}

async function onInvoice(env: Env, object: Record<string, unknown>): Promise<void> {
  const invoice = object as {
    subscription?: string | null;
    customer?: string | null;
    status?: string;
    period_end?: number | null;
  };

  // A one-off invoice has no subscription, and nothing here applies to it.
  if (!invoice.subscription || !invoice.customer) return;

  await upsertSubscription(env, {
    id: invoice.subscription,
    customerId: invoice.customer,
    status: invoice.status === "paid" ? "active" : "past_due",
    currentPeriodEnd: invoice.period_end ? invoice.period_end * 1000 : null,
  });
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

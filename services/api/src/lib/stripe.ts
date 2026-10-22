import { timingSafeEqual } from "./ids.ts";

/**
 * Stripe, over `fetch` (ARCHITECTURE §7.5).
 *
 * Deviates from §7.5's "stripe npm SDK": the only calls Hopshot makes are *create a Checkout
 * Session*, *read a session* and *open the billing portal*, plus webhook verification. Raw
 * `fetch` keeps a ~500 KB dependency out of a Worker that is otherwise 100 KB, and the
 * signature check needs WebCrypto either way.
 *
 * Nothing here logs a key, a signature or a customer email.
 */

const API = "https://api.stripe.com/v1";

/** Stripe signs with `t=…,v1=…`; anything older than this is refused (replay defence). */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "StripeError";
    this.status = status;
  }
}

function secretKey(env: Env): string {
  const key = (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY;
  if (!key) throw new StripeError(500, "Stripe is not configured.");
  return key;
}

/**
 * Form-encoded POST, which is the only body format the Stripe API accepts.
 *
 * Nested keys use Stripe's bracket syntax (`line_items[0][price]`), so params arrive
 * pre-flattened by the caller.
 */
async function post<T>(
  env: Env,
  path: string,
  params: Record<string, string>,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey(env)}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Stripe replays the first response for a repeated key, which makes a retried checkout
  // safe rather than a second charge.
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    // Stripe's message is safe to log — it describes the request, not the customer.
    const detail = safeMessage(text);
    console.warn(`stripe ${path} -> ${response.status}: ${detail}`);
    throw new StripeError(response.status, detail);
  }
  return JSON.parse(text) as T;
}

async function get<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${secretKey(env)}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new StripeError(response.status, safeMessage(text));
  }
  return JSON.parse(text) as T;
}

function safeMessage(body: string): string {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "unknown";
  } catch {
    return "unparsable Stripe response";
  }
}

/* ── Checkout (PRD F8.2) ──────────────────────────────────────────────────── */

export type CheckoutSession = {
  id: string;
  url: string;
  customer?: string | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  payment_intent?: string | null;
  payment_status?: string;
  metadata?: Record<string, string> | null;
};

/** Which thing is being bought. `bundle` is Lifetime plus the first year of Sync. */
export type Purchasable = "lifetime" | "bundle";

function priceId(env: Env, plan: Purchasable): string {
  const vars = env as { STRIPE_PRICE_LIFETIME?: string; STRIPE_PRICE_BUNDLE?: string };
  const id = plan === "lifetime" ? vars.STRIPE_PRICE_LIFETIME : vars.STRIPE_PRICE_BUNDLE;
  if (!id) throw new StripeError(500, "That plan is not configured yet.");
  return id;
}

/**
 * A Checkout Session for a one-time purchase.
 *
 * `claim` is carried in metadata so the webhook can match the completed payment back to the
 * install that started it — that is what lets the app unlock itself with no licence key for
 * the user to copy (PRD F8.3).
 *
 * Billing address is `required`: these are export payments from India, and the address is
 * needed on the invoice.
 */
export async function createCheckout(
  env: Env,
  plan: Purchasable,
  claim: string,
  origin: string,
): Promise<CheckoutSession> {
  return post<CheckoutSession>(
    env,
    "/checkout/sessions",
    {
      mode: "payment",
      "line_items[0][price]": priceId(env, plan),
      "line_items[0][quantity]": "1",
      // The app polls the claim, so the browser page is only a receipt.
      success_url: `${origin}/thanks?claim=${claim}`,
      cancel_url: `${origin}/pricing`,
      billing_address_collection: "required",
      "metadata[claim]": claim,
      "metadata[plan]": plan,
      // So a repeat purchase by the same person reuses one customer record.
      customer_creation: "always",
      allow_promotion_codes: "true",
    },
    // One claim is one intent to buy: a double-submit cannot become two charges.
    `checkout:${claim}`,
  );
}

export async function readCheckout(env: Env, sessionId: string): Promise<CheckoutSession> {
  return get<CheckoutSession>(env, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

/** The Stripe-hosted billing portal — "Manage Sync" (PRD F8.2). */
export async function billingPortal(
  env: Env,
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  return post<{ url: string }>(env, "/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
}

/* ── Webhook verification ─────────────────────────────────────────────────── */

export type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

/**
 * Verify `Stripe-Signature` and parse the event.
 *
 * **This is the trust boundary for the entire licensing system**: a forged event could mint
 * a licence. So the raw body is verified before it is parsed, the comparison is
 * timing-safe, and an old timestamp is refused even when the digest matches — otherwise a
 * captured webhook could be replayed forever.
 *
 * Returns `null` on any failure; the caller answers 400 without saying which check failed.
 */
export async function verifyWebhook(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
  now = Date.now(),
): Promise<StripeEvent | null> {
  const secret = (env as { STRIPE_WEBHOOK_SECRET?: string }).STRIPE_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return null;

  // `t=1699999999,v1=abc…,v1=def…` — more than one v1 during a secret rotation.
  const parts = signatureHeader.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");

  if (!timestamp || signatures.length === 0) return null;

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
    console.warn("stripe webhook rejected: timestamp outside tolerance");
    return null;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  if (!signatures.some((candidate) => timingSafeEqual(candidate, expected))) {
    console.warn("stripe webhook rejected: signature mismatch");
    return null;
  }

  try {
    return JSON.parse(rawBody) as StripeEvent;
  } catch {
    return null;
  }
}

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limits } from "shared";

import {
  claimDeviceSlot,
  createClaim,
  fulfilClaim,
  planForDeviceToken,
  recordPurchase,
  revokeByPaymentIntent,
} from "../src/lib/license.ts";
import { verifyWebhook } from "../src/lib/stripe.ts";
import { applyMigrations, captureEmail, freshId, resetEmail, send } from "./helpers.ts";

/**
 * Licensing (PRD F8, ARCHITECTURE §7.5).
 *
 * The webhook is the trust boundary for the whole system — a forged or replayed event mints
 * a licence — so it gets the most attention here. The rest covers the three ways a licence
 * can be wrong in a way that costs money: issued twice for one payment, kept after a refund,
 * or handed to a fourth computer.
 */

beforeEach(applyMigrations);

const SECRET = "whsec_test_secret";

/** Sign a body the way Stripe does, so the verifier can be exercised for real. */
async function sign(body: string, timestamp: number, secret = SECRET): Promise<string> {
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
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

/**
 * The secret comes from the test bindings in vitest.config.ts, so `env` already has it —
 * spreading a copy would only test a copy, not what the Worker actually reads.
 */
function withSecret(): Env {
  return env;
}

afterEach(() => {
  resetEmail();
});

describe("webhook signature verification", () => {
  const body = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: {} },
  });

  it("accepts a correctly signed event", async () => {
    const now = Date.now();
    const event = await verifyWebhook(
      withSecret(),
      body,
      await sign(body, Math.floor(now / 1000)),
      now,
    );

    expect(event).not.toBeNull();
    expect(event!.id).toBe("evt_1");
  });

  it("rejects a forged signature", async () => {
    const now = Date.now();
    const forged = `t=${Math.floor(now / 1000)},v1=${"0".repeat(64)}`;
    expect(await verifyWebhook(withSecret(), body, forged, now)).toBeNull();
  });

  it("rejects an event signed with the wrong secret", async () => {
    const now = Date.now();
    const header = await sign(body, Math.floor(now / 1000), "whsec_someone_elses");
    expect(await verifyWebhook(withSecret(), body, header, now)).toBeNull();
  });

  /** A captured webhook must not be replayable forever, even with a valid digest. */
  it("rejects a stale timestamp", async () => {
    const now = Date.now();
    const old = Math.floor(now / 1000) - 3600;
    expect(await verifyWebhook(withSecret(), body, await sign(body, old), now)).toBeNull();
  });

  it("rejects a body that was altered after signing", async () => {
    const now = Date.now();
    const header = await sign(body, Math.floor(now / 1000));
    const tampered = body.replace("evt_1", "evt_2");
    expect(await verifyWebhook(withSecret(), tampered, header, now)).toBeNull();
  });

  it("rejects everything when no secret is configured", async () => {
    const now = Date.now();
    const unconfigured = { ...env, STRIPE_WEBHOOK_SECRET: undefined } as unknown as Env;
    expect(
      await verifyWebhook(unconfigured, body, await sign(body, Math.floor(now / 1000)), now),
    ).toBeNull();
  });

  it("refuses an unsigned request", async () => {
    expect(await verifyWebhook(withSecret(), body, null)).toBeNull();
  });
});

describe("POST /v1/webhooks/stripe", () => {
  const session = {
    id: "cs_test_1",
    customer: "cus_1",
    payment_status: "paid",
    payment_intent: "pi_1",
    customer_details: { email: "buyer@example.com", name: "A Buyer" },
    metadata: { claim: "will-be-replaced", plan: "lifetime" },
  };

  async function deliver(claim: string, overrides: Record<string, unknown> = {}) {
    const body = JSON.stringify({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      type: "checkout.session.completed",
      data: { object: { ...session, metadata: { claim, plan: "lifetime" }, ...overrides } },
    });

    return send("/v1/webhooks/stripe", {
      method: "POST",
      headers: {
        "Stripe-Signature": await sign(body, Math.floor(Date.now() / 1000)),
        "Content-Type": "application/json",
      },
      body,
    });
  }

  it("refuses an unsigned delivery", async () => {
    const response = await send("/v1/webhooks/stripe", {
      method: "POST",
      body: JSON.stringify({
        id: "evt_x",
        type: "checkout.session.completed",
        data: { object: {} },
      }),
    });
    expect(response.status).toBe(400);
  });

  /** One payment, one licence, however many times Stripe delivers the event. */
  it("issues exactly one licence for a redelivered event", async () => {
    const claim = await createClaim(env, "install-1", "lifetime");

    // Same session id twice, as a retry would carry.
    expect((await deliver(claim)).status).toBe(200);
    expect((await deliver(claim)).status).toBe(200);

    const { results } = await env.DB.prepare("SELECT id FROM licenses").all();
    expect(results).toHaveLength(1);
  });

  it("does not issue a licence for an unpaid session", async () => {
    const claim = await createClaim(env, "install-1", "lifetime");
    await deliver(claim, { payment_status: "unpaid" });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM licenses").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  /**
   * A 100%-off promotion code: Stripe completes the session as `no_payment_required` with
   * nothing charged and no payment intent. It must still unlock the app, recorded as a comp.
   */
  it("issues a comp licence for a session a promotion code made free", async () => {
    const claim = await createClaim(env, "install-1", "lifetime");
    await deliver(claim, {
      payment_status: "no_payment_required",
      amount_total: 0,
      payment_intent: null,
    });

    const row = await env.DB.prepare("SELECT source, payment_intent_id FROM licenses").first<{
      source: string;
      payment_intent_id: string | null;
    }>();
    expect(row).toEqual({ source: "comp", payment_intent_id: null });
  });

  it("does not treat no_payment_required with money owing as a comp", async () => {
    const claim = await createClaim(env, "install-1", "lifetime");
    await deliver(claim, { payment_status: "no_payment_required", amount_total: 1900 });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM licenses").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("records an ordinary paid session as a checkout", async () => {
    const claim = await createClaim(env, "install-1", "lifetime");
    await deliver(claim);

    const row = await env.DB.prepare("SELECT source FROM licenses").first<{ source: string }>();
    expect(row!.source).toBe("checkout");
  });

  /**
   * PRD F8.3: the purchase email is the customer's receipt, so the amount and the date have
   * to be the payment's own — not whatever the clock said when a retried webhook landed.
   */
  it("mails a receipt carrying the amount, currency and date Stripe sent", async () => {
    const sent = captureEmail();
    const claim = await createClaim(env, "install-1", "lifetime");

    await deliver(claim, {
      amount_total: 1200,
      currency: "usd",
      created: Math.floor(Date.UTC(2026, 9, 23, 14, 11) / 1000),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("buyer@example.com");
    expect(sent[0]!.subject).toBe("Your Hopshot Lifetime receipt");
    expect(sent[0]!.text).toContain("$12.00");
    expect(sent[0]!.text).toContain("23 October 2026");
    // Both parts, so a plain-text client gets the same receipt.
    expect(sent[0]!.html).toContain("$12.00");
  });

  /** PRD F8.8: the bundle's year is stated on the receipt, with the fact that it stops. */
  it("tells a bundle buyer on the receipt when their Sync year ends", async () => {
    const sent = captureEmail();
    const claim = await createClaim(env, "install-1", "bundle");

    await deliver(claim, {
      metadata: { claim, plan: "bundle" },
      amount_total: 2900,
      currency: "usd",
      created: Math.floor(Date.UTC(2026, 9, 23, 14, 11) / 1000),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Your Hopshot Lifetime + Sync receipt");
    // 365 days on from the payment.
    expect(sent[0]!.text).toContain("23 October 2027");
    expect(sent[0]!.text).toContain("Nothing renews by itself");
  });

  /** One payment is one receipt, however many times Stripe redelivers the event. */
  it("does not mail a second receipt for a redelivered event", async () => {
    const sent = captureEmail();
    const claim = await createClaim(env, "install-1", "lifetime");

    await deliver(claim, { amount_total: 1200, currency: "usd" });
    await deliver(claim, { amount_total: 1200, currency: "usd" });

    expect(sent).toHaveLength(1);
  });
});

describe("the keyless unlock (PRD F8.3)", () => {
  it("a claim goes pending → ready → device token, and the token resolves to a plan", async () => {
    const claim = await createClaim(env, "install-1", "bundle");

    // Pending while the browser is still in Checkout.
    let response = await send(`/v1/license/claims/${claim}`, {
      headers: { "X-Hopshot-Install": "install-1" },
    });
    expect((await response.json<{ status: string }>()).status).toBe("pending");

    const licenseId = await recordPurchase(env, {
      customerId: "cus_1",
      email: "buyer@example.com",
      plan: "bundle",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    await fulfilClaim(env, claim, licenseId);

    response = await send(`/v1/license/claims/${claim}`, {
      headers: { "X-Hopshot-Install": "install-1" },
    });
    const ready = await response.json<{ status: string; deviceToken: string; plan: string }>();

    expect(ready.status).toBe("ready");
    // The bundle is Lifetime plus the first year of Sync.
    expect(ready.plan).toBe("sync");
    expect(ready.deviceToken).toHaveLength(43);

    // The token is only ever stored hashed.
    const row = await env.DB.prepare("SELECT token_hash FROM license_devices").first<{
      token_hash: string;
    }>();
    expect(row!.token_hash).not.toBe(ready.deviceToken);

    expect(await planForDeviceToken(env, ready.deviceToken)).toBe("sync");
  });

  it("an unknown or expired claim is a 404", async () => {
    const response = await send("/v1/license/claims/not-a-real-claim", {
      headers: { "X-Hopshot-Install": "install-1" },
    });
    expect(response.status).toBe(404);
  });
});

describe("the automatic 3-computer limit", () => {
  async function license(): Promise<string> {
    return recordPurchase(env, {
      customerId: "cus_1",
      email: "buyer@example.com",
      plan: "lifetime",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
  }

  it("allows the plan's computers and refuses one more", async () => {
    const id = await license();

    for (let n = 0; n < limits.lifetime.maxComputers; n++) {
      const slot = await claimDeviceSlot(env, id, `install-${n}`, `PC ${n}`);
      expect(slot.ok).toBe(true);
    }

    const fourth = await claimDeviceSlot(env, id, "install-extra", "One too many");
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      // The UI needs the list to offer "remove one to use it here".
      expect(fourth.computers).toHaveLength(limits.lifetime.maxComputers);
    }
  });

  /** Reinstalling on the same machine must not burn a second slot. */
  it("reuses a slot for the same install and rotates its token", async () => {
    const id = await license();

    const first = await claimDeviceSlot(env, id, "install-1", "PC");
    const again = await claimDeviceSlot(env, id, "install-1", "PC");

    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(again.deviceToken).not.toBe(first.deviceToken);
      // The old token stops working, so a copied token cannot outlive the machine.
      expect(await planForDeviceToken(env, first.deviceToken)).toBe("expired");
      expect(await planForDeviceToken(env, again.deviceToken)).toBe("lifetime");
    }

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM license_devices").first<{
      n: number;
    }>();
    expect(row!.n).toBe(1);
  });

  /** A machine nobody has used for the grace period frees its slot by itself. */
  it("reclaims a dormant slot instead of needing support", async () => {
    const id = await license();
    for (let n = 0; n < limits.lifetime.maxComputers; n++) {
      await claimDeviceSlot(env, id, `install-${n}`, `PC ${n}`);
    }

    const dormant = Date.now() - (limits.server.licenseOfflineGraceDays + 1) * 86_400_000;
    await env.DB.prepare(
      "UPDATE license_devices SET last_seen_at = ?1 WHERE install_id = 'install-0'",
    )
      .bind(dormant)
      .run();

    const fourth = await claimDeviceSlot(env, id, "install-extra", "A new PC");
    expect(fourth.ok).toBe(true);
  });
});

describe("refunds and disputes", () => {
  it("a refund takes the licence away", async () => {
    const id = await recordPurchase(env, {
      customerId: "cus_1",
      email: "buyer@example.com",
      plan: "lifetime",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const slot = await claimDeviceSlot(env, id, "install-1", "PC");
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;

    expect(await planForDeviceToken(env, slot.deviceToken)).toBe("lifetime");

    // Without this a chargeback would leave the app unlocked forever.
    expect(await revokeByPaymentIntent(env, "pi_1", "refunded")).toBe(1);
    expect(await planForDeviceToken(env, slot.deviceToken)).toBe("expired");
  });

  it("an unknown payment intent revokes nothing", async () => {
    expect(await revokeByPaymentIntent(env, "pi_nonexistent", "refunded")).toBe(0);
  });
});

describe("GET /v1/license/status", () => {
  it("needs a device token", async () => {
    expect((await send("/v1/license/status")).status).toBe(401);
  });

  it("reports expired for a token that was never issued", async () => {
    const response = await send("/v1/license/status", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect((await response.json<{ plan: string }>()).plan).toBe("expired");
  });
});

describe("the paywall actually holds (PRD F8.1)", () => {
  /**
   * The trial ending has to stop new sends. `limitsFor` maps an unrecognised plan onto the
   * Lifetime caps, so without an explicit gate an expired user kept ten free sends a day and
   * the paywall was decorative.
   */
  it("refuses a drop from an install that has never bought", async () => {
    const response = await send(`/v1/drops/${freshId()}?ttl=24h`, {
      method: "POST",
      headers: {
        "X-Hopshot-Install": "install-no-trial",
        "Content-Type": "application/octet-stream",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: new Uint8Array([0x48, 0x4f, 0x50, 0x31, 1]),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Buy Hopshot");
  });

  it("allows it again once a licence is presented", async () => {
    const licenseId = await recordPurchase(env, {
      customerId: "cus_1",
      email: "buyer@example.com",
      plan: "lifetime",
      sessionId: "cs_1",
      paymentIntentId: "pi_1",
    });
    const slot = await claimDeviceSlot(env, licenseId, "install-no-trial", "PC");
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;

    const response = await send(`/v1/drops/${freshId()}?ttl=24h`, {
      method: "POST",
      headers: {
        "X-Hopshot-Install": "install-no-trial",
        "X-Hopshot-License": slot.deviceToken,
        "Content-Type": "application/octet-stream",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: new Uint8Array([0x48, 0x4f, 0x50, 0x31, 1]),
    });

    expect(response.status).toBe(201);
  });
});

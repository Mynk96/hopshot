import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { limits } from "shared";

import { sha256Hex } from "../src/lib/ids.ts";
import {
  claimDeviceSlot,
  createRenewalToken,
  licenseById,
  periodKeyFor,
  recordPurchase,
  redeemRenewalToken,
  RENEWAL_NOTICE_DAYS,
  renewalsDue,
  syncActive,
  syncEndsAt,
  upsertSubscription,
} from "../src/lib/license.ts";
import { sendRenewalNotices } from "../src/lib/renewals.ts";
import { applyMigrations, runCron } from "./helpers.ts";

/**
 * Sync renewal (PRD F8.8).
 *
 * The bundle includes the first year of Sync, paid once. Around day 355 the customer is
 * *asked* whether to continue — **nothing renews itself**. That is the property most of these
 * tests exist to protect, because the failure mode is charging someone who never agreed.
 */

beforeEach(applyMigrations);

const YEAR_MS = 365 * 86_400_000;

async function bundle(createdAt: number, customer = "cus_renew"): Promise<string> {
  const id = await recordPurchase(env, {
    customerId: customer,
    email: `${customer}@example.com`,
    plan: "bundle",
    sessionId: `cs_${customer}_${Math.random()}`,
    paymentIntentId: `pi_${customer}`,
  });
  await env.DB.prepare("UPDATE licenses SET created_at = ?2 WHERE id = ?1")
    .bind(id, createdAt)
    .run();
  return id;
}

/*
 * Email is off by default here, which is what most of these tests want: `send` logs and returns
 * false, `once` rolls its row back, and nothing leaves the worker.
 *
 * The one test that needs delivery to succeed turns it on for itself and captures the request
 * instead of making it. `fetch` is stubbed rather than mocked through undici because
 * vitest-pool-workers 0.22 no longer exports `fetchMock`.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  const vars = env as unknown as Record<string, string | undefined>;
  delete vars.RESEND_API_KEY;
  delete vars.EMAIL_FROM;
});

/** Switch email on and capture what would have been sent. Returns the captured sends. */
function captureEmail(): Array<{ to: string; subject: string; text: string }> {
  const vars = env as unknown as Record<string, string | undefined>;
  vars.RESEND_API_KEY = "re_test_not_a_real_key";
  vars.EMAIL_FROM = "Hopshot <hello@hopshot.xyz>";

  const sent: Array<{ to: string; subject: string; text: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.resend.com")) {
      throw new Error(`unexpected outbound request to ${url}`);
    }
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "re_1" });
  });
  return sent;
}

describe("who gets asked", () => {
  it("finds a bundle whose year ends inside the notice window", async () => {
    const now = Date.now();
    // Year ends in 5 days, which is inside the 10-day window.
    await bundle(now - YEAR_MS + 5 * 86_400_000);

    const due = await renewalsDue(env, now);
    expect(due).toHaveLength(1);
    expect(due[0]!.email).toBe("cus_renew@example.com");
  });

  it("ignores a bundle whose year is still far off", async () => {
    const now = Date.now();
    await bundle(now - 30 * 86_400_000);

    expect(await renewalsDue(env, now)).toHaveLength(0);
  });

  it("ignores a bundle whose year has already passed", async () => {
    const now = Date.now();
    // Past the renewal date entirely — the notice window has closed.
    await bundle(now - YEAR_MS - 5 * 86_400_000);

    expect(await renewalsDue(env, now)).toHaveLength(0);
  });

  it("ignores a plain Lifetime licence", async () => {
    const now = Date.now();
    const id = await recordPurchase(env, {
      customerId: "cus_lifetime",
      email: "lifetime@example.com",
      plan: "lifetime",
      sessionId: "cs_lifetime",
      paymentIntentId: "pi_lifetime",
    });
    await env.DB.prepare("UPDATE licenses SET created_at = ?2 WHERE id = ?1")
      .bind(id, now - YEAR_MS + 5 * 86_400_000)
      .run();

    // There is nothing to renew: Lifetime never had Sync.
    expect(await renewalsDue(env, now)).toHaveLength(0);
  });

  /** Confirming once has to stop the asking. */
  it("ignores a bundle that already has a live subscription", async () => {
    const now = Date.now();
    await bundle(now - YEAR_MS + 5 * 86_400_000);

    await upsertSubscription(env, {
      id: "sub_1",
      customerId: "cus_renew",
      status: "active",
    });

    expect(await renewalsDue(env, now)).toHaveLength(0);
  });

  it("respects a customer who asked to stop hearing from us", async () => {
    const now = Date.now();
    await bundle(now - YEAR_MS + 5 * 86_400_000);

    await env.DB.prepare(
      "UPDATE customers SET reminders_off_at = ?1 WHERE stripe_customer_id = 'cus_renew'",
    )
      .bind(now)
      .run();

    expect(await renewalsDue(env, now)).toHaveLength(0);
  });

  it("ignores a refunded licence", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS + 5 * 86_400_000);
    await env.DB.prepare("UPDATE licenses SET status = 'refunded' WHERE id = ?1").bind(id).run();

    expect(await renewalsDue(env, now)).toHaveLength(0);
  });
});

describe("the daily cron", () => {
  it("sends exactly one notice however many times it runs", async () => {
    const now = Date.now();
    await bundle(now - YEAR_MS + 5 * 86_400_000);

    /*
     * Delivery has to actually succeed for this one: `once` deletes its own row when the send
     * fails, so with email switched off every run would mail again and the deduplication this
     * test is about would be invisible.
     */
    const sent = captureEmail();

    /*
     * The cron runs every day inside the 10-day window, so without per-year deduplication a
     * customer would get ten emails. `emails_sent` is what prevents that.
     */
    expect(await sendRenewalNotices(env, now)).toBe(1);
    expect(await sendRenewalNotices(env, now)).toBe(1);

    // The second run reports 1 because one notice is outstanding for the year — but it must not
    // have mailed again.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("cus_renew@example.com");
    // The copy is the promise the opt-in design makes; it must not read like an auto-renewal.
    expect(sent[0]!.text).toContain("Nothing will be charged");
    expect(sent[0]!.text).toContain("/v1/license/renew/");

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM emails_sent WHERE kind = 'sync_renewal'",
    ).first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it("keys the notice to the renewal year, so next year is a separate email", async () => {
    const thisYear = Date.UTC(2027, 5, 1);
    const nextYear = Date.UTC(2028, 5, 1);

    expect(periodKeyFor(thisYear)).toBe("2027");
    expect(periodKeyFor(nextYear)).toBe("2028");
    expect(periodKeyFor(thisYear)).not.toBe(periodKeyFor(nextYear));
  });

  it("runs from the scheduled handler on the daily trigger", async () => {
    const now = Date.now();
    await bundle(now - YEAR_MS + 5 * 86_400_000);

    await runCron("0 9 * * *");

    // Email delivery is not configured in tests, so `once` rolls its row back — what this
    // asserts is that the daily trigger reached the renewal path at all, which it proves by
    // having minted a token.
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM renewal_tokens",
    ).first<{ n: number }>();
    expect(row!.n).toBeGreaterThan(0);
  });

  it("is quiet when nobody is due", async () => {
    expect(await sendRenewalNotices(env, Date.now())).toBe(0);
  });
});

describe("the confirm link", () => {
  it("redeems once and refuses a replay", async () => {
    const id = await bundle(Date.now() - YEAR_MS + 5 * 86_400_000);
    const token = await createRenewalToken(env, id, "2027");

    const first = await redeemRenewalToken(env, token);
    expect(first).not.toBeNull();
    expect(first!.customerId).toBe("cus_renew");

    // A forwarded email must not be able to start a second checkout.
    expect(await redeemRenewalToken(env, token)).toBeNull();
  });

  it("refuses an expired token", async () => {
    const id = await bundle(Date.now() - YEAR_MS + 5 * 86_400_000);
    const token = await createRenewalToken(env, id, "2027");

    await env.DB.prepare("UPDATE renewal_tokens SET expires_at = ?1")
      .bind(Date.now() - 1000)
      .run();

    expect(await redeemRenewalToken(env, token)).toBeNull();
  });

  it("refuses an unknown token", async () => {
    expect(await redeemRenewalToken(env, "not-a-real-token")).toBeNull();
  });

  it("refuses a token whose licence was refunded in the meantime", async () => {
    const id = await bundle(Date.now() - YEAR_MS + 5 * 86_400_000);
    const token = await createRenewalToken(env, id, "2027");

    await env.DB.prepare("UPDATE licenses SET status = 'refunded' WHERE id = ?1").bind(id).run();

    expect(await redeemRenewalToken(env, token)).toBeNull();
  });

  it("stores only the hash, never the token", async () => {
    const id = await bundle(Date.now() - YEAR_MS + 5 * 86_400_000);
    const token = await createRenewalToken(env, id, "2027");

    const row = await env.DB.prepare("SELECT token_hash FROM renewal_tokens").first<{
      token_hash: string;
    }>();
    expect(row!.token_hash).toBe(await sha256Hex(token));
    expect(row!.token_hash).not.toBe(token);
  });
});

describe("what happens if nothing is confirmed", () => {
  /** The whole point of the opt-in design: silence costs the customer nothing. */
  it("Sync simply stops and the licence stays active", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS - 86_400_000);

    const license = (await licenseById(env, id))!;
    expect(license.status).toBe("active");
    // The year has passed with no subscription, so Sync is off.
    expect(await syncActive(env, license, now)).toBe(false);
  });

  it("the computer limit drops to Lifetime's", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS - 86_400_000);
    const slot = await claimDeviceSlot(env, id, "install-a", "PC A", now);

    expect(slot.ok).toBe(true);
    if (!slot.ok) return;

    // Lapsed Sync means one computer, not three.
    const second = await claimDeviceSlot(env, id, "install-b", "PC B", now);
    expect(second.ok).toBe(false);
    expect(limits.lifetime.maxComputers).toBe(1);
  });
});

describe("subscription state from Stripe", () => {
  it("turns Sync back on when a subscription arrives", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS - 86_400_000);
    const license = (await licenseById(env, id))!;

    expect(await syncActive(env, license, now)).toBe(false);

    await upsertSubscription(env, {
      id: "sub_1",
      customerId: license.customer_id,
      status: "active",
      currentPeriodEnd: now + YEAR_MS,
    });

    expect(await syncActive(env, license, now)).toBe(true);
  });

  /** Out-of-order delivery is normal: the latest write for an id has to win. */
  it("is idempotent and order-independent on the same subscription id", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS - 86_400_000);
    const license = (await licenseById(env, id))!;

    await upsertSubscription(env, { id: "sub_1", customerId: license.customer_id, status: "active" });
    await upsertSubscription(env, { id: "sub_1", customerId: license.customer_id, status: "canceled" });

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{
      n: number;
    }>();
    expect(rows!.n).toBe(1);
    expect(await syncActive(env, license, now)).toBe(false);
  });

  /**
   * The grace window has to be measured from the *first* failure, not the latest webhook, or
   * a subscription that keeps retrying would never run out of grace.
   */
  it("keeps past_due_since from the first failure across repeated events", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS - 86_400_000);
    const license = (await licenseById(env, id))!;

    const firstFailure = now - 5 * 86_400_000;
    await upsertSubscription(
      env,
      { id: "sub_1", customerId: license.customer_id, status: "past_due" },
      firstFailure,
    );

    // A retry three days later must not reset the clock.
    await upsertSubscription(
      env,
      { id: "sub_1", customerId: license.customer_id, status: "past_due" },
      now,
    );

    const row = await env.DB.prepare(
      "SELECT past_due_since FROM subscriptions WHERE stripe_subscription_id = 'sub_1'",
    ).first<{ past_due_since: number }>();
    expect(row!.past_due_since).toBe(firstFailure);

    // Still inside the grace period, so Sync is alive.
    expect(await syncActive(env, license, now)).toBe(true);

    // And past it, Sync is off.
    const afterGrace = firstFailure + (limits.sync.paymentGraceDays + 1) * 86_400_000;
    expect(await syncActive(env, license, afterGrace)).toBe(false);
  });

  it("clears past_due_since once a payment succeeds", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS - 86_400_000);
    const license = (await licenseById(env, id))!;

    await upsertSubscription(env, { id: "sub_1", customerId: license.customer_id, status: "past_due" });
    await upsertSubscription(env, { id: "sub_1", customerId: license.customer_id, status: "active" });

    const row = await env.DB.prepare(
      "SELECT past_due_since FROM subscriptions WHERE stripe_subscription_id = 'sub_1'",
    ).first<{ past_due_since: number | null }>();
    expect(row!.past_due_since).toBeNull();
  });
});

describe("the date Settings shows", () => {
  it("is the end of the included year for a fresh bundle", async () => {
    const now = Date.now();
    const createdAt = now - 30 * 86_400_000;
    const id = await bundle(createdAt);
    const license = (await licenseById(env, id))!;

    expect(await syncEndsAt(env, license, now)).toBe(createdAt + YEAR_MS);
  });

  it("is null once Sync is off, so the pane shows nothing rather than a past date", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS - 86_400_000);
    const license = (await licenseById(env, id))!;

    expect(await syncEndsAt(env, license, now)).toBeNull();
  });

  /** Renewing early must not shorten what the customer sees. */
  it("takes the later date when a renewal overlaps the included year", async () => {
    const now = Date.now();
    const createdAt = now - 360 * 86_400_000;
    const id = await bundle(createdAt);
    const license = (await licenseById(env, id))!;

    const periodEnd = createdAt + 2 * YEAR_MS;
    await upsertSubscription(env, {
      id: "sub_1",
      customerId: license.customer_id,
      status: "active",
      currentPeriodEnd: periodEnd,
    });

    expect(await syncEndsAt(env, license, now)).toBe(periodEnd);
  });

  it("is when the grace runs out while a payment is failing", async () => {
    const now = Date.now();
    const id = await bundle(now - YEAR_MS - 86_400_000);
    const license = (await licenseById(env, id))!;

    const firstFailure = now - 86_400_000;
    await upsertSubscription(
      env,
      {
        id: "sub_1",
        customerId: license.customer_id,
        status: "past_due",
        // The period has already ended; the honest date is the end of grace, not this.
        currentPeriodEnd: now - 86_400_000,
      },
      firstFailure,
    );

    expect(await syncEndsAt(env, license, now)).toBe(
      firstFailure + limits.sync.paymentGraceDays * 86_400_000,
    );
  });
});

describe("the notice window", () => {
  it("matches the documented ten days", () => {
    // The email says "ends soon" and the cron runs daily, so the window and the copy have to
    // agree; this pins the number the tests above assume.
    expect(RENEWAL_NOTICE_DAYS).toBe(10);
  });
});

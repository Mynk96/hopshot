import { limits } from "shared";
import type { PlanName } from "shared";

import { newToken, sha256Hex } from "./ids.ts";

/**
 * Licences, device slots and plan resolution (ARCHITECTURE §7.5, PRD F8).
 *
 * **There is no licence key.** A purchase belongs to the checkout email, and the app unlocks
 * itself by polling the `claim` it created before opening Checkout (F8.3). What the app
 * stores is a *device token* — one row in `license_devices` — which is what the computer
 * limit counts: one on Lifetime, three while Sync is active (PRD F8.3).
 *
 * Tokens are only ever stored hashed, like every other credential here, so a database dump
 * cannot be replayed against the API.
 */

/** A claim is short-lived: it only has to outlive a checkout the user is actively doing. */
export const CLAIM_TTL_MS = 60 * 60 * 1000;
/** Restore codes are emailed, so they get a tighter window and an attempt cap. */
export const RESTORE_TTL_MS = 15 * 60 * 1000;
export const RESTORE_MAX_ATTEMPTS = 5;

export type LicenseRow = {
  id: string;
  customer_id: string;
  plan: "lifetime" | "bundle";
  status: "active" | "refunded" | "revoked";
  created_at: number;
};

/* ── Plan resolution ──────────────────────────────────────────────────────── */

/**
 * What a device token entitles the caller to.
 *
 * Read from D1 only — never an external call (ARCHITECTURE §7.5), so a Stripe outage cannot
 * lock out paying users.
 *
 * A refunded or revoked licence resolves to `expired`, which is what makes a chargeback
 * actually take the app away rather than leaving it unlocked forever.
 */
export async function planForDeviceToken(
  env: Env,
  token: string,
  now = Date.now(),
): Promise<PlanName> {
  const row = await env.DB.prepare(
    `SELECT l.plan AS plan, l.status AS status, d.removed_at AS removed_at
       FROM license_devices d
       JOIN licenses l ON l.id = d.license_id
      WHERE d.token_hash = ?1`,
  )
    .bind(await sha256Hex(token))
    .first<{ plan: "lifetime" | "bundle"; status: string; removed_at: number | null }>();

  if (!row || row.removed_at !== null || row.status !== "active") return "expired";

  /*
   * Only a device inside the limit keeps its slot warm. Touching unconditionally would make
   * whichever device polled last the "most recently seen" one, so the over-limit set would
   * flip on every poll instead of settling — and an over-limit machine would keep stealing
   * the licence back from the one the user actually chose.
   */
  const status = await deviceStatus(env, token, now);
  if (!status.valid) return "expired";

  await touchDevice(env, token, now);

  // `deviceStatus` has already worked out whether Sync is live, so a bundle whose year has
  // lapsed correctly reports `lifetime` rather than keeping Sync forever.
  return status.plan;
}

async function touchDevice(env: Env, token: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE license_devices SET last_seen_at = ?2 WHERE token_hash = ?1")
    .bind(await sha256Hex(token), now)
    .run();
}

/* ── Claims: the keyless unlock (PRD F8.3) ───────────────────────────────── */

/**
 * Start a purchase. Returns the claim id the app will poll.
 *
 * Stored hashed: the claim id travels in a `success_url` and so ends up in browser history
 * and possibly a referrer, and it is the thing that hands over a device token.
 */
export async function createClaim(
  env: Env,
  installId: string,
  plan: "lifetime" | "bundle",
  now = Date.now(),
): Promise<string> {
  const claim = newToken();

  await env.DB.prepare(
    `INSERT INTO claims (id_hash, kind, install_id, plan, status, created_at, expires_at)
     VALUES (?1, 'purchase', ?2, ?3, 'pending', ?4, ?5)`,
  )
    .bind(await sha256Hex(claim), installId, plan, now, now + CLAIM_TTL_MS)
    .run();

  return claim;
}

/**
 * Attach a completed purchase to its claim, so the polling app can collect a device token.
 *
 * Idempotent on the licence: the webhook can be delivered more than once, and a second
 * delivery must not create a second licence or a second device slot.
 */
export async function fulfilClaim(
  env: Env,
  claim: string,
  licenseId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `UPDATE claims SET status = 'ready', license_id = ?2, delivered_at = ?3
       WHERE id_hash = ?1 AND status = 'pending'`,
  )
    .bind(await sha256Hex(claim), licenseId, now)
    .run();
}

export type ClaimState =
  | { state: "pending" }
  | { state: "ready"; licenseId: string }
  | { state: "unknown" };

export async function readClaim(
  env: Env,
  claim: string,
  now = Date.now(),
): Promise<ClaimState> {
  const row = await env.DB.prepare(
    "SELECT status, license_id, expires_at FROM claims WHERE id_hash = ?1",
  )
    .bind(await sha256Hex(claim))
    .first<{ status: string; license_id: string | null; expires_at: number }>();

  if (!row || row.expires_at <= now) return { state: "unknown" };
  if (row.status === "ready" && row.license_id) {
    return { state: "ready", licenseId: row.license_id };
  }
  return { state: "pending" };
}

/* ── The computer limit (PRD F8.3, ARCHITECTURE §7.5) ────────────────────── */

/** A year of Sync comes with the bundle, paid once (PRD §7). */
export const BUNDLE_SYNC_MS = 365 * 86_400_000;

/**
 * Is Sync currently active for this licence?
 *
 * Two ways it can be, and both are needed:
 *
 * 1. A `subscriptions` row that is `trialing`/`active`, or `past_due` but still inside
 *    `paymentGraceDays` — a failed card should not take someone's computers away the same
 *    afternoon.
 * 2. A `bundle` licence inside its first year. The bundle *is* "Lifetime plus the first year
 *    of Sync, paid once", and no subscription exists until the buyer adds a card, so without
 *    this every bundle buyer would be capped at one computer from day one.
 */
export async function syncActive(
  env: Env,
  license: Pick<LicenseRow, "customer_id" | "plan" | "created_at">,
  now = Date.now(),
): Promise<boolean> {
  if (license.plan === "bundle" && now < license.created_at + BUNDLE_SYNC_MS) {
    return true;
  }

  const row = await env.DB.prepare(
    `SELECT status, past_due_since FROM subscriptions
      WHERE customer_id = ?1
      ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(license.customer_id)
    .first<{ status: string; past_due_since: number | null }>();

  if (!row) return false;
  if (row.status === "trialing" || row.status === "active") return true;

  if (row.status === "past_due") {
    const grace = limits.sync.paymentGraceDays * 86_400_000;
    // A null `past_due_since` means we do not know when it started; treat it as just now
    // rather than as expired, so a data gap favours the customer.
    return now < (row.past_due_since ?? now) + grace;
  }

  return false;
}

/**
 * When Sync currently runs out, or null if it is not active.
 *
 * Takes the later of the two sources rather than the first that matches: someone who renews
 * early holds a subscription *and* is still inside the bundle year, and the date shown has to
 * be the one they actually keep.
 */
export async function syncEndsAt(
  env: Env,
  license: Pick<LicenseRow, "customer_id" | "plan" | "created_at">,
  now = Date.now(),
): Promise<number | null> {
  const dates: number[] = [];

  if (license.plan === "bundle" && now < license.created_at + BUNDLE_SYNC_MS) {
    dates.push(license.created_at + BUNDLE_SYNC_MS);
  }

  const row = await env.DB.prepare(
    `SELECT status, current_period_end, past_due_since FROM subscriptions
      WHERE customer_id = ?1
      ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(license.customer_id)
    .first<{
      status: string;
      current_period_end: number | null;
      past_due_since: number | null;
    }>();

  if (row && (row.status === "trialing" || row.status === "active")) {
    if (row.current_period_end) dates.push(row.current_period_end);
  } else if (row?.status === "past_due") {
    // Inside the grace window the honest answer is when the grace runs out, not when the
    // period ended — that is the date the computers actually stop.
    const grace = limits.sync.paymentGraceDays * 86_400_000;
    dates.push((row.past_due_since ?? now) + grace);
  }

  const latest = dates.filter((date) => date > now);
  return latest.length > 0 ? Math.max(...latest) : null;
}

/**
 * How many computers this licence may run on (PRD F8.3).
 *
 * Three with Sync, one without. `vaultLimitsFor` in `plan.ts` derives the same two numbers
 * straight from `limits.json` by plan name — they have to agree, and the
 * `the_two_limit_paths_agree` test pins that.
 */
export async function computerLimit(
  env: Env,
  license: Pick<LicenseRow, "customer_id" | "plan" | "created_at">,
  now = Date.now(),
): Promise<number> {
  return (await syncActive(env, license, now))
    ? limits.sync.maxComputers
    : limits.lifetime.maxComputers;
}

/** Load a licence by id, or `null`. */
export async function licenseById(env: Env, id: string): Promise<LicenseRow | null> {
  return env.DB.prepare(
    "SELECT id, customer_id, plan, status, created_at FROM licenses WHERE id = ?1",
  )
    .bind(id)
    .first<LicenseRow>();
}

export type DeviceRow = {
  id: string;
  install_id: string;
  label: string | null;
  last_seen_at: number;
};

/** What `GET /license/status` answers. */
export type DeviceStatus =
  | {
      valid: true;
      plan: PlanName;
      licenseId: string;
      deviceId: string;
      limit: number;
      syncActive: boolean;
      /**
       * When Sync lapses if nothing is renewed, or null when it is already off.
       *
       * Settings shows this as "Sync until <date>" — the app has no other way to know, and a
       * date the customer can see is what makes the opt-in renewal honest rather than a
       * surprise when their phone stops pairing.
       */
      syncEndsAt: number | null;
    }
  | {
      valid: false;
      reason: "unknown" | "revoked" | "over_limit";
      plan: PlanName;
      licenseId?: string;
      deviceId?: string;
      limit?: number;
      /** The other computers, most recently seen first, for the DESIGN S9 chooser. */
      devices?: { id: string; label: string; lastSeenAt: number; isSelf: boolean }[];
    };

/**
 * Whether this device may currently run, and why not if it may not (PRD F8.3).
 *
 * When the limit drops — a bundle's Sync year ends, or a subscription lapses — the licence
 * can legitimately have more slots than it is now allowed. Rather than picking a victim at
 * random or locking everybody out, the **most recently seen** devices up to the limit stay
 * valid and the rest are told `over_limit` with the list, so the user chooses where it runs.
 */
export async function deviceStatus(
  env: Env,
  token: string,
  now = Date.now(),
): Promise<DeviceStatus> {
  const row = await env.DB.prepare(
    `SELECT d.id AS device_id, d.license_id AS license_id, d.removed_at AS removed_at,
            l.customer_id AS customer_id, l.plan AS plan, l.status AS status,
            l.created_at AS created_at
       FROM license_devices d
       JOIN licenses l ON l.id = d.license_id
      WHERE d.token_hash = ?1`,
  )
    .bind(await sha256Hex(token))
    .first<{
      device_id: string;
      license_id: string;
      removed_at: number | null;
      customer_id: string;
      plan: "lifetime" | "bundle";
      status: string;
      created_at: number;
    }>();

  if (!row) return { valid: false, reason: "unknown", plan: "expired" };

  // Removed here or refunded upstream: both mean this machine stops working.
  if (row.removed_at !== null || row.status !== "active") {
    return { valid: false, reason: "revoked", plan: "expired" };
  }

  const license = {
    customer_id: row.customer_id,
    plan: row.plan,
    created_at: row.created_at,
  };
  const sync = await syncActive(env, license, now);
  const limit = sync ? limits.sync.maxComputers : limits.lifetime.maxComputers;
  const plan: PlanName = sync ? "sync" : "lifetime";

  const devices = await devicesOn(env, row.license_id);
  const allowed = devices.slice(0, limit).map((device) => device.id);

  if (!allowed.includes(row.device_id)) {
    return {
      valid: false,
      reason: "over_limit",
      plan,
      licenseId: row.license_id,
      deviceId: row.device_id,
      limit,
      devices: devices.map((device) => ({
        id: device.id,
        label: device.label ?? "A computer",
        lastSeenAt: device.last_seen_at,
        isSelf: device.id === row.device_id,
      })),
    };
  }

  return {
    valid: true,
    plan,
    licenseId: row.license_id,
    deviceId: row.device_id,
    limit,
    syncActive: sync,
    syncEndsAt: sync ? await syncEndsAt(env, license, now) : null,
  };
}

/**
 * "Move it here" — free another computer's slot and keep this one (DESIGN S9).
 *
 * The caller proves it owns a slot on the licence by presenting its own device token, so one
 * licence holder cannot evict a stranger's machine.
 */
export async function moveHere(
  env: Env,
  token: string,
  releaseDeviceId: string,
  now = Date.now(),
): Promise<{ ok: boolean; reason?: string }> {
  const mine = await env.DB.prepare(
    `SELECT id, license_id FROM license_devices
      WHERE token_hash = ?1 AND removed_at IS NULL`,
  )
    .bind(await sha256Hex(token))
    .first<{ id: string; license_id: string }>();

  if (!mine) return { ok: false, reason: "unknown" };
  if (mine.id === releaseDeviceId) return { ok: false, reason: "same_device" };

  const target = await env.DB.prepare(
    `SELECT id FROM license_devices
      WHERE id = ?1 AND license_id = ?2 AND removed_at IS NULL`,
  )
    .bind(releaseDeviceId, mine.license_id)
    .first<{ id: string }>();

  if (!target) return { ok: false, reason: "not_found" };

  await env.DB.batch([
    env.DB.prepare("UPDATE license_devices SET removed_at = ?2 WHERE id = ?1").bind(
      releaseDeviceId,
      now,
    ),
    // Freshening this one is what makes it the most recently seen, so the very next status
    // check sees it inside the limit.
    env.DB.prepare("UPDATE license_devices SET last_seen_at = ?2 WHERE id = ?1").bind(
      mine.id,
      now,
    ),
  ]);

  return { ok: true };
}

/** Active slots on a licence, most recently seen first. */
export async function devicesOn(env: Env, licenseId: string): Promise<DeviceRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, install_id, label, last_seen_at FROM license_devices
       WHERE license_id = ?1 AND removed_at IS NULL
       ORDER BY last_seen_at DESC`,
  )
    .bind(licenseId)
    .all<DeviceRow>();

  return results ?? [];
}

/* ── Device slots: the automatic computer limit (PRD F8.3) ────────────────── */

export type SlotResult =
  | { ok: true; deviceToken: string; plan: PlanName }
  | { ok: false; reason: "full"; computers: { id: string; label: string; lastSeenAt: number }[] };

/**
 * Give this install a device slot on a licence.
 *
 * Reuses the install's existing slot when it has one, so reinstalling on the same machine
 * does not burn a second of the three. A slot not seen for 30 days is reclaimed
 * automatically, which is what makes the limit "automatic" rather than a support ticket.
 */
export async function claimDeviceSlot(
  env: Env,
  licenseId: string,
  installId: string,
  label: string,
  now = Date.now(),
): Promise<SlotResult> {
  const license = await licenseById(env, licenseId);

  if (!license || license.status !== "active") {
    return { ok: false, reason: "full", computers: [] };
  }

  // PRD F8.3: one computer on Lifetime, three while Sync is active.
  const limit = await computerLimit(env, license, now);

  const plan: PlanName = license.plan === "bundle" ? "sync" : "lifetime";

  // Same machine coming back: rotate its token rather than taking another slot.
  const existing = await env.DB.prepare(
    "SELECT id FROM license_devices WHERE license_id = ?1 AND install_id = ?2",
  )
    .bind(licenseId, installId)
    .first<{ id: string }>();

  const deviceToken = newToken();

  if (existing) {
    await env.DB.prepare(
      `UPDATE license_devices
          SET token_hash = ?2, label = ?3, last_seen_at = ?4, removed_at = NULL
        WHERE id = ?1`,
    )
      .bind(existing.id, await sha256Hex(deviceToken), label, now)
      .run();
    return { ok: true, deviceToken, plan };
  }

  // Reclaim anything dormant before counting, so the cap reflects machines in use.
  const stale = now - limits.server.licenseOfflineGraceDays * 86_400_000;
  await env.DB.prepare(
    `UPDATE license_devices SET removed_at = ?3
       WHERE license_id = ?1 AND removed_at IS NULL AND last_seen_at < ?2`,
  )
    .bind(licenseId, stale, now)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT id, label, last_seen_at FROM license_devices
       WHERE license_id = ?1 AND removed_at IS NULL
       ORDER BY last_seen_at ASC`,
  )
    .bind(licenseId)
    .all<{ id: string; label: string | null; last_seen_at: number }>();

  if (results.length >= limit) {
    // PRD: "Hopshot is on N computers. Remove one to use it here." — the UI needs the list.
    return {
      ok: false,
      reason: "full",
      computers: results.map((row) => ({
        id: row.id,
        label: row.label ?? "A computer",
        lastSeenAt: row.last_seen_at,
      })),
    };
  }

  await env.DB.prepare(
    `INSERT INTO license_devices (id, license_id, install_id, label, token_hash,
                                  created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(
      crypto.randomUUID().replace(/-/g, "").slice(0, 22),
      licenseId,
      installId,
      label,
      await sha256Hex(deviceToken),
      now,
    )
    .run();

  return { ok: true, deviceToken, plan };
}

/** Free a slot so a fourth computer can take it (PRD F8, the plans sheet). */
export async function removeDevice(
  env: Env,
  licenseId: string,
  deviceId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    "UPDATE license_devices SET removed_at = ?3 WHERE license_id = ?1 AND id = ?2",
  )
    .bind(licenseId, deviceId, now)
    .run();
}

/* ── Sync renewal (PRD F8.8) ──────────────────────────────────────────────── */

/** How far before the year ends the notice goes out. */
export const RENEWAL_NOTICE_DAYS = 10;
/** A renewal token has to outlive the notice comfortably without living forever. */
export const RENEWAL_TOKEN_TTL_MS = 30 * 86_400_000;

/** `2027` — the year the renewal falls in, so next year's notice is a separate row. */
export function periodKeyFor(renewalAt: number): string {
  return String(new Date(renewalAt).getUTCFullYear());
}

export type DueRenewal = {
  licenseId: string;
  customerId: string;
  email: string;
  renewalAt: number;
};

/**
 * Bundles whose included Sync year is about to end and which have no live subscription.
 *
 * Nothing renews itself (PRD F8.8): this only finds who should be *asked*. A licence that
 * already has a subscription is skipped, so confirming once stops the notices.
 */
export async function renewalsDue(env: Env, now = Date.now()): Promise<DueRenewal[]> {
  const windowOpens = now + RENEWAL_NOTICE_DAYS * 86_400_000;

  const { results } = await env.DB.prepare(
    `SELECT l.id AS license_id, l.customer_id AS customer_id, c.email AS email,
            l.created_at AS created_at
       FROM licenses l
       JOIN customers c ON c.stripe_customer_id = l.customer_id
      WHERE l.plan = 'bundle'
        AND l.status = 'active'
        -- The included year ends inside the notice window.
        AND l.created_at + ?1 <= ?2
        AND l.created_at + ?1 > ?3
        -- Already renewed, so there is nothing to ask about.
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions s
           WHERE s.customer_id = l.customer_id
             AND s.status IN ('trialing', 'active', 'past_due')
        )
        -- Asked to stop hearing from us.
        AND c.reminders_off_at IS NULL`,
  )
    .bind(BUNDLE_SYNC_MS, windowOpens, now)
    .all<{ license_id: string; customer_id: string; email: string; created_at: number }>();

  return (results ?? []).map((row) => ({
    licenseId: row.license_id,
    customerId: row.customer_id,
    email: row.email,
    renewalAt: row.created_at + BUNDLE_SYNC_MS,
  }));
}

/** Mint the one-time token that the renewal email links to. */
export async function createRenewalToken(
  env: Env,
  licenseId: string,
  periodKey: string,
  now = Date.now(),
): Promise<string> {
  const token = newToken();

  await env.DB.prepare(
    `INSERT INTO renewal_tokens (token_hash, license_id, period_key, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(await sha256Hex(token), licenseId, periodKey, now, now + RENEWAL_TOKEN_TTL_MS)
    .run();

  return token;
}

export type RenewalToken = { licenseId: string; customerId: string };

/**
 * Redeem a renewal token.
 *
 * Burned with a conditional UPDATE so a forwarded email cannot start two checkouts, and the
 * licence is read in the same breath so the caller never has to trust an id from the URL.
 */
export async function redeemRenewalToken(
  env: Env,
  token: string,
  now = Date.now(),
): Promise<RenewalToken | null> {
  const row = await env.DB.prepare(
    `UPDATE renewal_tokens SET used_at = ?2
       WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2
       RETURNING license_id`,
  )
    .bind(await sha256Hex(token), now)
    .first<{ license_id: string }>();

  if (!row) return null;

  const license = await licenseById(env, row.license_id);
  if (!license || license.status !== "active") return null;

  return { licenseId: license.id, customerId: license.customer_id };
}

/**
 * Record what Stripe says about a subscription.
 *
 * Keyed on the subscription id, so the create and update events can arrive in any order and
 * the latest one wins — Stripe does not guarantee delivery order.
 */
export async function upsertSubscription(
  env: Env,
  input: {
    id: string;
    customerId: string;
    status: string;
    currentPeriodEnd?: number | null;
    cancelAtPeriodEnd?: boolean;
    hasPaymentMethod?: boolean;
  },
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscriptions (stripe_subscription_id, customer_id, status,
                                current_period_end, past_due_since, cancel_at_period_end,
                                has_payment_method, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(stripe_subscription_id) DO UPDATE SET
       status = ?3,
       current_period_end = ?4,
       -- Kept from the first past_due so the grace window is measured from when it started,
       -- not from the most recent webhook.
       past_due_since = CASE
         WHEN ?3 = 'past_due' THEN COALESCE(subscriptions.past_due_since, ?5)
         ELSE NULL
       END,
       cancel_at_period_end = ?6,
       has_payment_method = ?7,
       updated_at = ?8`,
  )
    .bind(
      input.id,
      input.customerId,
      input.status,
      input.currentPeriodEnd ?? null,
      input.status === "past_due" ? now : null,
      input.cancelAtPeriodEnd ? 1 : 0,
      input.hasPaymentMethod ? 1 : 0,
      now,
    )
    .run();
}

/* ── Licences from Stripe ─────────────────────────────────────────────────── */

/**
 * Record a paid licence. Returns its id.
 *
 * Keyed on `checkout_session_id`, which is `UNIQUE`: a redelivered webhook finds the
 * existing row instead of issuing a second licence for one payment.
 */
export async function recordPurchase(
  env: Env,
  input: {
    customerId: string;
    email: string;
    name?: string | null;
    plan: "lifetime" | "bundle";
    sessionId: string;
    paymentIntentId?: string | null;
  },
  now = Date.now(),
): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT id FROM licenses WHERE checkout_session_id = ?1",
  )
    .bind(input.sessionId)
    .first<{ id: string }>();
  if (existing) return existing.id;

  await env.DB.prepare(
    `INSERT INTO customers (stripe_customer_id, email, name, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(stripe_customer_id) DO UPDATE SET email = ?2`,
  )
    .bind(input.customerId, input.email.toLowerCase(), input.name ?? null, now)
    .run();

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  await env.DB.prepare(
    `INSERT INTO licenses (id, customer_id, plan, source, checkout_session_id,
                           payment_intent_id, status, created_at)
     VALUES (?1, ?2, ?3, 'checkout', ?4, ?5, 'active', ?6)`,
  )
    .bind(id, input.customerId, input.plan, input.sessionId, input.paymentIntentId ?? null, now)
    .run();

  return id;
}

/**
 * A refund or dispute takes the licence away (ARCHITECTURE §7.5).
 *
 * Matched on the payment intent, which is what both `charge.refunded` and
 * `charge.dispute.created` carry.
 */
export async function revokeByPaymentIntent(
  env: Env,
  paymentIntentId: string,
  reason: "refunded" | "revoked",
): Promise<number> {
  const result = await env.DB.prepare(
    "UPDATE licenses SET status = ?2 WHERE payment_intent_id = ?1 AND status = 'active'",
  )
    .bind(paymentIntentId, reason)
    .run();

  return result.meta.changes ?? 0;
}

/** The licence for an email, for the restore flow. */
export async function licenseForEmail(env: Env, email: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT l.id AS id FROM licenses l
       JOIN customers c ON c.stripe_customer_id = l.customer_id
      WHERE c.email = ?1 AND l.status = 'active'
      ORDER BY l.created_at DESC LIMIT 1`,
  )
    .bind(email.toLowerCase())
    .first<{ id: string }>();

  return row?.id ?? null;
}

/**
 * Has this webhook event already been handled?
 *
 * Stripe guarantees at-least-once delivery, so every handler has to be idempotent. Recording
 * the id first and acting only on a fresh insert makes that one atomic check instead of a
 * read followed by a write that could interleave.
 */
export async function isNewEvent(env: Env, id: string, type: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO stripe_events (id, type, received_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(id, type, Date.now())
    .run();

  return (result.meta.changes ?? 0) > 0;
}

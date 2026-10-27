import { Hono } from "hono";
import { limits } from "shared";

import { sendRestoreCode } from "../lib/email.ts";
import { fail } from "../lib/errors.ts";
import { sha256Hex, timingSafeEqual } from "../lib/ids.ts";
import {
  claimDeviceSlot,
  computerLimit,
  createClaim,
  deviceStatus,
  licenseById,
  licenseForEmail,
  moveHere,
  readClaim,
  redeemRenewalToken,
  removeDevice,
  RESTORE_MAX_ATTEMPTS,
  RESTORE_TTL_MS,
} from "../lib/license.ts";
import { clientIp, hashIp } from "../lib/ratelimit.ts";
import {
  billingPortal,
  createCheckout,
  createRenewalCheckout,
  type Purchasable,
} from "../lib/stripe.ts";

/**
 * Buying, claiming and restoring (PRD F8, ARCHITECTURE §7.5).
 *
 * **There is no licence key anywhere in this file.** Buying creates a `claim`, Checkout
 * carries it in metadata, the webhook marks it ready, and the app — which has been polling —
 * collects a device token. The user types nothing (F8.3).
 */
export const license = new Hono<{ Bindings: Env }>();

/** Where the browser lands after checkout. */
function webOrigin(env: Env): string {
  return (env as { WEB_ORIGIN?: string }).WEB_ORIGIN ?? "https://hopshot.xyz";
}

function isPurchasable(value: string): value is Purchasable {
  // One plan (PRD §7). `lifetime` remains a licence *state* but is not for sale, so a
  // request for it is a 400 rather than a checkout nobody should be able to reach.
  return value === "bundle";
}

/**
 * `POST /license/buy/{lifetime|bundle}` — start a purchase (PRD F8.2).
 *
 * Returns the Checkout URL for the app to open in the browser, and the claim to poll.
 */
license.post("/buy/:plan", async (c) => {
  const plan = c.req.param("plan");
  if (!isPurchasable(plan)) return fail(c, "bad_request", "That isn't something you can buy.");

  const installId = c.req.header("X-Hopshot-Install");
  if (!installId) return fail(c, "bad_request", "This request is missing its install id.");

  try {
    const claim = await createClaim(c.env, installId, plan);
    const session = await createCheckout(c.env, plan, claim, webOrigin(c.env));

    return c.json({ claim, url: session.url }, 201);
  } catch (error) {
    console.warn("could not start checkout", error);
    return fail(c, "server_error", "Checkout couldn't be opened. Try again shortly.");
  }
});

/**
 * `GET /license/claims/{claim}` — what the app polls while the browser is in Checkout.
 *
 * On `ready` it hands over the device token, which is the moment the app unlocks. The token
 * is returned once; only its hash is stored.
 */
license.get("/claims/:claim", async (c) => {
  const claim = c.req.param("claim");
  const installId = c.req.header("X-Hopshot-Install");
  if (!installId) return fail(c, "bad_request", "This request is missing its install id.");

  const state = await readClaim(c.env, claim);

  if (state.state === "unknown") {
    return fail(c, "not_found", "That purchase couldn't be found. It may have expired.");
  }
  if (state.state === "pending") return c.json({ status: "pending" });

  const label = c.req.header("X-Hopshot-Device") ?? "This computer";
  const slot = await claimDeviceSlot(c.env, state.licenseId, installId, label);

  if (!slot.ok) {
    // PRD: "Hopshot is on 3 computers. Remove one to use it here."
    const license = await licenseById(c.env, state.licenseId);
    return c.json(
      {
        status: "device_limit",
        maxComputers: license ? await computerLimit(c.env, license) : limits.lifetime.maxComputers,
        computers: slot.computers,
        licenseId: state.licenseId,
      },
      409,
    );
  }

  return c.json({ status: "ready", deviceToken: slot.deviceToken, plan: slot.plan });
});

/**
 * `GET /license/status` — may this computer run, and on what plan (PRD F8.3)?
 *
 * The interesting answer is `over_limit`: when Sync ends, a licence can hold more slots than
 * it is now allowed. The most recently seen devices up to the limit stay valid and the rest
 * get the list, so the user picks where Hopshot runs instead of us choosing for them
 * (DESIGN S9).
 */
license.get("/status", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return fail(c, "unauthorized", "This request needs its device token.");

  const status = await deviceStatus(c.env, token);

  return c.json(
    {
      ...status,
      recheckDays: limits.server.licenseRecheckDays,
      offlineGraceDays: limits.server.licenseOfflineGraceDays,
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

/**
 * `POST /license/move-here` — free another computer's slot and keep this one (DESIGN S9).
 *
 * Authenticated with this device's own token, so a licence holder can only move their own
 * licence around and not evict a stranger.
 */
license.post("/move-here", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return fail(c, "unauthorized", "This request needs its device token.");

  const body = await c.req.json<{ releaseDeviceId?: string }>().catch(() => null);
  const release = body?.releaseDeviceId?.trim();
  if (!release) return fail(c, "bad_request", "Choose which computer to free up.");

  const result = await moveHere(c.env, token, release);

  if (!result.ok) {
    if (result.reason === "same_device") {
      return fail(c, "bad_request", "That's this computer.");
    }
    if (result.reason === "not_found") {
      return fail(c, "not_found", "That computer isn't on this licence.");
    }
    return fail(c, "unauthorized", "That device token isn't valid.");
  }

  // Re-read so the caller gets the plan it has just become entitled to.
  const status = await deviceStatus(c.env, token);
  return c.json(status);
});

/** `DELETE /license/devices/{id}` — free a slot so a fourth computer can take it. */
license.delete("/devices/:deviceId", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const licenseId = c.req.query("license");

  // Either an existing device on the licence asks, or the app does during the 4th-computer
  // prompt, when it has a licence id from the 409 but no token yet.
  if (!token && !licenseId) {
    return fail(c, "unauthorized", "This request needs its device token.");
  }

  const owning = token
    ? await c.env.DB.prepare(
        "SELECT license_id FROM license_devices WHERE token_hash = ?1 AND removed_at IS NULL",
      )
        .bind(await sha256Hex(token))
        .first<{ license_id: string }>()
    : null;

  const target = owning?.license_id ?? licenseId;
  if (!target) return fail(c, "unauthorized", "That device token isn't valid.");

  await removeDevice(c.env, target, c.req.param("deviceId"));
  return c.body(null, 204);
});

/**
 * `GET /license/renew/{token}` — the link in the renewal email (PRD F8.8).
 *
 * Redirects straight into Stripe Checkout for the $24/year price against the existing
 * customer, so the card saved at purchase is offered and renewing is one click.
 *
 * A GET that redirects rather than a POST because it is reached from an email client, which
 * cannot post. The token is single-use and burned on redemption, so a forwarded email cannot
 * start a second checkout — and nothing is charged until the customer completes Checkout.
 */
license.get("/renew/:token", async (c) => {
  const redeemed = await redeemRenewalToken(c.env, c.req.param("token"));

  if (!redeemed) {
    // Deliberately vague and non-destructive: an expired link should read as "ask again",
    // not as an error the customer has to decode.
    return c.redirect(`${webOrigin(c.env)}/pricing?renew=expired`, 303);
  }

  try {
    const session = await createRenewalCheckout(
      c.env,
      redeemed.customerId,
      c.req.param("token"),
      webOrigin(c.env),
    );
    return c.redirect(session.url, 303);
  } catch (error) {
    console.warn("could not open the renewal checkout", error);
    return c.redirect(`${webOrigin(c.env)}/pricing?renew=failed`, 303);
  }
});

/**
 * `POST /license/portal` — "Manage Sync" (PRD F8.2).
 *
 * Returns a Stripe-hosted billing-portal URL for the app to open in the browser. Cancelling,
 * changing the card and the invoice history all live there, so none of it has to exist in
 * Hopshot — and the app never handles a payment detail.
 *
 * Authenticated with this device's own token: the customer is whoever the token's licence
 * belongs to, never a customer id supplied by the caller.
 */
license.post("/portal", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return fail(c, "unauthorized", "This request needs its device token.");

  const row = await c.env.DB.prepare(
    `SELECT l.customer_id AS customer_id
       FROM license_devices d
       JOIN licenses l ON l.id = d.license_id
      WHERE d.token_hash = ?1 AND d.removed_at IS NULL`,
  )
    .bind(await sha256Hex(token))
    .first<{ customer_id: string }>();

  if (!row) return fail(c, "unauthorized", "That device token isn't valid.");

  try {
    const session = await billingPortal(c.env, row.customer_id, `${webOrigin(c.env)}/thanks`);
    return c.json({ url: session.url });
  } catch (error) {
    console.warn("could not open the billing portal", error);
    return fail(c, "server_error", "Billing couldn't be opened. Try again shortly.");
  }
});

/* ── Restore (PRD F8: "Already bought? Restore") ──────────────────────────── */

/**
 * `POST /license/restore` — email a six-digit code.
 *
 * Answers 200 whether or not the address has a licence: telling an anonymous caller which
 * emails have bought Hopshot would be an enumeration oracle. Rate-limited per IP for the
 * same reason the pairing route is.
 */
license.post("/restore", async (c) => {
  const body = await c.req.json<{ email?: string; installId?: string }>().catch(() => null);
  const email = body?.email?.trim().toLowerCase();
  const installId = body?.installId?.trim();

  if (!email || !email.includes("@") || !installId) {
    return fail(c, "bad_request", "Enter the email you bought Hopshot with.");
  }

  const now = Date.now();
  const ipHash = await hashIp(clientIp(c.req.raw), c.env, now);

  // Cheap per-IP cap, reusing the daily counter the drops routes use.
  const { count } = await c.env.DB.prepare(
    `INSERT INTO usage (day, subject, kind, count, bytes)
     VALUES (?1, ?2, 'restore', 1, 0)
     ON CONFLICT(day, subject, kind) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(new Date(now).toISOString().slice(0, 10), ipHash)
    .first<{ count: number }>()
    .then((row) => row ?? { count: 1 });

  if (count > 20) {
    return fail(c, "limit_reached", "Too many attempts. Try again tomorrow.");
  }

  const licenseId = await licenseForEmail(c.env, email);
  if (licenseId) {
    // Six digits is enough given a 15-minute window and five attempts.
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(
      6,
      "0",
    );

    await c.env.DB.prepare(
      `INSERT INTO restore_codes (email, install_id, code_hash, attempts, expires_at)
       VALUES (?1, ?2, ?3, 0, ?4)
       ON CONFLICT(email, install_id)
       DO UPDATE SET code_hash = ?3, attempts = 0, expires_at = ?4`,
    )
      .bind(email, installId, await sha256Hex(code), now + RESTORE_TTL_MS)
      .run();

    c.executionCtx.waitUntil(
      sendRestoreCode(c.env, email, code).then((sent) => {
        if (!sent) console.warn("restore code could not be emailed");
      }),
    );
  }

  // Deliberately identical either way.
  return c.json({ sent: true });
});

/** `POST /license/restore/verify` — exchange the code for a device token. */
license.post("/restore/verify", async (c) => {
  const body = await c.req
    .json<{ email?: string; installId?: string; code?: string; label?: string }>()
    .catch(() => null);

  const email = body?.email?.trim().toLowerCase();
  const installId = body?.installId?.trim();
  const code = body?.code?.trim();

  if (!email || !installId || !code) {
    return fail(c, "bad_request", "Enter the code we emailed you.");
  }

  const now = Date.now();
  const row = await c.env.DB.prepare(
    "SELECT code_hash, attempts, expires_at FROM restore_codes WHERE email = ?1 AND install_id = ?2",
  )
    .bind(email, installId)
    .first<{ code_hash: string; attempts: number; expires_at: number }>();

  if (!row || row.expires_at <= now) {
    return fail(c, "not_found", "That code has expired. Ask for a new one.");
  }
  if (row.attempts >= RESTORE_MAX_ATTEMPTS) {
    return fail(c, "limit_reached", "Too many tries. Ask for a new code.");
  }

  if (!timingSafeEqual(await sha256Hex(code), row.code_hash)) {
    // Counted before answering, so a brute-forcer cannot get unlimited guesses.
    await c.env.DB.prepare(
      "UPDATE restore_codes SET attempts = attempts + 1 WHERE email = ?1 AND install_id = ?2",
    )
      .bind(email, installId)
      .run();
    return fail(c, "unauthorized", "That code isn't right.");
  }

  const licenseId = await licenseForEmail(c.env, email);
  if (!licenseId) return fail(c, "not_found", "There's no purchase on that email.");

  const slot = await claimDeviceSlot(
    c.env,
    licenseId,
    installId,
    body?.label ?? "This computer",
  );

  if (!slot.ok) {
    const license = await licenseById(c.env, licenseId);
    return c.json(
      {
        status: "device_limit",
        maxComputers: license ? await computerLimit(c.env, license) : limits.lifetime.maxComputers,
        computers: slot.computers,
        licenseId,
      },
      409,
    );
  }

  // Single-use: the code is spent whether or not the app asks again.
  await c.env.DB.prepare("DELETE FROM restore_codes WHERE email = ?1 AND install_id = ?2")
    .bind(email, installId)
    .run();

  return c.json({ status: "ready", deviceToken: slot.deviceToken, plan: slot.plan });
});

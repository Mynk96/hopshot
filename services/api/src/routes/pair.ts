import { Hono } from "hono";
import type { Enrolment } from "shared";

import { fail } from "../lib/errors.ts";
import { newToken, sha256Hex } from "../lib/ids.ts";
import { broadcast } from "../lib/live.ts";
import { planForVault, vaultLimitsFor } from "../lib/plan.ts";
import {
  PAIR_FAILURE_LIMIT,
  PAIR_FAILURE_WINDOW_MS,
  clientIp,
  hashIp,
} from "../lib/ratelimit.ts";
import { toDeviceSummary } from "./vaults.ts";

/**
 * `POST /pair` — redeem an invite code (ARCHITECTURE §7.2, PRD F4.1).
 *
 * This is the one unauthenticated write in the API: the caller is a phone that has just
 * scanned a QR and has no token yet. That makes it the brute-force target, so it is the one
 * route with a short-window per-IP lockout.
 */
export const pair = new Hono<{ Bindings: Env }>();

/** The 10-minute bucket an instant falls in, so the window is cheap to key on. */
export function windowStart(now: number): number {
  return Math.floor(now / PAIR_FAILURE_WINDOW_MS) * PAIR_FAILURE_WINDOW_MS;
}

/** How many failures this IP has already racked up in the current window. */
async function failureCount(env: Env, ipHash: string, now: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT failures FROM pair_attempts WHERE ip_hash = ?1 AND window_start = ?2",
  )
    .bind(ipHash, windowStart(now))
    .first<{ failures: number }>();

  return row?.failures ?? 0;
}

/**
 * Record a failure and return the new total.
 *
 * A single UPSERT, not read-then-write: two simultaneous wrong guesses must not both read
 * the old count and each store `old + 1`, which would let a parallel attacker get far more
 * than five tries.
 */
async function recordFailure(env: Env, ipHash: string, now: number): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO pair_attempts (ip_hash, window_start, failures) VALUES (?1, ?2, 1)
     ON CONFLICT(ip_hash, window_start) DO UPDATE SET failures = failures + 1
     RETURNING failures`,
  )
    .bind(ipHash, windowStart(now))
    .first<{ failures: number }>();

  return row?.failures ?? 1;
}

pair.post("/", async (c) => {
  const now = Date.now();
  const ipHash = await hashIp(clientIp(c.req.raw), c.env, now);

  // Checked before the code is even looked at, so a locked-out caller cannot keep probing.
  if ((await failureCount(c.env, ipHash, now)) >= PAIR_FAILURE_LIMIT) {
    return fail(c, "limit_reached", "Too many tries. Wait a few minutes and scan again.");
  }

  const body = await c.req
    .json<{ code?: string; deviceName?: string; kind?: string }>()
    .catch(() => null);

  const code = body?.code?.trim();
  const deviceName = body?.deviceName?.trim();
  const kind = body?.kind;

  if (!code || !deviceName || (kind !== "phone" && kind !== "desktop")) {
    // A malformed body is the caller's own mistake, not a guess, so it is not counted
    // against the lockout — otherwise a buggy client could lock out a whole office NAT.
    return fail(c, "bad_request", "This pairing request is incomplete.");
  }

  const invite = await c.env.DB.prepare(
    `SELECT code_hash, vault_id, expires_at, used_at FROM invites WHERE code_hash = ?1`,
  )
    .bind(await sha256Hex(code))
    .first<{ code_hash: string; vault_id: string; expires_at: number; used_at: number | null }>();

  // Unknown, spent and expired all answer the same way: a prober must not learn that a code
  // existed, only that this attempt did not work.
  if (!invite || invite.used_at !== null || invite.expires_at <= now) {
    await recordFailure(c.env, ipHash, now);
    return fail(c, "not_found", "This pairing code expired. Make a new one on your computer.");
  }

  const vaultId = invite.vault_id;

  // Device caps (§7.2). Counted live rather than trusted from a column, because revokes and
  // re-pairs move the number around.
  const counts = await c.env.DB.prepare(
    `SELECT kind, COUNT(*) AS n FROM devices
       WHERE vault_id = ?1 AND revoked_at IS NULL GROUP BY kind`,
  )
    .bind(vaultId)
    .all<{ kind: "desktop" | "phone"; n: number }>();

  const paired = { desktop: 0, phone: 0 };
  for (const row of counts.results) paired[row.kind] = row.n;

  // A phone scanning a QR sends no install id, so the caps have to come from the vault.
  const plan = await planForVault(c.env, vaultId);
  const caps = vaultLimitsFor(plan);

  if (kind === "phone" && paired.phone >= caps.maxPhones) {
    return fail(c, "limit_reached", `Sync pairs up to ${caps.maxPhones} phones.`);
  }
  if (kind === "desktop" && paired.desktop >= caps.maxComputers) {
    return fail(c, "limit_reached", `Hopshot is on ${caps.maxComputers} computers already.`);
  }

  const deviceId = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const deviceToken = newToken();

  /*
   * Burning the invite and creating the device have to be one unit, and the burn is written
   * as a conditional UPDATE so that two phones scanning the same QR at the same moment
   * cannot both enrol: the second one's UPDATE matches no rows.
   */
  const burn = await c.env.DB.prepare(
    "UPDATE invites SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL",
  )
    .bind(invite.code_hash, now)
    .run();

  if (burn.meta.changes === 0) {
    await recordFailure(c.env, ipHash, now);
    return fail(c, "conflict", "That pairing code was just used. Make a new one.");
  }

  await c.env.DB.prepare(
    `INSERT INTO devices (id, vault_id, name, kind, token_hash, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(deviceId, vaultId, deviceName, kind, await sha256Hex(deviceToken), now)
    .run();

  // So the computer's Settings → Devices list updates without a refresh.
  await broadcast(c.env, vaultId, {
    type: "device.joined",
    device: toDeviceSummary(
      {
        id: deviceId,
        vault_id: vaultId,
        name: deviceName,
        kind,
        created_at: now,
        last_seen_at: now,
        revoked_at: null,
      },
      // Nobody on the receiving end is this device, so nothing is "self".
      "",
    ),
  });

  return c.json<Enrolment>({ vaultId, deviceId, deviceToken }, 201);
});

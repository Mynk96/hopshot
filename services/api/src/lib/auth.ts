import type { Context } from "hono";

import { fail } from "./errors.ts";
import { sha256Hex } from "./ids.ts";

/**
 * Device-token auth for the vault routes (ARCHITECTURE §7.2).
 *
 * Every vault call carries `Authorization: Bearer {deviceToken}`. Tokens are only ever
 * stored hashed (`devices.token_hash`), so this hashes what the caller presented and looks
 * the row up *by that hash* — there is no secret comparison to get wrong, and a database
 * dump cannot be replayed against the API.
 *
 * A revoked device must lose access immediately (PRD F4.7), so `revoked_at` is checked on
 * every request rather than cached anywhere.
 */

export type Device = {
  id: string;
  vault_id: string;
  name: string;
  kind: "desktop" | "phone";
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
};

/** What a successful authentication establishes. */
export type Caller = { device: Device; vaultId: string };

/** Pull the bearer token out of the header, or `null` when there isn't one. */
export function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;

  const token = header.slice(7).trim();
  return token === "" ? null : token;
}

/**
 * Resolve a device token to its device, or `null` if the token is unknown or revoked.
 *
 * `last_seen_at` is updated on the caller's side with `waitUntil` — it is bookkeeping for
 * the devices list (DESIGN S7), and making every request wait on a write to record it
 * would add a round trip to the hot path for nothing.
 */
export async function deviceFor(env: Env, token: string): Promise<Device | null> {
  const row = await env.DB.prepare(
    `SELECT id, vault_id, name, kind, created_at, last_seen_at, revoked_at
       FROM devices WHERE token_hash = ?1`,
  )
    .bind(await sha256Hex(token))
    .first<Device>();

  if (!row || row.revoked_at !== null) return null;
  return row;
}

/**
 * Authenticate a vault request and check it is addressing its *own* vault.
 *
 * Returns either the caller or the `Response` to send back, so routes read as
 * `const auth = await authenticate(c); if ("response" in auth) return auth.response;`.
 *
 * The vault id in the path is checked against the token's vault: without that, any paired
 * device could read any other vault just by changing the URL.
 */
export async function authenticate(
  c: Context<{ Bindings: Env }>,
  vaultId: string,
): Promise<{ caller: Caller } | { response: Response }> {
  const token = bearer(c.req.raw);
  if (!token) {
    return { response: fail(c, "unauthorized", "This request needs its device token.") };
  }

  const device = await deviceFor(c.env, token);
  if (!device) {
    // One message for unknown, revoked and wrong-vault: a probe should not be able to tell
    // a real-but-revoked token from a token that never existed.
    return { response: fail(c, "unauthorized", "This device is no longer paired.") };
  }
  if (device.vault_id !== vaultId) {
    return { response: fail(c, "unauthorized", "This device is no longer paired.") };
  }

  touch(c, device.id);
  return { caller: { device, vaultId: device.vault_id } };
}

/** Some routes (revoke, invite) are desktop-only: a phone must not be able to unpair the Mac. */
export function requireDesktop(
  c: Context<{ Bindings: Env }>,
  caller: Caller,
): Response | null {
  if (caller.device.kind !== "desktop") {
    return fail(c, "forbidden", "Only your computer can change paired devices.");
  }
  return null;
}

/** Record activity for the devices list, off the critical path. */
export function touch(c: Context<{ Bindings: Env }>, deviceId: string): void {
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE devices SET last_seen_at = ?2 WHERE id = ?1")
      .bind(deviceId, Date.now())
      .run()
      // A failed bookkeeping write must never surface as a failed request.
      .catch((error: unknown) => console.warn("could not update last_seen_at", error)),
  );
}

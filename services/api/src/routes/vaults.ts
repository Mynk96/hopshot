import { Hono } from "hono";
import { limits } from "shared";
import type { DeviceSummary, Enrolment, Invite } from "shared";

import { authenticate, requireDesktop, type Device } from "../lib/auth.ts";
import { fail } from "../lib/errors.ts";
import { newToken, sha256Hex } from "../lib/ids.ts";
import { broadcast, kick } from "../lib/live.ts";
import { resolvePlan, vaultLimitsFor } from "../lib/plan.ts";

/**
 * Vaults, invites and devices (ARCHITECTURE §7.2).
 *
 * A vault is the shared, end-to-end-encrypted space a computer and its phones sync through.
 * The server stores ciphertext, hashed tokens and counts — never a vault key, which only
 * ever travels in a QR fragment between the user's own devices (CLAUDE.md privacy
 * invariant).
 */
export const vaults = new Hono<{ Bindings: Env }>();

/** Invite codes are short enough to retype but long enough not to be guessable. */
const INVITE_BYTES = 16;
const INVITE_TTL_MS = limits.server.inviteTtlSeconds * 1000;

/** An invite code: base64url, no padding, safe in a URL fragment. */
function newInviteCode(): string {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_BYTES));
  // Rejection-free mapping is not needed: the alphabet is read as an index, and a small
  // modulo bias over 56 symbols does not meaningfully reduce 16 bytes of entropy.
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function toDeviceSummary(row: Device, selfId: string): DeviceSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    isSelf: row.id === selfId,
  };
}

/**
 * `POST /vaults` — create a vault and enrol this computer as its first device.
 *
 * Trial or Sync only (§7.2): `limits.json` sets `lifetime.vault = false`, because syncing to
 * a phone is what Sync sells. Lifetime without Sync keeps drops and share links (F3/F5).
 */
vaults.post("/", async (c) => {
  const installId = c.req.header("X-Hopshot-Install");
  if (!installId) return fail(c, "bad_request", "This request is missing its install id.");

  const plan = await resolvePlan(c.req.raw, c.env);
  if (!vaultLimitsFor(plan).vault) {
    return fail(c, "forbidden", "Syncing to your phone needs Sync. Everything else still works.");
  }

  const body = await c.req.json<{ deviceName?: string; kind?: string }>().catch(() => null);
  const deviceName = body?.deviceName?.trim();
  if (!deviceName) return fail(c, "bad_request", "This computer needs a name.");
  if (body?.kind !== "desktop") {
    return fail(c, "bad_request", "A vault has to be created from a computer.");
  }

  const now = Date.now();
  // `owner` ties the vault to what paid for it: a license id once 4.1 lands, and the install
  // during the trial (schema comment in 0001_init.sql).
  const owner = plan === "trial" ? `trial:${installId}` : `install:${installId}`;

  const vaultId = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const deviceId = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const deviceToken = newToken();

  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO vaults (id, owner, created_at) VALUES (?1, ?2, ?3)").bind(
      vaultId,
      owner,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO devices (id, vault_id, name, kind, token_hash, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, 'desktop', ?4, ?5, ?5)`,
    ).bind(deviceId, vaultId, deviceName, await sha256Hex(deviceToken), now),
  ]);

  // The token is returned exactly once; only its hash is stored.
  return c.json<Enrolment>({ vaultId, deviceId, deviceToken }, 201);
});

/**
 * `POST /vaults/{vaultId}/invites` — a single-use pairing code, valid 10 minutes.
 *
 * Desktop only: a paired phone must not be able to mint invites and bring in more devices.
 */
vaults.post("/:vaultId/invites", async (c) => {
  const vaultId = c.req.param("vaultId");
  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  const forbidden = requireDesktop(c, auth.caller);
  if (forbidden) return forbidden;

  const code = newInviteCode();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;

  await c.env.DB.prepare(
    `INSERT INTO invites (code_hash, vault_id, created_by, expires_at)
     VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(await sha256Hex(code), vaultId, auth.caller.device.id, expiresAt)
    .run();

  // The plaintext code is returned once and never stored: it goes straight into the QR.
  return c.json<Invite>({ code, expiresAt }, 201);
});

/** `GET /vaults/{vaultId}/devices` — the paired list for DESIGN S7. */
vaults.get("/:vaultId/devices", async (c) => {
  const vaultId = c.req.param("vaultId");
  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  const { results } = await c.env.DB.prepare(
    `SELECT id, vault_id, name, kind, created_at, last_seen_at, revoked_at
       FROM devices WHERE vault_id = ?1 AND revoked_at IS NULL
       ORDER BY created_at ASC`,
  )
    .bind(vaultId)
    .all<Device>();

  return c.json(results.map((row) => toDeviceSummary(row, auth.caller.device.id)));
});

/**
 * `DELETE /vaults/{vaultId}/devices/{deviceId}` — revoke (PRD F4.7).
 *
 * Marks the row revoked, closes the device's live sockets and tells everyone else. All three
 * matter: without the kick, an open socket keeps delivering to a revoked phone.
 */
vaults.delete("/:vaultId/devices/:deviceId", async (c) => {
  const vaultId = c.req.param("vaultId");
  const deviceId = c.req.param("deviceId");

  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  const forbidden = requireDesktop(c, auth.caller);
  if (forbidden) return forbidden;

  // Revoking the computer you are asking from would lock you out of your own vault with no
  // way back in — there would be no desktop token left to mint an invite with.
  if (deviceId === auth.caller.device.id) {
    return fail(c, "forbidden", "This computer can't remove itself.");
  }

  const target = await c.env.DB.prepare(
    "SELECT id, revoked_at FROM devices WHERE id = ?1 AND vault_id = ?2",
  )
    .bind(deviceId, vaultId)
    .first<{ id: string; revoked_at: number | null }>();

  if (!target) return fail(c, "not_found", "That device isn't paired.");
  // Already gone is the desired end state, so this is a success rather than a 404.
  if (target.revoked_at !== null) return c.body(null, 204);

  await c.env.DB.prepare("UPDATE devices SET revoked_at = ?2 WHERE id = ?1")
    .bind(deviceId, Date.now())
    .run();

  await kick(c.env, vaultId, deviceId);
  await broadcast(c.env, vaultId, { type: "device.revoked", deviceId });

  return c.body(null, 204);
});

/**
 * `DELETE /vaults/{vaultId}` — "Delete all my cloud data" (DESIGN S7 Privacy).
 *
 * Removes the blobs first, then the rows. If this fails halfway the next run finishes the
 * job, whereas deleting the rows first would orphan every object in R2 with nothing left
 * pointing at it.
 */
vaults.delete("/:vaultId", async (c) => {
  const vaultId = c.req.param("vaultId");
  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  const forbidden = requireDesktop(c, auth.caller);
  if (forbidden) return forbidden;

  const { results } = await c.env.DB.prepare("SELECT r2_key FROM items WHERE vault_id = ?1")
    .bind(vaultId)
    .all<{ r2_key: string }>();

  // R2 deletes in batches of up to 1000 keys.
  const keys = results.map((row) => row.r2_key);
  for (let i = 0; i < keys.length; i += 1000) {
    await c.env.BUCKET.delete(keys.slice(i, i + 1000));
  }

  // `devices` and `items` are ON DELETE CASCADE from `vaults`, but D1 only enforces that
  // with foreign keys on, so they are removed explicitly rather than on trust.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM items WHERE vault_id = ?1").bind(vaultId),
    c.env.DB.prepare("DELETE FROM invites WHERE vault_id = ?1").bind(vaultId),
    c.env.DB.prepare("DELETE FROM live_tickets WHERE vault_id = ?1").bind(vaultId),
    c.env.DB.prepare("DELETE FROM devices WHERE vault_id = ?1").bind(vaultId),
    c.env.DB.prepare("DELETE FROM vaults WHERE id = ?1").bind(vaultId),
  ]);

  return c.body(null, 204);
});

export { INVITE_TTL_MS, newInviteCode };

import { Hono } from "hono";
import { limits } from "shared";
import type { LiveTicket } from "shared";

import { authenticate } from "../lib/auth.ts";
import { fail } from "../lib/errors.ts";
import { newToken, sha256Hex } from "../lib/ids.ts";
import { hubFor } from "../lib/live.ts";

/**
 * Live updates (ARCHITECTURE §7.4).
 *
 * A browser cannot set an `Authorization` header on a WebSocket, so the device token is
 * exchanged over HTTP for a short-lived single-use ticket, and the ticket is what travels in
 * the upgrade URL.
 *
 * A ticket in a query string is acceptable where a key never would be: it authenticates for
 * 60 seconds, dies on first use, and grants nothing beyond a read-only event stream. Vault
 * keys still only ever travel in URL fragments (CLAUDE.md privacy invariant).
 */
export const live = new Hono<{ Bindings: Env }>();

const TICKET_TTL_MS = limits.server.liveTicketTtlSeconds * 1000;

/** `POST /vaults/{vaultId}/live-ticket` → a 60-second, single-use ticket. */
live.post("/:vaultId/live-ticket", async (c) => {
  const vaultId = c.req.param("vaultId");
  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  const ticket = newToken();
  const expiresAt = Date.now() + TICKET_TTL_MS;

  await c.env.DB.prepare(
    `INSERT INTO live_tickets (ticket_hash, vault_id, device_id, expires_at)
     VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(await sha256Hex(ticket), vaultId, auth.caller.device.id, expiresAt)
    .run();

  return c.json<LiveTicket>({ ticket, expiresAt }, 201);
});

/**
 * `GET /vaults/{vaultId}/live?ticket=…` — upgrade and hand off to the VaultHub DO.
 *
 * This route cannot use `authenticate`: the caller is a WebSocket client with no headers to
 * carry a token. The ticket is the credential, and it is burned here.
 */
live.get("/:vaultId/live", async (c) => {
  const vaultId = c.req.param("vaultId");

  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return fail(c, "bad_request", "This endpoint is a WebSocket.");
  }

  const ticket = c.req.query("ticket");
  if (!ticket) return fail(c, "unauthorized", "This connection needs a ticket.");

  const now = Date.now();

  /*
   * Burn-on-read, as one conditional UPDATE. A plain SELECT-then-UPDATE would let the same
   * ticket open two sockets if both arrived together; here the second UPDATE matches no rows.
   */
  const burn = await c.env.DB.prepare(
    `UPDATE live_tickets SET used_at = ?2
       WHERE ticket_hash = ?1 AND used_at IS NULL AND expires_at > ?2
       RETURNING vault_id, device_id`,
  )
    .bind(await sha256Hex(ticket), now)
    .first<{ vault_id: string; device_id: string }>();

  if (!burn) return fail(c, "unauthorized", "That ticket has expired. Reconnecting…");
  if (burn.vault_id !== vaultId) {
    return fail(c, "unauthorized", "That ticket isn't for this vault.");
  }

  /*
   * Re-check the device. A ticket minted a minute ago says nothing about now, and a device
   * revoked in between must not get a socket — otherwise revocation would have a 60-second
   * hole in it (PRD F4.7).
   */
  const stillPaired = await c.env.DB.prepare(
    "SELECT id FROM devices WHERE id = ?1 AND vault_id = ?2 AND revoked_at IS NULL",
  )
    .bind(burn.device_id, vaultId)
    .first<{ id: string }>();

  if (!stillPaired) return fail(c, "unauthorized", "This device is no longer paired.");

  return hubFor(c.env, vaultId).fetch(
    `https://vault-hub.internal/connect?deviceId=${encodeURIComponent(burn.device_id)}`,
    // The upgrade has to be forwarded, headers and all, for the DO to complete the handshake.
    c.req.raw,
  );
});

export { TICKET_TTL_MS };

import { Hono } from "hono";
import { limits } from "shared";
import type { ItemCreated, ItemSummary } from "shared";

import { authenticate } from "../lib/auth.ts";
import { fail } from "../lib/errors.ts";
import { isValidId, itemKey } from "../lib/ids.ts";
import { broadcast } from "../lib/live.ts";
import { isItemTtlAllowed, planForVault, ttlToMs, vaultLimitsFor } from "../lib/plan.ts";
import { bumpUsage, readUsage } from "../lib/ratelimit.ts";

/**
 * Vault items — the synced shelf (ARCHITECTURE §7.3, PRD F4.3–F4.5).
 *
 * The body is a HOP1 envelope and `X-Hopshot-Meta` is the sealed metadata: the file name is
 * inside the ciphertext, so the server never learns it (CLAUDE.md privacy invariant).
 * Nothing here parses, logs or indexes either one.
 */
export const items = new Hono<{ Bindings: Env }>();

/** Counter kind in the `usage` table, keyed by vault. */
const PER_VAULT = "vault_items";

type ItemRow = {
  id: string;
  vault_id: string;
  source_device_id: string;
  r2_key: string;
  size: number;
  meta: string;
  created_at: number;
  expires_at: number;
};

function toSummary(row: ItemRow): ItemSummary {
  return {
    id: row.id,
    sourceDeviceId: row.source_device_id,
    size: row.size,
    meta: row.meta,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** `POST /vaults/{vaultId}/items/{itemId}?ttl=24h` — body is the ciphertext. */
items.post("/:vaultId/items/:itemId", async (c) => {
  const vaultId = c.req.param("vaultId");
  const itemId = c.req.param("itemId");

  if (!isValidId(itemId)) return fail(c, "bad_request", "That item id isn't valid.");

  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  // From the vault, not the request: a phone has no install id (see planForVault).
  const plan = await planForVault(c.env, vaultId);
  const caps = vaultLimitsFor(plan);

  const ttl = c.req.query("ttl") ?? "24h";
  if (!isItemTtlAllowed(ttl, plan)) {
    return fail(c, "forbidden", "That expiry isn't one your plan offers.");
  }
  const ttlMs = ttlToMs(ttl);
  if (ttlMs === null) return fail(c, "bad_request", "That expiry isn't one Hopshot offers.");

  const maxBytes = limits.server.maxCiphertextBytes;

  // Cheap rejections before any bytes move: declared size, then the daily cap.
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > maxBytes) {
    return fail(c, "too_large", "That image is too big to sync. 10 MB is the limit.");
  }

  const now = Date.now();
  const used = await readUsage(c.env, vaultId, PER_VAULT, now);
  if (used.count >= caps.uploadsPerDay) {
    return fail(c, "limit_reached", `That's ${caps.uploadsPerDay} synced items today.`);
  }

  // Sealed metadata, opaque to us. Required: without it the receiving device has no file
  // name or dimensions and cannot render a card.
  const meta = c.req.header("X-Hopshot-Meta");
  if (!meta) return fail(c, "bad_request", "This item is missing its metadata.");

  const existing = await c.env.DB.prepare("SELECT id FROM items WHERE id = ?1")
    .bind(itemId)
    .first<{ id: string }>();
  if (existing) return fail(c, "conflict", "That item id is already taken.");

  const body = await c.req.arrayBuffer();
  // Content-Length can lie or be absent; the real length is what decides.
  if (body.byteLength > maxBytes) {
    return fail(c, "too_large", "That image is too big to sync. 10 MB is the limit.");
  }
  if (body.byteLength === 0) return fail(c, "bad_request", "There was nothing to sync.");

  const key = itemKey(vaultId, itemId);
  const expiresAt = now + ttlMs;

  await c.env.BUCKET.put(key, body);

  try {
    await c.env.DB.prepare(
      `INSERT INTO items (id, vault_id, source_device_id, r2_key, size, meta,
                          created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        itemId,
        vaultId,
        auth.caller.device.id,
        key,
        body.byteLength,
        meta,
        now,
        expiresAt,
      )
      .run();
  } catch (error) {
    // Never leave an object nobody can reach but everybody pays for.
    await c.env.BUCKET.delete(key);
    throw error;
  }

  await bumpUsage(c.env, vaultId, PER_VAULT, body.byteLength, now);

  const summary: ItemSummary = {
    id: itemId,
    sourceDeviceId: auth.caller.device.id,
    size: body.byteLength,
    meta,
    createdAt: now,
    expiresAt,
  };

  // This is what makes F4.3's "within 3 s" possible; polling alone is 15 s.
  await broadcast(c.env, vaultId, { type: "item.created", item: summary });

  return c.json<ItemCreated>({ itemId, expiresAt }, 201);
});

/**
 * `GET /vaults/{vaultId}/items?since={ms}` — the feed, and the reconciliation path after a
 * dropped socket (§7.4).
 */
items.get("/:vaultId/items", async (c) => {
  const vaultId = c.req.param("vaultId");
  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  const sinceRaw = c.req.query("since");
  const since = sinceRaw === undefined ? 0 : Number(sinceRaw);
  if (!Number.isFinite(since) || since < 0) {
    return fail(c, "bad_request", "That 'since' value isn't valid.");
  }

  // Expired rows are filtered here as well as swept by cron: the sweep runs every 15 min, so
  // without this an item could be listed for up to a quarter of an hour after it expired.
  const { results } = await c.env.DB.prepare(
    `SELECT id, vault_id, source_device_id, r2_key, size, meta, created_at, expires_at
       FROM items
       WHERE vault_id = ?1 AND created_at > ?2 AND expires_at > ?3
       ORDER BY created_at DESC`,
  )
    .bind(vaultId, since, Date.now())
    .all<ItemRow>();

  return c.json(results.map(toSummary), 200, { "Cache-Control": "no-store" });
});

/** `GET /vaults/{vaultId}/items/{itemId}/blob` — the ciphertext. */
items.get("/:vaultId/items/:itemId/blob", async (c) => {
  const vaultId = c.req.param("vaultId");
  const itemId = c.req.param("itemId");

  if (!isValidId(itemId)) return fail(c, "bad_request", "That item id isn't valid.");

  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  const row = await c.env.DB.prepare(
    "SELECT r2_key, size, expires_at FROM items WHERE id = ?1 AND vault_id = ?2",
  )
    .bind(itemId, vaultId)
    .first<{ r2_key: string; size: number; expires_at: number }>();

  if (!row) return fail(c, "not_found", "That item doesn't exist.");
  if (row.expires_at <= Date.now()) return fail(c, "gone", "That one just expired.");

  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) return fail(c, "gone", "That one just expired.");

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(row.size),
      // The key lives on the device, not here; a cached blob would outlive its expiry.
      "Cache-Control": "no-store",
    },
  });
});

/** `DELETE /vaults/{vaultId}/items/{itemId}` — removes the blob and the row. */
items.delete("/:vaultId/items/:itemId", async (c) => {
  const vaultId = c.req.param("vaultId");
  const itemId = c.req.param("itemId");

  if (!isValidId(itemId)) return fail(c, "bad_request", "That item id isn't valid.");

  const auth = await authenticate(c, vaultId);
  if ("response" in auth) return auth.response;

  const row = await c.env.DB.prepare(
    "SELECT r2_key FROM items WHERE id = ?1 AND vault_id = ?2",
  )
    .bind(itemId, vaultId)
    .first<{ r2_key: string }>();

  // Already absent is the desired end state, and a phone retrying a delete should not see
  // an error for getting what it wanted.
  if (!row) return c.body(null, 204);

  await c.env.BUCKET.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM items WHERE id = ?1 AND vault_id = ?2")
    .bind(itemId, vaultId)
    .run();

  await broadcast(c.env, vaultId, { type: "item.deleted", id: itemId });

  return c.body(null, 204);
});

export { PER_VAULT };

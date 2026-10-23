import { Hono } from "hono";
import { limits } from "shared";

import { fail } from "../lib/errors.ts";
import { dropKey, isValidId, newToken, sha256Hex, timingSafeEqual } from "../lib/ids.ts";
import { isTtlAllowed, limitsFor, resolvePlan, ttlToMs } from "../lib/plan.ts";
import { bumpUsage, clientIp, hashIp, readUsage } from "../lib/ratelimit.ts";

/**
 * Drops — QR send and share links (ARCHITECTURE §7.1).
 *
 * The body is always a HOP1 envelope: the server stores ciphertext and never holds a key
 * (CLAUDE.md privacy invariant). Nothing here inspects or logs the blob.
 */
export const drops = new Hono<{ Bindings: Env }>();

/** Counter kinds in the `usage` table. */
const PER_INSTALL = "drops";
const PER_IP = "drops_ip";

type DropRow = {
  id: string;
  r2_key: string;
  size: number;
  created_at: number;
  expires_at: number;
  deleted_at: number | null;
  delete_token_hash: string;
  view_count: number;
};

/**
 * `POST /drops/{id}?ttl=24h` — body is the HOP1 ciphertext.
 *
 * Checks run cheapest-first so an oversize or over-quota upload is rejected before any
 * bytes are streamed to R2.
 */
drops.post("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isValidId(id)) {
    return fail(c, "bad_request", "That drop id isn't valid.");
  }

  const installId = c.req.header("X-Hopshot-Install");
  if (!installId) {
    return fail(c, "bad_request", "This request is missing its install id.");
  }

  const plan = await resolvePlan(c.req.raw, c.env);

  /*
   * PRD F8.1: Hopshot is pay-first, so an unlicensed caller sends nothing. `limitsFor` maps
   * an unknown plan onto the Lifetime caps, so without this gate an unlicensed user would
   * keep a free 10 sends a day — the paywall would not have held.
   *
   * Checked *after* input validation, so a malformed request still reports what is actually
   * wrong with it rather than being told to buy something.
   *
   * The shelf itself stays readable and draggable; that is local and nothing here touches it.
   */
  if (plan === "expired") {
    return fail(
      c,
      "forbidden",
      "Buy Hopshot to send links — your shelf is still here.",
    );
  }

  const planLimits = limitsFor(plan);

  // TTL has to be allowed on this plan (ARCHITECTURE §7.1).
  const ttl = c.req.query("ttl") ?? "24h";
  if (!isTtlAllowed(ttl, plan)) {
    return fail(
      c,
      "forbidden",
      `Links can last ${planLimits.dropTtlOptions.join(" or ")} on your plan. Sync allows longer.`,
    );
  }
  const ttlMs = ttlToMs(ttl);
  if (ttlMs === null) {
    return fail(c, "bad_request", "That expiry isn't one Hopshot offers.");
  }

  // Size cap from Content-Length, before streaming (ARCHITECTURE §7.9).
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > planLimits.maxCiphertextBytes) {
    return fail(c, "too_large", "That image is too big to send. 10 MB is the limit.");
  }

  const now = Date.now();
  const ipHash = await hashIp(clientIp(c.req.raw), c.env, now);

  // Daily caps, checked before the write (ARCHITECTURE §7.9).
  const [perInstall, perIp] = await Promise.all([
    readUsage(c.env, installId, PER_INSTALL, now),
    readUsage(c.env, ipHash, PER_IP, now),
  ]);

  if (perInstall.count >= planLimits.dropsPerDay) {
    return fail(
      c,
      "limit_reached",
      `That's ${planLimits.dropsPerDay} sends today. Sync raises it to ${limits.sync.dropsPerDay}.`,
    );
  }
  if (perIp.count >= limits.server.perIpDropsPerDay) {
    return fail(c, "limit_reached", "This network has sent a lot today. Try again tomorrow.");
  }

  // The client picks the id, so a collision is a real possibility to report (§6: 409).
  const existing = await c.env.DB.prepare("SELECT id FROM drops WHERE id = ?1")
    .bind(id)
    .first<{ id: string }>();
  if (existing) {
    return fail(c, "conflict", "That drop id is already taken.");
  }

  const body = await c.req.arrayBuffer();
  // Content-Length can lie or be absent; the real size is what decides.
  if (body.byteLength > planLimits.maxCiphertextBytes) {
    return fail(c, "too_large", "That image is too big to send. 10 MB is the limit.");
  }
  if (body.byteLength === 0) {
    return fail(c, "bad_request", "There was nothing to send.");
  }

  const key = dropKey(id);
  const deleteToken = newToken();
  const expiresAt = now + ttlMs;

  await c.env.BUCKET.put(key, body);

  try {
    await c.env.DB.prepare(
      `INSERT INTO drops (id, r2_key, size, created_at, expires_at, delete_token_hash,
                          install_id, ip_hash, plan)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        id,
        key,
        body.byteLength,
        now,
        expiresAt,
        await sha256Hex(deleteToken),
        installId,
        ipHash,
        plan,
      )
      .run();
  } catch (error) {
    // Never leave an orphan object paying for storage nobody can reach.
    await c.env.BUCKET.delete(key);
    throw error;
  }

  await Promise.all([
    bumpUsage(c.env, installId, PER_INSTALL, body.byteLength, now),
    bumpUsage(c.env, ipHash, PER_IP, body.byteLength, now),
  ]);

  return c.json({ id, deleteToken, expiresAt }, 201);
});

/** `GET /drops/{id}` — the ciphertext. */
drops.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isValidId(id)) return fail(c, "bad_request", "That drop id isn't valid.");

  const row = await c.env.DB.prepare("SELECT * FROM drops WHERE id = ?1")
    .bind(id)
    .first<DropRow>();

  if (!row) return fail(c, "not_found", "That link doesn't exist.");
  if (row.deleted_at !== null || row.expires_at <= Date.now()) {
    return fail(c, "gone", "This drop was deleted or has expired.");
  }

  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) {
    // The row outlived its object: the cron or the lifecycle rule got there first.
    return fail(c, "gone", "This drop was deleted or has expired.");
  }

  // Counted after the object is known to exist, so a 410 is not a view.
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE drops SET view_count = view_count + 1 WHERE id = ?1")
      .bind(id)
      .run(),
  );

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(row.size),
      // The key is in the URL fragment; a cached blob would outlive its expiry.
      "Cache-Control": "no-store",
    },
  });
});

/** `GET /drops/{id}/info` — for the viewer's countdown before it downloads. */
drops.get("/:id/info", async (c) => {
  const id = c.req.param("id");
  if (!isValidId(id)) return fail(c, "bad_request", "That drop id isn't valid.");

  const row = await c.env.DB.prepare(
    "SELECT size, expires_at, deleted_at FROM drops WHERE id = ?1",
  )
    .bind(id)
    .first<{ size: number; expires_at: number; deleted_at: number | null }>();

  if (!row) return fail(c, "not_found", "That link doesn't exist.");
  if (row.deleted_at !== null || row.expires_at <= Date.now()) {
    return fail(c, "gone", "This drop was deleted or has expired.");
  }

  return c.json(
    { expiresAt: row.expires_at, size: row.size },
    200,
    { "Cache-Control": "no-store" },
  );
});

/** `DELETE /drops/{id}` with `Authorization: Bearer {deleteToken}`. */
drops.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isValidId(id)) return fail(c, "bad_request", "That drop id isn't valid.");

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return fail(c, "unauthorized", "This request needs its delete token.");

  const row = await c.env.DB.prepare(
    "SELECT r2_key, delete_token_hash, deleted_at FROM drops WHERE id = ?1",
  )
    .bind(id)
    .first<{ r2_key: string; delete_token_hash: string; deleted_at: number | null }>();

  if (!row) return fail(c, "not_found", "That link doesn't exist.");

  if (!timingSafeEqual(await sha256Hex(token), row.delete_token_hash)) {
    return fail(c, "unauthorized", "That delete token isn't right.");
  }

  await c.env.BUCKET.delete(row.r2_key);
  // The row is kept with `deleted_at` set so a second DELETE is still 204 rather than 404,
  // and the cron reclaims it on the next pass.
  await c.env.DB.prepare("UPDATE drops SET deleted_at = ?2 WHERE id = ?1")
    .bind(id, Date.now())
    .run();

  return c.body(null, 204);
});

export { PER_INSTALL, PER_IP };

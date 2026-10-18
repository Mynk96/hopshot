/**
 * The 15-minute retention cron (ARCHITECTURE §7.8).
 *
 * > select expired `drops`/`items`, delete their R2 objects, then the rows; delete used or
 * > expired `invites`; drop `usage` rows older than 7 days.
 *
 * Objects go before rows, always. The other order can lose the only pointer to an object
 * mid-run and leave it paying for storage until the R2 lifecycle rule catches it 8 days
 * later.
 */

import { PAIR_FAILURE_WINDOW_MS } from "./ratelimit.ts";

/** Rows handled per run, so one pass cannot exceed the Worker's CPU budget. */
const BATCH = 500;

/** `usage` counters are kept for 7 days (ARCHITECTURE §7.8). */
const USAGE_RETENTION_DAYS = 7;

export type Swept = {
  drops: number;
  items: number;
  invites: number;
  usageRows: number;
  tickets: number;
  pairAttempts: number;
};

export async function sweep(env: Env, now = Date.now()): Promise<Swept> {
  const swept: Swept = {
    drops: 0,
    items: 0,
    invites: 0,
    usageRows: 0,
    tickets: 0,
    pairAttempts: 0,
  };

  // Expired *or* already deleted: a DELETE marks `deleted_at` and leaves the row for us.
  const drops = await env.DB.prepare(
    `SELECT id, r2_key FROM drops
     WHERE expires_at <= ?1 OR deleted_at IS NOT NULL
     LIMIT ${BATCH}`,
  )
    .bind(now)
    .all<{ id: string; r2_key: string }>();

  for (const row of drops.results ?? []) {
    await env.BUCKET.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM drops WHERE id = ?1").bind(row.id).run();
    swept.drops++;
  }

  const items = await env.DB.prepare(
    `SELECT id, r2_key FROM items WHERE expires_at <= ?1 LIMIT ${BATCH}`,
  )
    .bind(now)
    .all<{ id: string; r2_key: string }>();

  for (const row of items.results ?? []) {
    await env.BUCKET.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM items WHERE id = ?1").bind(row.id).run();
    swept.items++;
  }

  const invites = await env.DB.prepare(
    "DELETE FROM invites WHERE used_at IS NOT NULL OR expires_at <= ?1",
  )
    .bind(now)
    .run();
  swept.invites = invites.meta.changes ?? 0;

  // Spent or expired live tickets (§7.4). Single-use, so most rows here are already burned.
  const tickets = await env.DB.prepare(
    "DELETE FROM live_tickets WHERE used_at IS NOT NULL OR expires_at <= ?1",
  )
    .bind(now)
    .run();
  swept.tickets = tickets.meta.changes ?? 0;

  /*
   * Pairing lockout buckets, once their window has passed (§7.2).
   *
   * One extra window of grace rather than deleting at the boundary: a row removed the instant
   * its window closed would clear an attacker's failure count a few milliseconds early, and
   * the rows are tiny.
   */
  const attempts = await env.DB.prepare(
    "DELETE FROM pair_attempts WHERE window_start < ?1",
  )
    .bind(now - 2 * PAIR_FAILURE_WINDOW_MS)
    .run();
  swept.pairAttempts = attempts.meta.changes ?? 0;

  const cutoff = new Date(now - USAGE_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  const usage = await env.DB.prepare("DELETE FROM usage WHERE day < ?1").bind(cutoff).run();
  swept.usageRows = usage.meta.changes ?? 0;

  return swept;
}

import { sha256Hex } from "./ids.ts";

/**
 * Daily caps and IP hashing (ARCHITECTURE §7.9).
 *
 * Counters live in the `usage` table keyed by `(day, subject, kind)`, which the 15-minute
 * cron prunes after 7 days (§7.8). D1 has no atomic increment across statements, so the
 * bump is an UPSERT — a single statement, so two concurrent uploads cannot both read the
 * old count.
 */

/** UTC day key, `YYYY-MM-DD`. Caps are per calendar day. */
export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * SHA-256(IP + daily-rotated salt) — raw IPs are never stored (ARCHITECTURE §7.9).
 *
 * The salt rotates daily so yesterday's table cannot be correlated with today's, and mixes
 * in `IP_HASH_SECRET` when set so the hash is not reproducible from the date alone.
 */
export async function hashIp(ip: string, env: Env, now = Date.now()): Promise<string> {
  const secret = (env as { IP_HASH_SECRET?: string }).IP_HASH_SECRET ?? "";
  return sha256Hex(`${ip}|${dayKey(now)}|${secret}`);
}

/** The client IP as Cloudflare sees it. */
export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export type Usage = { count: number; bytes: number };

export async function readUsage(
  env: Env,
  subject: string,
  kind: string,
  now = Date.now(),
): Promise<Usage> {
  const row = await env.DB.prepare(
    "SELECT count, bytes FROM usage WHERE day = ?1 AND subject = ?2 AND kind = ?3",
  )
    .bind(dayKey(now), subject, kind)
    .first<{ count: number; bytes: number }>();

  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
}

/** Add one to a counter and return the new total. */
export async function bumpUsage(
  env: Env,
  subject: string,
  kind: string,
  bytes: number,
  now = Date.now(),
): Promise<Usage> {
  const row = await env.DB.prepare(
    `INSERT INTO usage (day, subject, kind, count, bytes) VALUES (?1, ?2, ?3, 1, ?4)
     ON CONFLICT(day, subject, kind)
     DO UPDATE SET count = count + 1, bytes = bytes + ?4
     RETURNING count, bytes`,
  )
    .bind(dayKey(now), subject, kind, bytes)
    .first<{ count: number; bytes: number }>();

  return { count: row?.count ?? 1, bytes: row?.bytes ?? bytes };
}

/** `/pair` brute force: 5 failures per IP per 10 min (ARCHITECTURE §7.9). Phase 5. */
export const PAIR_FAILURE_LIMIT = 5;
export const PAIR_FAILURE_WINDOW_MS = 10 * 60 * 1000;

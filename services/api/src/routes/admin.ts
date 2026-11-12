import { Hono } from "hono";
import { limits } from "shared";

import { sha256Hex, timingSafeEqual } from "../lib/ids.ts";
import { dayKey } from "../lib/ratelimit.ts";

/**
 * admin routes — see ARCHITECTURE §7 and §7.10.
 * `Env` is the ambient binding type generated into worker-configuration.d.ts
 * by `pnpm -F api cf-typegen`.
 *
 * Every route sits behind the ADMIN_TOKEN gate: fail closed, 404 rather than 401 so an
 * unauthenticated prober learns nothing, and no surface at all while the secret is unset.
 *
 *   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.hopshot.xyz/v1/admin/stats
 */
export const admin = new Hono<{ Bindings: Env }>();

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many recent days the stats chart covers. */
const CHART_DAYS = 14;
/** How many of the latest feedback comments to return. */
const RECENT_FEEDBACK = 20;

admin.use("*", async (c, next) => {
  const secret = (c.env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  const header = c.req.header("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Compared as digests so the comparison is constant-time and length-independent.
  if (
    !secret ||
    !presented ||
    !timingSafeEqual(await sha256Hex(presented), await sha256Hex(secret))
  ) {
    return c.notFound();
  }
  await next();
});

type Count = { n: number };

/**
 * `GET /v1/admin/stats` — installs, activity, screenshots, day-7 retention, the mailing list
 * and feedback, in one JSON document.
 */
admin.get("/stats", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const since = (days: number) => now - days * DAY_MS;
  const count = async (sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).bind(...args).first<Count>())?.n ?? 0;

  const [
    installs,
    active1,
    active7,
    active30,
    new7,
    capturesTotal,
    chart,
    retention,
    versions,
    os,
    subscribers,
    feedback,
    recent,
  ] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM installs"),
    count("SELECT COUNT(*) AS n FROM installs WHERE last_seen >= ?1", since(1)),
    count("SELECT COUNT(*) AS n FROM installs WHERE last_seen >= ?1", since(7)),
    count("SELECT COUNT(*) AS n FROM installs WHERE last_seen >= ?1", since(30)),
    count("SELECT COUNT(*) AS n FROM installs WHERE first_seen >= ?1", since(7)),
    count("SELECT COALESCE(SUM(captures), 0) AS n FROM install_days"),
    db
      .prepare(
        `SELECT day, SUM(captures) AS captures, COUNT(*) AS installs FROM install_days
         WHERE day >= ?1 GROUP BY day ORDER BY day`,
      )
      .bind(dayKey(since(CHART_DAYS - 1)))
      .all<{ day: string; captures: number; installs: number }>(),
    /*
     * Day-7 retention: of the installs first seen 8 to 37 days ago (old enough to have had a
     * day 7), how many reported a screenshot day on or after their 7th day.
     */
    db
      .prepare(
        `SELECT COUNT(*) AS cohort,
                SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM install_days d
                   WHERE d.install_id = i.install_id AND d.captures > 0
                     AND d.day >= strftime('%Y-%m-%d', i.first_seen / 1000 + 7 * 86400, 'unixepoch')
                ) THEN 1 ELSE 0 END) AS retained
           FROM installs i WHERE i.first_seen BETWEEN ?1 AND ?2`,
      )
      .bind(since(37), since(8))
      .first<{ cohort: number; retained: number | null }>(),
    db
      .prepare(
        `SELECT version, COUNT(*) AS installs FROM installs WHERE last_seen >= ?1
         GROUP BY version ORDER BY installs DESC`,
      )
      .bind(since(30))
      .all<{ version: string; installs: number }>(),
    db
      .prepare(
        `SELECT os, COUNT(*) AS installs FROM installs WHERE last_seen >= ?1
         GROUP BY os ORDER BY installs DESC`,
      )
      .bind(since(30))
      .all<{ os: string; installs: number }>(),
    db
      .prepare("SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status")
      .all<{ status: string; n: number }>(),
    db
      .prepare("SELECT useful, COUNT(*) AS n FROM feedback GROUP BY useful")
      .all<{ useful: number; n: number }>(),
    db
      .prepare(
        `SELECT useful, comment, version, created_at FROM feedback
         ORDER BY created_at DESC LIMIT ?1`,
      )
      .bind(RECENT_FEEDBACK)
      .all<{ useful: number; comment: string | null; version: string | null; created_at: number }>(),
  ]);

  const byStatus = Object.fromEntries((subscribers.results ?? []).map((r) => [r.status, r.n]));
  const byUseful = Object.fromEntries((feedback.results ?? []).map((r) => [r.useful, r.n]));
  const cohort = retention?.cohort ?? 0;
  const retained = retention?.retained ?? 0;

  return c.json(
    {
      generatedAt: now,
      installs: { total: installs, new7d: new7, active1d: active1, active7d: active7, active30d: active30 },
      screenshots: { total: capturesTotal, byDay: chart.results ?? [] },
      retentionDay7: { cohort, retained, rate: cohort ? retained / cohort : null },
      versions: versions.results ?? [],
      os: os.results ?? [],
      subscribers: {
        confirmed: byStatus.confirmed ?? 0,
        pending: byStatus.pending ?? 0,
        unsubscribed: byStatus.unsubscribed ?? 0,
      },
      feedback: {
        useful: byUseful[1] ?? 0,
        notUseful: byUseful[0] ?? 0,
        recent: (recent.results ?? []).map((r) => ({
          useful: r.useful === 1,
          comment: r.comment,
          version: r.version,
          createdAt: r.created_at,
        })),
      },
      limits: { feedbackAfterDays: limits.insights.feedbackAfterDays },
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

/** `GET /v1/admin/subscribers` — confirmed addresses, for sending the next announcement. */
admin.get("/subscribers", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT email, source, confirmed_at FROM subscribers
     WHERE status = 'confirmed' ORDER BY confirmed_at`,
  ).all<{ email: string; source: string; confirmed_at: number }>();

  return c.json(
    (results ?? []).map((r) => ({ email: r.email, source: r.source, confirmedAt: r.confirmed_at })),
    200,
    { "Cache-Control": "no-store" },
  );
});

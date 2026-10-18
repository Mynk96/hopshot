import { Hono } from "hono";
import { limits } from "shared";

import { fail } from "../lib/errors.ts";
import { TRIAL_MS } from "../lib/plan.ts";
import { clientIp, hashIp } from "../lib/ratelimit.ts";

/**
 * `POST /trial/start` — record the start of the 7-day trial (PRD F8, ARCHITECTURE §7.5).
 *
 * The desktop app also keeps a local first-launch record, but the server copy is what
 * `resolvePlan` trusts: a local file can be deleted to mint a fresh trial, and the vault
 * routes gate on the plan.
 *
 * Idempotent on `installId`. Re-posting returns the *original* start date rather than
 * resetting it, so reinstalling does not extend the trial.
 */
export const trial = new Hono<{ Bindings: Env }>();

trial.post("/start", async (c) => {
  const installId = c.req.header("X-Hopshot-Install");
  if (!installId) return fail(c, "bad_request", "This request is missing its install id.");

  const now = Date.now();

  /*
   * One statement, so two first launches racing cannot both insert. `DO UPDATE` with a
   * no-op assignment is what makes `RETURNING` give back the existing row — `DO NOTHING`
   * returns nothing at all on conflict, which would read as a failure.
   */
  const row = await c.env.DB.prepare(
    `INSERT INTO trials (install_id, started_at, ip_hash) VALUES (?1, ?2, ?3)
     ON CONFLICT(install_id) DO UPDATE SET install_id = install_id
     RETURNING started_at`,
  )
    .bind(installId, now, await hashIp(clientIp(c.req.raw), c.env, now))
    .first<{ started_at: number }>();

  const startedAt = row?.started_at ?? now;
  const endsAt = startedAt + TRIAL_MS;

  return c.json({
    startedAt,
    endsAt,
    days: limits.trial.days,
    // False when an old install re-posts after its trial ran out, which is how the app
    // knows to show the trial-ended state (PRD F8.1a) rather than a fresh welcome.
    active: now < endsAt,
  });
});

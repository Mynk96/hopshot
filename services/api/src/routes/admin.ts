import { Hono } from "hono";

import { fail } from "../lib/errors.ts";
import { timingSafeEqual } from "../lib/ids.ts";
import { sendRenewalNotices } from "../lib/renewals.ts";

/**
 * admin routes — see ARCHITECTURE §7.
 * `Env` is the ambient binding type generated into worker-configuration.d.ts
 * by `pnpm -F api cf-typegen`.
 *
 * **Everything here fails closed.** `ADMIN_TOKEN` is an optional secret, and while it is
 * unset every route answers 404 — identical to a path that does not exist, so deploying this
 * without setting the secret adds no surface at all.
 */
export const admin = new Hono<{ Bindings: Env }>();

/**
 * 404 rather than 401 for a missing or wrong token.
 *
 * These routes do real work (sending mail, reading customer rows), so the useful answer to an
 * unauthenticated prober is that they do not exist.
 */
admin.use("*", async (c, next) => {
  const expected = (c.env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  if (!expected) return fail(c, "not_found", "Not found.");

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !timingSafeEqual(token, expected)) {
    return fail(c, "not_found", "Not found.");
  }

  await next();
});

/**
 * `POST /admin/renewals/run` — run the renewal-notice job now (PRD F8.8).
 *
 * Exists for two reasons, both of which are about seeing the thing work rather than trusting
 * that it does:
 *
 * 1. **Testing the flow at all.** The daily cron only notices a licence whose included Sync
 *    year ends within 10 days, so in a sandbox there is nothing for it to find and no way to
 *    wait a year. Backdate a licence, then call this. See docs/LAUNCH.md §2c.
 * 2. **Re-running a failed night.** If Resend is down at 09:00 UTC, the notices for that day
 *    are simply not sent; `emails_sent` only records successes, so calling this re-sends
 *    exactly the ones that did not go out.
 *
 * Safe to call repeatedly: one notice per licence per renewal year, enforced by `emails_sent`.
 * It sends no money, charges nothing and creates no subscription — a notice is a question.
 */
admin.post("/renewals/run", async (c) => {
  /*
   * `at` lets the caller ask "what would this send on that date", which is how the notice
   * window itself gets tested without touching any row. It does not change what Sync a
   * customer actually has — for that, the licence has to really be a year old.
   */
  const at = c.req.query("at");
  const now = at ? Date.parse(at) : Date.now();
  if (Number.isNaN(now)) {
    return fail(c, "bad_request", "`at` must be an ISO date.");
  }

  const sent = await sendRenewalNotices(c.env, now);
  return c.json({ sent, at: new Date(now).toISOString() });
});

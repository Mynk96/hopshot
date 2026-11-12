import { Hono, type Context } from "hono";
import { limits } from "shared";

import { sendSubscribeConfirm } from "../lib/email.ts";
import { fail } from "../lib/errors.ts";
import { newToken, sha256Hex } from "../lib/ids.ts";
import { bumpUsage, clientIp, dayKey, hashIp, readUsage } from "../lib/ratelimit.ts";

/**
 * Usage counts, the mailing list and in-app feedback (ARCHITECTURE §7.10).
 *
 * Privacy (CLAUDE.md rule 1): a ping carries a random install id, the app version, the OS and
 * screenshot counts per day — never an image, a file name or anything that was on screen. No
 * IP is stored; it is only hashed with a daily salt to rate-limit, like every other route.
 * The mailing list is not linked to install ids.
 *
 * Every write is rate-limited per IP with caps from config/limits.json (rule 2).
 */
export const insights = new Hono<{ Bindings: Env }>();

const caps = limits.insights;

/** `crypto::new_id()` on the desktop: 22 base62 characters. Anything else is not ours. */
const INSTALL_ID = /^[A-Za-z0-9]{16,64}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** RFC 5321's practical limit, and a deliberately loose shape: the confirm email is the test. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
/** No day can be implausibly busy; a bigger number is a bug or a forged ping. */
const MAX_CAPTURES_PER_DAY = 10_000;

const PER_IP_PING = "ping_ip";
const PER_IP_SUBSCRIBE = "subscribe_ip";
const PER_IP_FEEDBACK = "feedback_ip";

/** Count this request against an IP's daily cap; true when the cap is already reached. */
async function overCap(c: Context<{ Bindings: Env }>, kind: string, cap: number): Promise<boolean> {
  const now = Date.now();
  const ipHash = await hashIp(clientIp(c.req.raw), c.env, now);
  if ((await readUsage(c.env, ipHash, kind, now)).count >= cap) return true;
  await bumpUsage(c.env, ipHash, kind, 0, now);
  return false;
}

type PingBody = {
  installId?: unknown;
  version?: unknown;
  os?: unknown;
  days?: unknown;
};

/**
 * `POST /v1/stats/ping` — the app's daily heartbeat.
 *
 * `days` carries the running screenshot total for each of the last few UTC days. The server
 * keeps the larger of what it has and what it hears, so a repeated or delayed ping can only
 * ever confirm a count, never inflate it.
 */
insights.post("/stats/ping", async (c) => {
  const body = await c.req.json<PingBody>().catch(() => null);
  if (!body) return fail(c, "bad_request", "Invalid.");

  const { installId, version, os, days } = body;
  if (typeof installId !== "string" || !INSTALL_ID.test(installId)) {
    return fail(c, "bad_request", "Invalid install id.");
  }
  if (typeof version !== "string" || !VERSION.test(version)) {
    return fail(c, "bad_request", "Invalid version.");
  }
  if (os !== "macos" && os !== "windows") return fail(c, "bad_request", "Invalid OS.");
  if (!Array.isArray(days) || days.length > caps.pingMaxDays) {
    return fail(c, "bad_request", "Invalid days.");
  }

  const now = Date.now();
  // Recent days only: a ping cannot rewrite history or claim the future.
  const oldest = dayKey(now - caps.pingMaxDays * DAY_MS);
  const newest = dayKey(now + DAY_MS);
  const counts: { day: string; captures: number }[] = [];
  for (const entry of days as { day?: unknown; captures?: unknown }[]) {
    const { day, captures } = entry ?? {};
    if (
      typeof day !== "string" ||
      !DAY.test(day) ||
      day < oldest ||
      day > newest ||
      typeof captures !== "number" ||
      !Number.isInteger(captures) ||
      captures < 0 ||
      captures > MAX_CAPTURES_PER_DAY
    ) {
      return fail(c, "bad_request", "Invalid day.");
    }
    counts.push({ day, captures });
  }

  if (await overCap(c, PER_IP_PING, caps.pingsPerIpPerDay)) {
    return fail(c, "limit_reached", "Too many pings today.");
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO installs (install_id, first_seen, last_seen, version, os)
       VALUES (?1, ?2, ?2, ?3, ?4)
       ON CONFLICT(install_id) DO UPDATE SET last_seen = ?2, version = ?3, os = ?4`,
    ).bind(installId, now, version, os),
    ...counts.map(({ day, captures }) =>
      c.env.DB.prepare(
        `INSERT INTO install_days (install_id, day, captures) VALUES (?1, ?2, ?3)
         ON CONFLICT(install_id, day) DO UPDATE SET captures = MAX(captures, ?3)`,
      ).bind(installId, day, captures),
    ),
  ]);

  return c.json({ ok: true });
});

type FeedbackBody = { installId?: unknown; useful?: unknown; comment?: unknown; version?: unknown };

/** `POST /v1/feedback` — "Is Hopshot useful to you?", asked once in the app. */
insights.post("/feedback", async (c) => {
  const body = await c.req.json<FeedbackBody>().catch(() => null);
  if (!body || typeof body.useful !== "boolean") return fail(c, "bad_request", "Invalid.");

  const installId =
    typeof body.installId === "string" && INSTALL_ID.test(body.installId) ? body.installId : null;
  const version =
    typeof body.version === "string" && VERSION.test(body.version) ? body.version : null;
  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== "string") return fail(c, "bad_request", "Invalid comment.");
    if (body.comment.length > caps.feedbackCommentMaxChars) {
      return fail(c, "too_large", "That comment is too long.");
    }
    comment = body.comment.trim() || null;
  }

  if (await overCap(c, PER_IP_FEEDBACK, caps.feedbackPerIpPerDay)) {
    return fail(c, "limit_reached", "Too much feedback today.");
  }

  await c.env.DB.prepare(
    "INSERT INTO feedback (install_id, useful, comment, version, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(installId, body.useful ? 1 : 0, comment, version, Date.now())
    .run();

  return c.json({ ok: true });
});

/** Where confirm and unsubscribe links land after they act. */
function webOrigin(env: Env): string {
  return (env as { WEB_ORIGIN?: string }).WEB_ORIGIN ?? "https://hopshot.xyz";
}

type SubscribeBody = { email?: unknown; source?: unknown };

/**
 * `POST /v1/subscribe` — join the mailing list (double opt-in).
 *
 * The answer is the same whether the address is new, pending, confirmed or unsubscribed, so
 * nobody can use this to find out who is on the list. A confirmed address gets no email; any
 * other gets a fresh confirmation link, which also invalidates the previous one.
 */
insights.post("/subscribe", async (c) => {
  const body = await c.req.json<SubscribeBody>().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > EMAIL_MAX || !EMAIL.test(email)) {
    return fail(c, "bad_request", "That doesn't look like an email address.");
  }
  const source = body?.source === "onboarding" ? "onboarding" : "website";

  if (await overCap(c, PER_IP_SUBSCRIBE, caps.subscribesPerIpPerDay)) {
    return fail(c, "limit_reached", "Too many sign-ups from here today. Try again tomorrow.");
  }

  const existing = await c.env.DB.prepare("SELECT status FROM subscribers WHERE email = ?1")
    .bind(email)
    .first<{ status: string }>();

  if (existing?.status !== "confirmed") {
    const token = newToken();
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO subscribers (email, status, source, token_hash, created_at)
       VALUES (?1, 'pending', ?2, ?3, ?4)
       ON CONFLICT(email) DO UPDATE SET status = 'pending', token_hash = ?3, unsubscribed_at = NULL`,
    )
      .bind(email, source, await sha256Hex(token), now)
      .run();

    // Links go to this API, which acts and then redirects to a page on the web app.
    const api = new URL(c.req.url).origin;
    const query = `token=${encodeURIComponent(token)}`;
    const sent = await sendSubscribeConfirm(
      c.env,
      email,
      `${api}/v1/subscribe/confirm?${query}`,
      `${api}/v1/subscribe/unsubscribe?${query}`,
    );
    // A failed send is logged in `send`; the address stays pending and can retry.
    if (!sent) console.warn("subscribe confirmation was not sent");
  }

  return c.json({ ok: true });
});

/** Shared by confirm and unsubscribe: find the subscriber a link's token belongs to. */
async function byToken(env: Env, token: string | undefined): Promise<string | null> {
  if (!token || token.length > 200) return null;
  const row = await env.DB.prepare("SELECT email FROM subscribers WHERE token_hash = ?1")
    .bind(await sha256Hex(token))
    .first<{ email: string }>();
  return row?.email ?? null;
}

/** `GET /v1/subscribe/confirm?token=` — the link in the confirmation email. */
insights.get("/subscribe/confirm", async (c) => {
  const email = await byToken(c.env, c.req.query("token"));
  if (!email) return c.redirect(`${webOrigin(c.env)}/subscribed?status=invalid`, 303);

  await c.env.DB.prepare(
    `UPDATE subscribers SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?2)
     WHERE email = ?1 AND status != 'unsubscribed'`,
  )
    .bind(email, Date.now())
    .run();
  return c.redirect(`${webOrigin(c.env)}/subscribed?status=confirmed`, 303);
});

/** `GET /v1/subscribe/unsubscribe?token=` — one click, no confirmation page to get past. */
insights.get("/subscribe/unsubscribe", async (c) => {
  const email = await byToken(c.env, c.req.query("token"));
  if (!email) return c.redirect(`${webOrigin(c.env)}/subscribed?status=invalid`, 303);

  await c.env.DB.prepare(
    "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?2 WHERE email = ?1",
  )
    .bind(email, Date.now())
    .run();
  return c.redirect(`${webOrigin(c.env)}/subscribed?status=unsubscribed`, 303);
});

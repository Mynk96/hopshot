import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limits } from "shared";
import { dayKey } from "../src/lib/ratelimit.ts";
import { applyMigrations, captureEmail, freshId, resetEmail, send } from "./helpers.ts";

/**
 * Usage counts, the mailing list and feedback (ARCHITECTURE §7.10).
 *
 * CLAUDE.md rule 8: every route gets its happy path, its limit, auth where it has any, and
 * bad input.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN = { Authorization: "Bearer admin_test_token" };

beforeEach(async () => {
  await applyMigrations();
});

afterEach(() => {
  resetEmail();
});

function json(path: string, body: unknown, headers: Record<string, string> = {}) {
  return send(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });
}

function ping(installId: string, days: { day: string; captures: number }[], extra = {}) {
  return json("/v1/stats/ping", { installId, version: "0.1.8", os: "macos", days, ...extra });
}

async function stats() {
  const response = await send("/v1/admin/stats", { headers: ADMIN });
  expect(response.status).toBe(200);
  return response.json<{
    installs: { total: number; new7d: number; active1d: number; active7d: number };
    screenshots: { total: number; byDay: { day: string; captures: number; installs: number }[] };
    retentionDay7: { cohort: number; retained: number; rate: number | null };
    subscribers: { confirmed: number; pending: number; unsubscribed: number };
    feedback: { useful: number; notUseful: number; recent: { useful: boolean; comment: string | null }[] };
  }>();
}

describe("POST /v1/stats/ping", () => {
  it("records the install and its screenshots per day", async () => {
    const id = freshId();
    const today = dayKey();
    expect((await ping(id, [{ day: today, captures: 3 }])).status).toBe(200);

    const s = await stats();
    expect(s.installs.total).toBe(1);
    expect(s.installs.active1d).toBe(1);
    expect(s.screenshots.total).toBe(3);
    expect(s.screenshots.byDay).toEqual([{ day: today, captures: 3, installs: 1 }]);
  });

  /** A repeated or out-of-order ping must never inflate a day's count. */
  it("keeps the larger count for a day, never the sum", async () => {
    const id = freshId();
    const today = dayKey();
    await ping(id, [{ day: today, captures: 5 }]);
    await ping(id, [{ day: today, captures: 5 }]);
    await ping(id, [{ day: today, captures: 2 }]);
    expect((await stats()).screenshots.total).toBe(5);

    await ping(id, [{ day: today, captures: 9 }]);
    expect((await stats()).screenshots.total).toBe(9);
  });

  it("never stores the IP or anything but counts", async () => {
    await ping(freshId(), [{ day: dayKey(), captures: 1 }]);
    const row = await env.DB.prepare("SELECT * FROM installs").first<Record<string, unknown>>();
    expect(Object.keys(row!).sort()).toEqual(["first_seen", "install_id", "last_seen", "os", "version"]);
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
  });

  it("rejects malformed pings", async () => {
    const id = freshId();
    const today = dayKey();
    expect((await ping("bad id!", [])).status).toBe(400);
    expect((await ping(id, [], { version: "latest" })).status).toBe(400);
    expect((await ping(id, [], { os: "linux" })).status).toBe(400);
    expect((await ping(id, [{ day: "yesterday", captures: 1 }])).status).toBe(400);
    expect((await ping(id, [{ day: today, captures: -1 }])).status).toBe(400);
    expect((await ping(id, [{ day: today, captures: 1.5 }])).status).toBe(400);
    // A day older than the ping window cannot be rewritten.
    const ancient = dayKey(Date.now() - (limits.insights.pingMaxDays + 2) * DAY_MS);
    expect((await ping(id, [{ day: ancient, captures: 1 }])).status).toBe(400);
    const tooMany = Array.from({ length: limits.insights.pingMaxDays + 1 }, () => ({
      day: today,
      captures: 1,
    }));
    expect((await ping(id, tooMany)).status).toBe(400);
    expect((await stats()).installs.total).toBe(0);
  });

  it("stops at the per-IP daily cap with 429", async () => {
    for (let i = 0; i < limits.insights.pingsPerIpPerDay; i++) {
      expect((await ping(freshId(), [])).status).toBe(200);
    }
    expect((await ping(freshId(), [])).status).toBe(429);
  });
});

describe("day-7 retention", () => {
  it("counts an install as retained when it captured on or after its 7th day", async () => {
    const now = Date.now();
    const firstSeen = now - 20 * DAY_MS;
    const insert = (id: string, day: string) =>
      env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO installs (install_id, first_seen, last_seen, version, os) VALUES (?1, ?2, ?3, '0.1.8', 'macos')",
        ).bind(id, firstSeen, now),
        env.DB.prepare("INSERT INTO install_days (install_id, day, captures) VALUES (?1, ?2, 2)").bind(id, day),
      ]);
    await insert("retainedInstall0000001", dayKey(firstSeen + 10 * DAY_MS));
    await insert("churnedInstall00000001", dayKey(firstSeen + 2 * DAY_MS));

    const s = await stats();
    expect(s.retentionDay7).toEqual({ cohort: 2, retained: 1, rate: 0.5 });
  });
});

describe("POST /v1/feedback", () => {
  it("records an answer and an optional comment", async () => {
    expect((await json("/v1/feedback", { useful: true, comment: " Saves me time ", installId: freshId(), version: "0.1.8" })).status).toBe(200);
    expect((await json("/v1/feedback", { useful: false })).status).toBe(200);

    const s = await stats();
    expect(s.feedback.useful).toBe(1);
    expect(s.feedback.notUseful).toBe(1);
    expect(s.feedback.recent.map((r) => r.comment)).toContain("Saves me time");
  });

  it("rejects a missing answer and an overlong comment", async () => {
    expect((await json("/v1/feedback", {})).status).toBe(400);
    expect((await json("/v1/feedback", { useful: "yes" })).status).toBe(400);
    const long = "x".repeat(limits.insights.feedbackCommentMaxChars + 1);
    expect((await json("/v1/feedback", { useful: true, comment: long })).status).toBe(413);
  });

  it("stops at the per-IP daily cap with 429", async () => {
    for (let i = 0; i < limits.insights.feedbackPerIpPerDay; i++) {
      expect((await json("/v1/feedback", { useful: true })).status).toBe(200);
    }
    expect((await json("/v1/feedback", { useful: true })).status).toBe(429);
  });
});

describe("the mailing list", () => {
  function tokenFrom(text: string): string {
    const match = /confirm\?token=([^\s&]+)/.exec(text);
    expect(match).not.toBeNull();
    return decodeURIComponent(match![1]!);
  }

  it("double opt-in: pending until the emailed link is followed", async () => {
    const sent = captureEmail();
    const response = await json("/v1/subscribe", { email: " Reader@Example.com ", source: "onboarding" });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("reader@example.com");
    expect(sent[0]!.text).toContain("https://api.hopshot.xyz/v1/subscribe/unsubscribe?token=");
    expect((await stats()).subscribers).toEqual({ confirmed: 0, pending: 1, unsubscribed: 0 });

    const confirm = await send(`/v1/subscribe/confirm?token=${encodeURIComponent(tokenFrom(sent[0]!.text))}`);
    expect(confirm.status).toBe(303);
    expect(confirm.headers.get("Location")).toBe("https://hopshot.xyz/subscribed?status=confirmed");
    expect((await stats()).subscribers.confirmed).toBe(1);

    const list = await send("/v1/admin/subscribers", { headers: ADMIN });
    expect(await list.json()).toEqual([
      expect.objectContaining({ email: "reader@example.com", source: "onboarding" }),
    ]);
  });

  /** Nobody can use the endpoint to learn whether an address is on the list. */
  it("answers the same for a new and an already-confirmed address, and mails only the new", async () => {
    const sent = captureEmail();
    await json("/v1/subscribe", { email: "a@example.com" });
    await send(`/v1/subscribe/confirm?token=${encodeURIComponent(tokenFrom(sent[0]!.text))}`);

    const again = await json("/v1/subscribe", { email: "a@example.com" });
    const fresh = await json("/v1/subscribe", { email: "b@example.com" });
    expect(again.status).toBe(fresh.status);
    expect(await again.json()).toEqual(await fresh.json());
    expect(sent.map((m) => m.to)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("unsubscribes in one click and a stale or unknown link changes nothing", async () => {
    const sent = captureEmail();
    await json("/v1/subscribe", { email: "c@example.com" });
    const token = encodeURIComponent(tokenFrom(sent[0]!.text));

    const out = await send(`/v1/subscribe/unsubscribe?token=${token}`);
    expect(out.headers.get("Location")).toBe("https://hopshot.xyz/subscribed?status=unsubscribed");
    // Following the old confirm link after leaving must not put them back on the list.
    await send(`/v1/subscribe/confirm?token=${token}`);
    expect((await stats()).subscribers).toEqual({ confirmed: 0, pending: 0, unsubscribed: 1 });

    const bogus = await send("/v1/subscribe/confirm?token=not-a-real-token");
    expect(bogus.headers.get("Location")).toBe("https://hopshot.xyz/subscribed?status=invalid");
  });

  it("rejects an invalid address and stops at the per-IP cap", async () => {
    expect((await json("/v1/subscribe", { email: "not an email" })).status).toBe(400);
    expect((await json("/v1/subscribe", {})).status).toBe(400);
    for (let i = 0; i < limits.insights.subscribesPerIpPerDay; i++) {
      expect((await json("/v1/subscribe", { email: `n${i}@example.com` })).status).toBe(200);
    }
    expect((await json("/v1/subscribe", { email: "late@example.com" })).status).toBe(429);
  });
});

describe("the admin gate", () => {
  it("is a 404 without the token, with a wrong one, and with no secret configured", async () => {
    expect((await send("/v1/admin/stats")).status).toBe(404);
    expect((await send("/v1/admin/stats", { headers: { Authorization: "Bearer nope" } })).status).toBe(404);
    expect((await send("/v1/admin/subscribers")).status).toBe(404);

    const vars = env as unknown as Record<string, string | undefined>;
    const saved = vars.ADMIN_TOKEN;
    delete vars.ADMIN_TOKEN;
    try {
      expect((await send("/v1/admin/stats", { headers: ADMIN })).status).toBe(404);
    } finally {
      vars.ADMIN_TOKEN = saved;
    }
  });
});

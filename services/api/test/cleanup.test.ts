import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sweep } from "../src/lib/cleanup.ts";
import { applyMigrations, freshId, post, runCron, send } from "./helpers.ts";

/**
 * The 15-minute retention cron (ARCHITECTURE §7.8).
 *
 * The thing worth testing is that the R2 object goes with the row — a sweep that deletes
 * rows only would leave blobs paying for storage with no pointer to them.
 */

beforeEach(applyMigrations);

async function expire(id: string): Promise<void> {
  await env.DB.prepare("UPDATE drops SET expires_at = ?2 WHERE id = ?1")
    .bind(id, Date.now() - 1000)
    .run();
}

describe("retention sweep", () => {
  it("removes expired rows and their R2 objects", async () => {
    const expired = freshId();
    const live = freshId();
    await post(`/v1/drops/${expired}`, new Uint8Array([1]));
    await post(`/v1/drops/${live}`, new Uint8Array([2]), { "X-Hopshot-Install": "other" });
    await expire(expired);

    const swept = await sweep(env);
    expect(swept.drops).toBe(1);

    expect(await env.BUCKET.get(`d/${expired}`)).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM drops WHERE id = ?1").bind(expired).first(),
    ).toBeNull();

    // The live one is untouched.
    expect(await env.BUCKET.get(`d/${live}`)).not.toBeNull();
    expect((await send(`/v1/drops/${live}`)).status).toBe(200);
  });

  it("reclaims rows a DELETE marked, so deleted drops do not linger", async () => {
    const id = freshId();
    const created = await post(`/v1/drops/${id}`, new Uint8Array([1]));
    const { deleteToken } = await created.json<{ deleteToken: string }>();

    await send(`/v1/drops/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${deleteToken}` },
    });

    // The row survives the DELETE so a repeat is not a 404…
    expect(
      await env.DB.prepare("SELECT id FROM drops WHERE id = ?1").bind(id).first(),
    ).not.toBeNull();

    // …and the sweep is what finally reclaims it.
    const swept = await sweep(env);
    expect(swept.drops).toBe(1);
    expect(
      await env.DB.prepare("SELECT id FROM drops WHERE id = ?1").bind(id).first(),
    ).toBeNull();
  });

  it("deletes used or expired invites", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO invites (code_hash, vault_id, created_by, expires_at, used_at)
       VALUES ('used', 'v1', 'd1', ?1, ?2), ('stale', 'v1', 'd1', ?3, NULL),
              ('fresh', 'v1', 'd1', ?1, NULL)`,
    )
      .bind(now + 600_000, now, now - 1000)
      .run();

    const swept = await sweep(env);
    expect(swept.invites).toBe(2);

    const left = await env.DB.prepare("SELECT code_hash FROM invites").all<{ code_hash: string }>();
    expect(left.results?.map((r) => r.code_hash)).toEqual(["fresh"]);
  });

  it("drops usage rows older than 7 days", async () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    const recent = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    await env.DB.prepare(
      "INSERT INTO usage (day, subject, kind, count, bytes) VALUES (?1,'a','drops',1,1), (?2,'a','drops',1,1)",
    )
      .bind(old, recent)
      .run();

    const swept = await sweep(env);
    expect(swept.usageRows).toBe(1);

    const left = await env.DB.prepare("SELECT day FROM usage").all<{ day: string }>();
    expect(left.results?.map((r) => r.day)).toEqual([recent]);
  });

  it("is quiet when there is nothing to do", async () => {
    expect(await sweep(env)).toEqual({
      drops: 0,
      items: 0,
      invites: 0,
      usageRows: 0,
      tickets: 0,
      pairAttempts: 0,
    });
  });

  it("runs from the scheduled handler on the 15-minute trigger", async () => {
    const id = freshId();
    await post(`/v1/drops/${id}`, new Uint8Array([1]));
    await expire(id);

    await runCron("*/15 * * * *");

    expect(await env.BUCKET.get(`d/${id}`)).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM drops WHERE id = ?1").bind(id).first(),
    ).toBeNull();
  });

  it("leaves drops alone on the daily trigger", async () => {
    const id = freshId();
    await post(`/v1/drops/${id}`, new Uint8Array([1]));
    await expire(id);

    await runCron("0 9 * * *");

    // The daily cron is renewal emails (Phase 4), not retention.
    expect(await env.BUCKET.get(`d/${id}`)).not.toBeNull();
  });
});

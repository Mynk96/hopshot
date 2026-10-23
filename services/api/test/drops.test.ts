import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { limits } from "shared";
import worker from "../src/index.ts";
import { claimDeviceSlot, recordPurchase } from "../src/lib/license.ts";
import { applyMigrations, freshId, post, send, startTrial } from "./helpers.ts";

/**
 * Drops routes (ARCHITECTURE §7.1) and the limits from §7.9.
 *
 * CLAUDE.md rule 8: every API route gets happy path + limit + auth + expired.
 */

beforeEach(async () => {
  await applyMigrations();
  // A real first-launch user is on the 7-day trial. Before licensing existed, resolvePlan
  // returned "lifetime" for everyone, so these tests never needed one.
  await startTrial();
});

describe("POST /v1/drops/:id", () => {
  it("stores the ciphertext and returns a delete token", async () => {
    const id = freshId();
    const body = new Uint8Array([0x48, 0x4f, 0x50, 0x31, 1, 2, 3]);

    const response = await post(`/v1/drops/${id}?ttl=24h`, body);
    expect(response.status).toBe(201);

    const json = await response.json<{ id: string; deleteToken: string; expiresAt: number }>();
    expect(json.id).toBe(id);
    expect(json.deleteToken).toHaveLength(43);
    expect(json.expiresAt).toBeGreaterThan(Date.now());

    // The object really is in R2, byte for byte.
    const stored = await env.BUCKET.get(`d/${id}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(body);

    // The token is only ever stored hashed (ARCHITECTURE §7).
    const row = await env.DB.prepare("SELECT delete_token_hash, plan FROM drops WHERE id = ?1")
      .bind(id)
      .first<{ delete_token_hash: string; plan: string }>();
    expect(row!.delete_token_hash).not.toBe(json.deleteToken);
    expect(row!.delete_token_hash).toHaveLength(64);
    // The trial includes everything (limits.trial.includes === "sync").
    expect(row!.plan).toBe("trial");
  });

  it("rejects an id that is not 22-char base62", async () => {
    const response = await post("/v1/drops/not-an-id", new Uint8Array([1]));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("rejects a body over maxCiphertextBytes with 413", async () => {
    const id = freshId();
    const oversize = new Uint8Array(limits.server.maxCiphertextBytes + 1);

    const response = await post(`/v1/drops/${id}`, oversize);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "too_large" } });

    // Nothing was written.
    expect(await env.BUCKET.get(`d/${id}`)).toBeNull();
  });

  it("refuses a TTL the plan does not allow with 403", async () => {
    /*
     * These tests run on a trial, and `limits.trial.includes === "sync"` — so 7d, which
     * Lifetime does not offer, *is* allowed here. The guard is still worth testing, so this
     * uses a TTL no plan offers at all.
     */
    expect(limits.sync.dropTtlOptions).not.toContain("30d");
    expect(limits.lifetime.dropTtlOptions).not.toContain("30d");

    const response = await post(`/v1/drops/${freshId()}?ttl=30d`, new Uint8Array([1]));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  /** A Lifetime-only buyer must not get Sync's longer links (config/limits.json). */
  it("refuses a Sync-only TTL on a Lifetime licence", async () => {
    const licenseId = await recordPurchase(env, {
      customerId: "cus_ttl",
      email: "lifetime@example.com",
      plan: "lifetime",
      sessionId: "cs_ttl",
      paymentIntentId: "pi_ttl",
    });
    const slot = await claimDeviceSlot(env, licenseId, "install-lifetime", "PC");
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;

    expect(limits.lifetime.dropTtlOptions).not.toContain("7d");

    const response = await send(`/v1/drops/${freshId()}?ttl=7d`, {
      method: "POST",
      headers: {
        // A different install, so the trial above does not apply.
        "X-Hopshot-Install": "install-lifetime",
        "X-Hopshot-License": slot.deviceToken,
        "Content-Type": "application/octet-stream",
        "CF-Connecting-IP": "203.0.113.5",
      },
      body: new Uint8Array([1]),
    });
    expect(response.status).toBe(403);
  });

  it("stops at the daily cap with 429", async () => {
    const install = "install-cap";
    await startTrial(install);

    // A trial gets the Sync cap (limits.trial.includes === "sync").
    const cap = limits.sync.dropsPerDay;

    /*
     * Seeded rather than looped. Two reasons: `perIpDropsPerDay` is 100, so sending 200 from
     * one address would trip the *network* cap first and test the wrong thing; and 200 real
     * uploads is a slow test for no extra coverage.
     */
    await env.DB.prepare(
      "INSERT INTO usage (day, subject, kind, count, bytes) VALUES (?1, ?2, 'drops', ?3, 0)",
    )
      .bind(new Date().toISOString().slice(0, 10), install, cap - 1)
      .run();

    // The last one inside the cap still goes through.
    const allowed = await post(`/v1/drops/${freshId()}`, new Uint8Array([1]), {
      "X-Hopshot-Install": install,
      "CF-Connecting-IP": "198.51.100.20",
    });
    expect(allowed.status).toBe(201);

    const blocked = await post(`/v1/drops/${freshId()}`, new Uint8Array([1]), {
      "X-Hopshot-Install": install,
      "CF-Connecting-IP": "198.51.100.20",
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain(String(cap));
  });

  it("needs an install id", async () => {
    const response = await send(`/v1/drops/${freshId()}`, {
      method: "POST",
      body: new Uint8Array([1]),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a duplicate id with 409", async () => {
    const id = freshId();
    expect((await post(`/v1/drops/${id}`, new Uint8Array([1]))).status).toBe(201);

    const second = await post(`/v1/drops/${id}`, new Uint8Array([2]));
    expect(second.status).toBe(409);

    // The original is untouched.
    const stored = await env.BUCKET.get(`d/${id}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array([1]));
  });

  it("never stores a raw IP", async () => {
    const id = freshId();
    await post(`/v1/drops/${id}`, new Uint8Array([1]), { "CF-Connecting-IP": "198.51.100.7" });

    const row = await env.DB.prepare("SELECT ip_hash FROM drops WHERE id = ?1")
      .bind(id)
      .first<{ ip_hash: string }>();

    expect(row!.ip_hash).toHaveLength(64);
    expect(row!.ip_hash).not.toContain("198.51.100.7");
  });
});

describe("GET /v1/drops/:id", () => {
  it("returns the ciphertext with no-store", async () => {
    const id = freshId();
    const body = new Uint8Array([9, 8, 7, 6]);
    await post(`/v1/drops/${id}`, body);

    const response = await send(`/v1/drops/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it("counts a view", async () => {
    const id = freshId();
    await post(`/v1/drops/${id}`, new Uint8Array([1]));
    await send(`/v1/drops/${id}`);

    const row = await env.DB.prepare("SELECT view_count FROM drops WHERE id = ?1")
      .bind(id)
      .first<{ view_count: number }>();
    expect(row!.view_count).toBe(1);
  });

  it("404s an unknown id", async () => {
    const response = await send(`/v1/drops/${freshId()}`);
    expect(response.status).toBe(404);
  });

  it("410s an expired drop", async () => {
    const id = freshId();
    await post(`/v1/drops/${id}`, new Uint8Array([1]));

    // Reach into the row rather than waiting 24 hours.
    await env.DB.prepare("UPDATE drops SET expires_at = ?2 WHERE id = ?1")
      .bind(id, Date.now() - 1000)
      .run();

    const response = await send(`/v1/drops/${id}`);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "gone" } });
  });

  it("serves info for the viewer countdown", async () => {
    const id = freshId();
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await post(`/v1/drops/${id}`, body);

    const response = await send(`/v1/drops/${id}/info`);
    expect(response.status).toBe(200);

    const json = await response.json<{ expiresAt: number; size: number }>();
    expect(json.size).toBe(body.length);
    expect(json.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("DELETE /v1/drops/:id", () => {
  it("deletes with the right token", async () => {
    const id = freshId();
    const created = await post(`/v1/drops/${id}`, new Uint8Array([1]));
    const { deleteToken } = await created.json<{ deleteToken: string }>();

    const response = await send(`/v1/drops/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${deleteToken}` },
    });
    expect(response.status).toBe(204);

    expect(await env.BUCKET.get(`d/${id}`)).toBeNull();
    expect((await send(`/v1/drops/${id}`)).status).toBe(410);
  });

  it("refuses the wrong token", async () => {
    const id = freshId();
    await post(`/v1/drops/${id}`, new Uint8Array([1]));

    const response = await send(`/v1/drops/${id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer not-the-token" },
    });
    expect(response.status).toBe(401);

    // The object survives a failed delete.
    expect(await env.BUCKET.get(`d/${id}`)).not.toBeNull();
  });

  it("refuses with no token at all", async () => {
    const id = freshId();
    await post(`/v1/drops/${id}`, new Uint8Array([1]));

    expect((await send(`/v1/drops/${id}`, { method: "DELETE" })).status).toBe(401);
  });
});

describe("POST /v1/report", () => {
  it("stores a report", async () => {
    const id = freshId();
    const response = await send("/v1/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dropId: id, reason: "not mine" }),
    });

    expect(response.status).toBe(202);

    const row = await env.DB.prepare("SELECT drop_id, reason FROM reports WHERE drop_id = ?1")
      .bind(id)
      .first<{ drop_id: string; reason: string }>();
    expect(row).toMatchObject({ drop_id: id, reason: "not mine" });
  });

  it("rejects a bad drop id", async () => {
    const response = await send("/v1/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dropId: "nope" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("/health", () => {
  it("answers on both paths", async () => {
    for (const path of ["/health", "/v1/health"]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`https://api.hopshot.xyz${path}`),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
  });
});

describe("CORS", () => {
  // The viewer is on a different origin than the API, so this is load-bearing: without it
  // the browser blocks the fetch and the viewer reports a decrypt failure instead.
  it("allows the viewer origin and exposes the metadata header", async () => {
    const response = await send(`/v1/drops/${freshId()}/info`, {
      headers: { Origin: "https://hopshot.xyz" },
    });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://hopshot.xyz");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Hopshot-Meta");
  });

  it("answers the preflight for an upload", async () => {
    const response = await send(`/v1/drops/${freshId()}`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://hopshot.xyz",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-hopshot-install",
      },
    });

    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Hopshot-Install");
  });

  it("does not hand its headers to an unknown origin", async () => {
    const response = await send(`/v1/drops/${freshId()}/info`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("CORS origin allowlist", () => {
  const ask = (origin: string) =>
    send(`/v1/drops/${freshId()}/info`, { headers: { Origin: origin } }).then((r) =>
      r.headers.get("Access-Control-Allow-Origin"),
    );

  it("allows production and this project's own staging hosts", async () => {
    for (const origin of [
      "https://hopshot.xyz",
      "https://hopshot-api.mayank-harsani.workers.dev",
      "https://hopshot-web.pages.dev",
      "https://feature-branch.hopshot-web.pages.dev",
    ]) {
      expect(await ask(origin), origin).toBe(origin);
    }
  });

  // `*.pages.dev` is not account-namespaced: anyone can deploy there. A bare wildcard
  // would let an attacker's page spend this quota from its visitors' browsers.
  it("refuses pages.dev sites that are not this project", async () => {
    for (const origin of [
      "https://evil.pages.dev",
      "https://totally-evil.pages.dev",
      "https://hopshot-web.evil.pages.dev",
      "https://hopshot-web.evil.com",
      "https://evil.someoneelse.workers.dev",
      "https://attacker.example",
    ]) {
      expect(await ask(origin), origin).toBeNull();
    }
  });
});

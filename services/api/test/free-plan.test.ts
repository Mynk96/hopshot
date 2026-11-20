import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { limits, type PlanName } from "shared";

import { planForDeviceToken, revokeByPaymentIntent } from "../src/lib/license.ts";
import { limitsFor, resolvePlan, vaultLimitsFor } from "../src/lib/plan.ts";
import { applyMigrations, freshId, send, licenseInstall } from "./helpers.ts";

/**
 * The Free plan (docs/designs/free-plan.md): an install with no licence — plan `expired` on
 * the wire — gets a few QR sends a day and no vault. Paid plans are unchanged.
 *
 * CLAUDE.md rule 8: happy path + limit + auth + expired.
 */

const HOP1 = new Uint8Array([0x48, 0x4f, 0x50, 0x31, 1, 2, 3]);
const today = () => new Date().toISOString().slice(0, 10);

/** A send from an install that has never bought anything: no `X-Hopshot-License`. */
function freeSend(
  id: string,
  {
    ttl = "24h",
    install = "install-free",
    ip = "203.0.113.40",
    license,
  }: {
    ttl?: string;
    install?: string;
    ip?: string;
    license?: string;
  } = {},
): Promise<Response> {
  return send(`/v1/drops/${id}?ttl=${ttl}`, {
    method: "POST",
    headers: {
      "X-Hopshot-Install": install,
      ...(license ? { "X-Hopshot-License": license } : {}),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(HOP1.byteLength),
      "CF-Connecting-IP": ip,
    },
    body: HOP1,
  });
}

beforeEach(async () => {
  await applyMigrations();
});

describe("Free plan limits (config/limits.json)", () => {
  it("are what the design note promises", () => {
    expect(limits.free.dropsPerDay).toBe(3);
    expect(limits.free.dropTtlOptions).toEqual(["24h"]);
    expect(limits.free.vault).toBe(false);
    expect(limits.free.capturesPerDay).toBe(10);
    expect(limits.free.maxPins).toBe(3);
    expect(limits.server.freePerIpDropsPerDay).toBeGreaterThan(limits.free.dropsPerDay);
  });

  it("map an install with no licence onto the free caps", async () => {
    const request = new Request("https://api.hopshot.xyz/v1/drops/x", {
      headers: { "X-Hopshot-Install": "install-free" },
    });
    const plan = await resolvePlan(request, env);
    expect(plan).toBe("expired");
    expect(limitsFor(plan).dropsPerDay).toBe(limits.free.dropsPerDay);
    expect(vaultLimitsFor(plan).vault).toBe(false);
    expect(vaultLimitsFor(plan).maxPhones).toBe(0);
  });

  it("deny a plan name the code does not know (deny by default)", () => {
    const unknown = "platinum" as PlanName;
    expect(limitsFor(unknown).dropsPerDay).toBe(0);
    expect(vaultLimitsFor(unknown).vault).toBe(false);
    expect(vaultLimitsFor(unknown).uploadsPerDay).toBe(0);
  });
});

describe("POST /v1/drops/:id on the Free plan", () => {
  it("sends a 24h drop with no licence and records it as free", async () => {
    const id = freshId();
    const response = await freeSend(id);
    expect(response.status).toBe(201);

    const row = await env.DB.prepare("SELECT plan FROM drops WHERE id = ?1")
      .bind(id)
      .first<{ plan: string }>();
    expect(row!.plan).toBe("expired");

    // The viewer learns only that it was a free send, for the small "Sent with Hopshot" link.
    const info = await send(`/v1/drops/${id}/info`);
    expect(await info.json()).toMatchObject({ free: true });
  });

  it("refuses a longer link than the free plan offers", async () => {
    expect(limits.free.dropTtlOptions).not.toContain("7d");
    const response = await freeSend(freshId(), { ttl: "7d" });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(limits.pricing.display);
  });

  it("stops at the free daily cap with 429 and offers the upgrade", async () => {
    const install = "install-free-cap";
    await env.DB.prepare(
      "INSERT INTO usage (day, subject, kind, count, bytes) VALUES (?1, ?2, 'drops', ?3, 0)",
    )
      .bind(today(), install, limits.free.dropsPerDay - 1)
      .run();

    expect((await freeSend(freshId(), { install })).status).toBe(201);

    const blocked = await freeSend(freshId(), { install });
    expect(blocked.status).toBe(429);
    const text = await blocked.text();
    expect(text).toContain(`${limits.free.dropsPerDay} free sends`);
    expect(text).toContain(limits.pricing.display);
  });

  /** Install ids are client-made, so the network cap is what really bounds free sends. */
  it("caps free sends per network, so new install ids don't reset the limit", async () => {
    const ip = "198.51.100.77";
    for (let n = 0; n < limits.server.freePerIpDropsPerDay; n += 1) {
      // A fresh install each time: only the per-network cap can stop this.
      const response = await freeSend(freshId(), { install: `install-mint-${n}`, ip });
      expect(response.status).toBe(201);
    }

    const blocked = await freeSend(freshId(), { install: "install-mint-next", ip });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("free sends");
  });

  it("does not count paid sends against the free network cap", async () => {
    const ip = "198.51.100.78";
    const token = await licenseInstall("install-paid-same-net");
    for (let n = 0; n < limits.server.freePerIpDropsPerDay; n += 1) {
      await freeSend(freshId(), { install: `install-net-${n}`, ip });
    }
    // The network is out of free sends, but a paying install on it still sends.
    const paid = await freeSend(freshId(), {
      install: "install-paid-same-net",
      ip,
      license: token,
    });
    expect(paid.status).toBe(201);
  });

  it("treats a refunded licence as Free, not locked", async () => {
    const token = await licenseInstall("install-refunded");
    expect(await planForDeviceToken(env, token)).toBe("sync");

    await revokeByPaymentIntent(env, "pi_install-refunded", "refunded");
    expect(await planForDeviceToken(env, token)).toBe("expired");

    // Free sends still work, at the free lifetime only.
    expect(
      (await freeSend(freshId(), { install: "install-refunded", license: token })).status,
    ).toBe(201);
    expect(
      (await freeSend(freshId(), { install: "install-refunded", license: token, ttl: "7d" }))
        .status,
    ).toBe(403);
  });
});

describe("Paid plans are unchanged", () => {
  it("still mark their drops as not free", async () => {
    const token = await licenseInstall("install-paid");
    const id = freshId();
    expect((await freeSend(id, { install: "install-paid", license: token })).status).toBe(201);

    const info = await send(`/v1/drops/${id}/info`);
    expect(await info.json()).toMatchObject({ free: false });
  });
});

describe("POST /v1/vaults on the Free plan", () => {
  it("refuses to create a vault: a paired phone is paid", async () => {
    const response = await send("/v1/vaults", {
      method: "POST",
      headers: {
        "X-Hopshot-Install": "install-free-vault",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.41",
      },
      body: JSON.stringify({ deviceName: "Free PC", kind: "desktop" }),
    });
    expect(response.status).toBe(403);
  });
});

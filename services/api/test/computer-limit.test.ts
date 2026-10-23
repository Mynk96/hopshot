import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { limits } from "shared";

import { sha256Hex } from "../src/lib/ids.ts";
import {
  claimDeviceSlot,
  computerLimit,
  licenseById,
  planForDeviceToken,
  recordPurchase,
} from "../src/lib/license.ts";
import { vaultLimitsFor } from "../src/lib/plan.ts";
import { applyMigrations, send } from "./helpers.ts";

/**
 * The computer limit (PRD F8.3, ARCHITECTURE §7.5).
 *
 * One computer on Lifetime, three while Sync is active. The hard part is not the cap but what
 * happens when it *drops* — a bundle's included Sync year running out can leave a licence
 * holding more slots than it is now allowed, and the app must not simply lock everyone out.
 */

beforeEach(applyMigrations);

async function buy(
  plan: "lifetime" | "bundle",
  createdAt = Date.now(),
  customer = "cus_limit",
): Promise<string> {
  const id = await recordPurchase(env, {
    customerId: customer,
    email: `${customer}@example.com`,
    plan,
    sessionId: `cs_${plan}_${Math.random()}`,
    paymentIntentId: `pi_${plan}_${customer}`,
  });
  // `created_at` is what decides whether the bundle's Sync year is still running.
  await env.DB.prepare("UPDATE licenses SET created_at = ?2 WHERE id = ?1")
    .bind(id, createdAt)
    .run();
  return id;
}

type Status = {
  valid: boolean;
  reason?: string;
  plan: string;
  limit?: number;
  devices?: { id: string; isSelf: boolean; label: string }[];
};

async function statusOf(token: string): Promise<Status> {
  const response = await send("/v1/license/status", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.json<Status>();
}

describe("the cap itself", () => {
  it("Lifetime allows one computer and prompts to move for a second", async () => {
    expect(limits.lifetime.maxComputers).toBe(1);
    const id = await buy("lifetime");

    expect((await claimDeviceSlot(env, id, "install-a", "PC A")).ok).toBe(true);

    const second = await claimDeviceSlot(env, id, "install-b", "PC B");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // The UI needs to name the machine it would be moved from (DESIGN S9).
      expect(second.computers).toHaveLength(1);
      expect(second.computers[0]!.label).toBe("PC A");
    }
  });

  it("the bundle allows three and prompts on the fourth", async () => {
    const id = await buy("bundle");

    for (let n = 0; n < limits.sync.maxComputers; n++) {
      expect((await claimDeviceSlot(env, id, `install-${n}`, `PC ${n}`)).ok).toBe(true);
    }

    const fourth = await claimDeviceSlot(env, id, "install-extra", "One too many");
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.computers).toHaveLength(limits.sync.maxComputers);
  });

  /** A failed card should not take someone's computers away the same afternoon. */
  it("keeps the Sync limit while past_due but inside the grace period", async () => {
    const id = await buy("lifetime");
    const device = await claimDeviceSlot(env, id, "install-a", "PC A");
    expect(device.ok).toBe(true);
    if (!device.ok) return;

    await env.DB.prepare(
      `INSERT INTO subscriptions (stripe_subscription_id, customer_id, status,
                                  past_due_since, updated_at)
       VALUES ('sub_pd', 'cus_limit', 'past_due', ?1, ?1)`,
    )
      .bind(Date.now() - 2 * 86_400_000)
      .run();

    expect((await statusOf(device.deviceToken)).limit).toBe(limits.sync.maxComputers);

    await env.DB.prepare(
      "UPDATE subscriptions SET past_due_since = ?1 WHERE stripe_subscription_id = 'sub_pd'",
    )
      .bind(Date.now() - (limits.sync.paymentGraceDays + 2) * 86_400_000)
      .run();

    expect((await statusOf(device.deviceToken)).limit).toBe(limits.lifetime.maxComputers);
  });

  /** The 30-day dormant-slot reclaim has to keep working alongside the new limit. */
  it("still reclaims a slot nobody has used for the grace period", async () => {
    const id = await buy("lifetime");
    expect((await claimDeviceSlot(env, id, "install-a", "PC A")).ok).toBe(true);

    const dormant = Date.now() - (limits.server.licenseOfflineGraceDays + 1) * 86_400_000;
    await env.DB.prepare(
      "UPDATE license_devices SET last_seen_at = ?1 WHERE install_id = 'install-a'",
    )
      .bind(dormant)
      .run();

    // Nobody has to be prompted: the old machine has not been seen in a month.
    expect((await claimDeviceSlot(env, id, "install-b", "PC B")).ok).toBe(true);
  });
});

describe("when the limit drops", () => {
  /**
   * The bundle's Sync year ending takes the licence from three computers to one. The most
   * recently seen device keeps working and the others are told `over_limit` with the list,
   * so the user chooses rather than us picking a victim.
   */
  it("leaves only the most recently seen device valid", async () => {
    const lastYear = Date.now() - 400 * 86_400_000;
    const id = await buy("bundle", lastYear);

    const a = await claimDeviceSlot(env, id, "install-a", "PC A", lastYear);
    const b = await claimDeviceSlot(env, id, "install-b", "PC B", lastYear + 1000);
    const c = await claimDeviceSlot(env, id, "install-c", "PC C", lastYear + 2000);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;

    // C is unambiguously the most recent.
    await env.DB.prepare(
      "UPDATE license_devices SET last_seen_at = ?1 WHERE install_id = 'install-c'",
    )
      .bind(Date.now())
      .run();

    const newest = await statusOf(c.deviceToken);
    expect(newest.valid).toBe(true);
    // Sync has lapsed, so the bundle is plain Lifetime now.
    expect(newest.plan).toBe("lifetime");
    expect(newest.limit).toBe(1);

    for (const stale of [a.deviceToken, b.deviceToken]) {
      const status = await statusOf(stale);
      expect(status.valid).toBe(false);
      expect(status.reason).toBe("over_limit");
      expect(status.devices).toHaveLength(3);
      // The chooser has to know which row is the machine it is looking from.
      expect(status.devices!.some((device) => device.isSelf)).toBe(true);
    }
  });

  /** An over-limit device must not win its slot back just by checking in. */
  it("does not let an over-limit device refresh itself into validity", async () => {
    const lastYear = Date.now() - 400 * 86_400_000;
    const id = await buy("bundle", lastYear);

    const a = await claimDeviceSlot(env, id, "install-a", "PC A", lastYear);
    const b = await claimDeviceSlot(env, id, "install-b", "PC B", lastYear + 5000);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // A polls repeatedly; B is newer and must stay the valid one.
    for (let n = 0; n < 3; n++) {
      expect((await statusOf(a.deviceToken)).valid).toBe(false);
    }
    expect((await statusOf(b.deviceToken)).valid).toBe(true);

    // And the plan resolver agrees, so an over-limit machine cannot still send drops.
    expect(await planForDeviceToken(env, a.deviceToken)).toBe("expired");
    expect(await planForDeviceToken(env, b.deviceToken)).toBe("lifetime");
  });

  it("renewing Sync re-licenses the other computers", async () => {
    const lastYear = Date.now() - 400 * 86_400_000;
    const id = await buy("bundle", lastYear);

    const a = await claimDeviceSlot(env, id, "install-a", "PC A", lastYear);
    const b = await claimDeviceSlot(env, id, "install-b", "PC B", lastYear + 5000);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect((await statusOf(a.deviceToken)).valid).toBe(false);

    await env.DB.prepare(
      `INSERT INTO subscriptions (stripe_subscription_id, customer_id, status, updated_at)
       VALUES ('sub_1', 'cus_limit', 'active', ?1)`,
    )
      .bind(Date.now())
      .run();

    const renewed = await statusOf(a.deviceToken);
    expect(renewed.valid).toBe(true);
    expect(renewed.plan).toBe("sync");
    expect(renewed.limit).toBe(limits.sync.maxComputers);
  });
});

describe("POST /v1/license/move-here (DESIGN S9)", () => {
  /** Put a second device on a licence directly, as an over-limit machine would be. */
  async function addDevice(licenseId: string, token: string, lastSeen: number): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO license_devices (id, license_id, install_id, label, token_hash,
                                    created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    )
      .bind(`dev-${token}`, licenseId, `install-${token}`, `PC ${token}`, await sha256Hex(token), lastSeen)
      .run();
  }

  it("frees the chosen computer and licenses this one", async () => {
    const id = await buy("lifetime", Date.now(), "cus_move");

    const a = await claimDeviceSlot(env, id, "install-a", "PC A");
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // B exists but is older, so it is over the limit — the state the UI acts from.
    await addDevice(id, "token-b", Date.now() - 5000);

    const overLimit = await statusOf("token-b");
    expect(overLimit.valid).toBe(false);
    expect(overLimit.reason).toBe("over_limit");

    const other = overLimit.devices!.find((device) => !device.isSelf)!;

    const moved = await send("/v1/license/move-here", {
      method: "POST",
      headers: { Authorization: "Bearer token-b", "Content-Type": "application/json" },
      body: JSON.stringify({ releaseDeviceId: other.id }),
    });
    expect(moved.status).toBe(200);
    expect((await moved.json<{ valid: boolean }>()).valid).toBe(true);

    // The computer it moved away from stops working.
    expect(await planForDeviceToken(env, a.deviceToken)).toBe("expired");
  });

  it("refuses to release a device on another licence", async () => {
    const mine = await buy("lifetime", Date.now(), "cus_mine");
    const slot = await claimDeviceSlot(env, mine, "install-mine", "Mine");
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;

    const response = await send("/v1/license/move-here", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slot.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ releaseDeviceId: "a-stranger-device-id" }),
    });
    expect(response.status).toBe(404);
  });

  it("refuses to release itself", async () => {
    const id = await buy("lifetime", Date.now(), "cus_self");
    const slot = await claimDeviceSlot(env, id, "install-a", "PC A");
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;

    const self = await env.DB.prepare(
      "SELECT id FROM license_devices WHERE install_id = 'install-a'",
    ).first<{ id: string }>();

    const response = await send("/v1/license/move-here", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slot.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ releaseDeviceId: self!.id }),
    });
    expect(response.status).toBe(400);
  });

  it("needs a token", async () => {
    const response = await send("/v1/license/move-here", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseDeviceId: "x" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("the two limit paths agree", () => {
  /**
   * `computerLimit` reads the licence; `vaultLimitsFor` reads the plan name. They must give
   * the same answer, or the desktop cap in routes/pair.ts would disagree with the slot
   * allocator in lib/license.ts and a user would be refused by one and allowed by the other.
   */
  it("vaultLimitsFor matches computerLimit for both plans", async () => {
    const lifetime = (await licenseById(env, await buy("lifetime", Date.now(), "cus_l")))!;
    const bundle = (await licenseById(env, await buy("bundle", Date.now(), "cus_b")))!;

    expect(await computerLimit(env, lifetime)).toBe(vaultLimitsFor("lifetime").maxComputers);
    expect(await computerLimit(env, bundle)).toBe(vaultLimitsFor("sync").maxComputers);
  });
});

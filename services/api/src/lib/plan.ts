import { limits, type PlanName, type Ttl } from "shared";

import { planForDeviceToken } from "./license.ts";

/**
 * Which plan a request is acting under, and what that plan allows (ARCHITECTURE §4, §7.9).
 *
 * Every limit is read from `config/limits.json` — never a literal (CLAUDE.md rule 2).
 */

export type PlanLimits = {
  plan: PlanName;
  dropTtlOptions: readonly Ttl[];
  dropsPerDay: number;
  maxCiphertextBytes: number;
};

/** Trial length in ms, from `limits.json` (never a literal — CLAUDE.md rule 2). */
export const TRIAL_MS = limits.trial.days * 86_400_000;

/**
 * Resolve the caller's plan, from D1 only — never an external call (ARCHITECTURE §7.5), so a
 * Stripe outage cannot lock out paying users.
 *
 * `X-Hopshot-License` is the device token the app stored after buying or restoring.
 */
export async function resolvePlan(request: Request, env: Env): Promise<PlanName> {
  /*
   * Order is §4's: a live trial wins, because `limits.trial.includes === "sync"` and during
   * the trial the user has everything. A licence is checked second, and an absent or revoked
   * one is `expired` — which is what makes a refund actually take the app away.
   */
  const installId = request.headers.get("X-Hopshot-Install");
  if (installId && (await isTrialLive(env, installId))) return "trial";

  const token = request.headers.get("X-Hopshot-License");
  if (token) return planForDeviceToken(env, token);

  return "expired";
}

/**
 * The plan a *vault* operates under (ARCHITECTURE §7.2).
 *
 * Vault routes must not use `resolvePlan`: that reads `X-Hopshot-Install`, and a phone has
 * no install id at all. Resolving a phone's request that way yields `lifetime`, whose
 * `maxPhones` and `uploadsPerDay` are both 0 — so pairing and every phone upload would be
 * refused, taking PRD F4.1 and F4.5 with them.
 *
 * The vault's own `owner` column is the answer instead. It is set at creation and encodes
 * what paid for the vault: `trial:{installId}` during the trial, a license once 4.1 lands.
 */
export async function planForVault(
  env: Env,
  vaultId: string,
  now = Date.now(),
): Promise<PlanName> {
  const row = await env.DB.prepare("SELECT owner FROM vaults WHERE id = ?1")
    .bind(vaultId)
    .first<{ owner: string }>();

  // No vault means nothing to authorise; callers have already 401'd on the token by here.
  if (!row) return "expired";

  /*
   * `owner` records the install that created the vault, which is almost always during the
   * trial. When that trial runs out the vault must *not* simply expire: the owner may have
   * bought Lifetime + Sync in the meantime, and the owner column is not rewritten by a
   * purchase. So a dead trial falls through to the licence that install now holds —
   * otherwise a paying Sync customer loses their phone sync the moment the trial lapses.
   */
  const installId = row.owner.replace(/^(trial|install):/, "");

  if (await isTrialLive(env, installId, now)) return "trial";
  return planForInstall(env, installId);
}

/**
 * The plan an install holds by licence, ignoring the trial.
 *
 * Keyed on `install_id` rather than a token because the caller here is a *phone*, which has
 * neither the licence token nor the install id — only the vault it belongs to.
 */
export async function planForInstall(env: Env, installId: string): Promise<PlanName> {
  const row = await env.DB.prepare(
    `SELECT l.plan AS plan FROM license_devices d
       JOIN licenses l ON l.id = d.license_id
      WHERE d.install_id = ?1 AND d.removed_at IS NULL AND l.status = 'active'
      ORDER BY l.created_at DESC LIMIT 1`,
  )
    .bind(installId)
    .first<{ plan: "lifetime" | "bundle" }>();

  if (!row) return "expired";
  return row.plan === "bundle" ? "sync" : "lifetime";
}

/** Is this install inside its 7-day trial (PRD F8, ARCHITECTURE §7.5)? */
export async function isTrialLive(env: Env, installId: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare("SELECT started_at FROM trials WHERE install_id = ?1")
    .bind(installId)
    .first<{ started_at: number }>();

  return row !== null && now < row.started_at + TRIAL_MS;
}

/**
 * Vault capabilities for a plan (ARCHITECTURE §7.2).
 *
 * `vault` is the gate on `POST /vaults`: §7.2 is "Trial or Sync only", and `limits.json`
 * sets `lifetime.vault = false` / `sync.vault = true`. Lifetime without Sync can still send
 * drops (F3/F5) — it just has no vault to pair a phone into.
 */
export type VaultLimits = {
  vault: boolean;
  maxPhones: number;
  maxComputers: number;
  uploadsPerDay: number;
  itemTtlOptions: readonly Ttl[];
};

export function vaultLimitsFor(plan: PlanName): VaultLimits {
  // Trial includes Sync, so it gets the Sync allowances (limits.trial.includes).
  if (plan === "sync" || plan === "trial") {
    return {
      vault: limits.sync.vault,
      maxPhones: limits.sync.maxPhones,
      maxComputers: limits.sync.maxComputers,
      uploadsPerDay: limits.sync.vaultUploadsPerDay,
      // Vault items follow the Lifetime item options; Sync widens drops, not shelf items.
      itemTtlOptions: limits.lifetime.itemTtlOptions,
    };
  }

  return {
    vault: limits.lifetime.vault,
    maxPhones: 0,
    maxComputers: limits.lifetime.maxComputers,
    uploadsPerDay: 0,
    itemTtlOptions: limits.lifetime.itemTtlOptions,
  };
}

/** Is this TTL allowed for a *vault item* on this plan (ARCHITECTURE §7.3)? */
export function isItemTtlAllowed(ttl: string, plan: PlanName): boolean {
  return (vaultLimitsFor(plan).itemTtlOptions as readonly string[]).includes(ttl);
}

/** The limits that apply to a plan. */
export function limitsFor(plan: PlanName): PlanLimits {
  const server = limits.server;

  // Sync is an add-on to Lifetime, so it raises the caps rather than replacing them.
  if (plan === "sync" || plan === "trial") {
    return {
      plan,
      dropTtlOptions: limits.sync.dropTtlOptions,
      dropsPerDay: limits.sync.dropsPerDay,
      maxCiphertextBytes: server.maxCiphertextBytes,
    };
  }

  return {
    plan,
    dropTtlOptions: limits.lifetime.dropTtlOptions,
    dropsPerDay: limits.lifetime.dropsPerDay,
    maxCiphertextBytes: server.maxCiphertextBytes,
  };
}

/** `"24h"` → milliseconds. Returns `null` for anything not in `limits.json`. */
export function ttlToMs(ttl: string): number | null {
  const match = /^(\d+)([hd])$/.exec(ttl);
  if (!match) return null;

  const amount = Number(match[1]);
  return match[2] === "h" ? amount * 3_600_000 : amount * 86_400_000;
}

/** Is this TTL allowed on this plan (ARCHITECTURE §7.1 "Checks TTL against plan")? */
export function isTtlAllowed(ttl: string, plan: PlanName): boolean {
  return (limitsFor(plan).dropTtlOptions as readonly string[]).includes(ttl);
}

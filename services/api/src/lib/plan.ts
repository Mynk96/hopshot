import { limits, type PlanName, type Ttl } from "shared";

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
 * Resolve the caller's plan, from D1 only — never an external call (ARCHITECTURE §7.5).
 *
 * Order is §4's: expired → trial → lifetime → sync. A live trial wins over `lifetime`
 * because `limits.trial.includes === "sync"`: during the trial the user has everything,
 * and `limitsFor` maps trial onto the Sync caps below.
 *
 * The `lifetime` and `sync` branches read `licenses` / `license_devices` / `subscriptions`
 * and arrive with Phase 4.1 — they need Stripe to populate those tables. Until then a
 * caller with no live trial is treated as `lifetime`, which is what Phase 3.2 assumed and
 * what keeps drops working.
 */
export async function resolvePlan(request: Request, env: Env): Promise<PlanName> {
  const installId = request.headers.get("X-Hopshot-Install");
  if (installId && (await isTrialLive(env, installId))) return "trial";

  // TODO(4.1): read X-Hopshot-License → license_devices → licenses/subscriptions for the
  // real lifetime/sync/expired answer.
  return "lifetime";
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

  const TRIAL_PREFIX = "trial:";
  if (row.owner.startsWith(TRIAL_PREFIX)) {
    const installId = row.owner.slice(TRIAL_PREFIX.length);
    return (await isTrialLive(env, installId, now)) ? "trial" : "expired";
  }

  /*
   * A vault only exists because `POST /vaults` found `vault: true` on the creator's plan,
   * so a non-trial owner is a Sync owner by construction. Phase 4.1 replaces this with a
   * real read of `licenses`/`subscriptions`, which is also what will let Sync lapse (F8.7).
   */
  return "sync";
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

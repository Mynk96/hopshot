import type { LiveEvent } from "shared";

/**
 * Talking to the VaultHub Durable Object (ARCHITECTURE §7.4).
 *
 * One hub per vault, addressed by name so every Worker isolate reaches the same instance.
 * The hostname in these URLs is ignored — a DO stub routes on the object, not on DNS — but
 * it has to parse as a URL, so it is a fixed internal placeholder.
 */

const INTERNAL = "https://vault-hub.internal";

export function hubFor(env: Env, vaultId: string): DurableObjectStub {
  return env.VAULT_HUB.get(env.VAULT_HUB.idFromName(vaultId));
}

/**
 * Fan an event out to the vault's live sockets.
 *
 * Never throws: a live update is a nicety on top of the HTTP write that already succeeded,
 * and clients reconcile with `GET /items?since=` when they reconnect (§7.4). Failing the
 * upload because a socket hiccuped would be the wrong trade.
 */
export async function broadcast(env: Env, vaultId: string, event: LiveEvent): Promise<void> {
  try {
    await hubFor(env, vaultId).fetch(`${INTERNAL}/broadcast`, {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.warn("live broadcast failed", { vaultId, type: event.type, error });
  }
}

/**
 * Close a revoked device's sockets (PRD F4.7, "loses access right away").
 *
 * Token checks only happen on HTTP requests, so an already-open socket would keep streaming
 * to a revoked phone until it reconnected of its own accord.
 */
export async function kick(env: Env, vaultId: string, deviceId: string): Promise<void> {
  try {
    await hubFor(env, vaultId).fetch(
      `${INTERNAL}/kick?deviceId=${encodeURIComponent(deviceId)}`,
    );
  } catch (error) {
    console.warn("could not close sockets for a revoked device", { vaultId, deviceId, error });
  }
}

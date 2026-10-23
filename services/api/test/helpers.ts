import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
// Vite inlines this at build time. workerd has no filesystem, and its fetch() cannot read
// file:// URLs, so the schema has to arrive as a string.
import schema from "../migrations/0001_init.sql?raw";
import pairingSchema from "../migrations/0002_pairing.sql?raw";
import renewalSchema from "../migrations/0003_renewals.sql?raw";
import { claimDeviceSlot, recordPurchase } from "../src/lib/license.ts";
import worker from "../src/index.ts";

/**
 * Shared test plumbing.
 *
 * Each test gets a clean D1 and R2: the pool reuses one miniflare instance, so without this
 * the daily-cap test would poison every test that ran after it.
 */

export async function applyMigrations(): Promise<void> {
  // So a test can never inherit the licence another test issued.
  currentLicense = null;

  // Drop everything the migration is about to create, so each test starts empty.
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();

  /*
   * Dropped in dependency order by repetition rather than by a hand-maintained list: the
   * licensing tables have foreign keys (licenses -> customers), so a fixed order rots the
   * moment a table is added. Each pass drops whatever no longer has dependents, and the loop
   * ends when a pass makes no progress.
   */
  let pending = (tables.results ?? []).map((table) => table.name);
  while (pending.length > 0) {
    const failed: string[] = [];
    for (const name of pending) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${name}"`);
      } catch {
        failed.push(name);
      }
    }
    if (failed.length === pending.length) {
      throw new Error(`could not drop: ${failed.join(", ")}`);
    }
    pending = failed;
  }

  // Comments go first: a `--` line in the header contains a semicolon, so splitting on `;`
  // before stripping them turns half a sentence into a statement.
  //
  // Applied in order, like `wrangler d1 migrations apply`, because 0002 references
  // vaults(id) and 0003 references licenses(id).
  const statements = [schema, pairingSchema, renewalSchema].flatMap((sql) =>
    sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );

  // D1's exec() wants a single statement on a single line.
  for (const sql of statements) await env.DB.exec(sql);

  // R2 has no "drop everything", so list and delete.
  const objects = await env.BUCKET.list();
  for (const object of objects.objects) await env.BUCKET.delete(object.key);
}

/** A fresh 22-char base62 id, as the client would generate (ARCHITECTURE §6). */
export function freshId(): string {
  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return [...bytes].map((b) => ALPHABET[b % 62]).join("");
}

/** Drive the worker the way Cloudflare would, including the waitUntil drain. */
export async function send(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.hopshot.xyz${path}`, init),
    env,
    ctx,
  );
  // Without this, `view_count` updates queued with waitUntil may not have landed.
  await waitOnExecutionContext(ctx);
  return response;
}

/** POST a blob with the headers a real upload carries. */
export async function post(
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return send(path, {
    method: "POST",
    headers: {
      "X-Hopshot-Install": "install-test",
      ...licenseHeader(),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.byteLength),
      "CF-Connecting-IP": "203.0.113.1",
      ...headers,
    },
    body,
  });
}

/** Run the 15-minute retention cron exactly as Cloudflare would. */
export async function runCron(cron = "*/15 * * * *"): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled?.(
    { cron, scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

/* ── Vault helpers (ARCHITECTURE §7.2) ─────────────────────────────────────── */

/** JSON POST with the install header, as the desktop app sends it. */
export async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return send(path, {
    method: "POST",
    headers: {
      "X-Hopshot-Install": "install-test",
      ...licenseHeader(),
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** `Authorization: Bearer` for a device token. */
export function asDevice(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Give this install a licence, which is now the only way to hold a plan.
 *
 * Hopshot is pay-first (PRD F8.1): there is no trial, so `resolvePlan` grants nothing
 * without a device token. A `bundle` licence resolves to `sync`, which is what the trial
 * used to grant — so tests written against trial-level access keep their meaning.
 *
 * The token is remembered and sent as `X-Hopshot-License` by `post` and `postJson`, the way
 * the real app always sends the token it stored at purchase.
 */
export async function licenseInstall(
  installId = "install-test",
  plan: "lifetime" | "bundle" = "bundle",
): Promise<string> {
  const licenseId = await recordPurchase(env, {
    customerId: `cus_${installId}`,
    email: `${installId}@example.com`,
    plan,
    sessionId: `cs_${installId}`,
    paymentIntentId: `pi_${installId}`,
  });

  const slot = await claimDeviceSlot(env, licenseId, installId, "Test PC");
  if (!slot.ok) {
    throw new Error(`could not license ${installId}: no slot free`);
  }

  currentLicense = slot.deviceToken;
  return slot.deviceToken;
}

/** The licence header `post`/`postJson` send, empty until a test issues one. */
function licenseHeader(): Record<string, string> {
  return currentLicense ? { "X-Hopshot-License": currentLicense } : {};
}

let currentLicense: string | null = null;

export type Enrolled = { vaultId: string; deviceId: string; deviceToken: string };

/** A vault with its first desktop device, ready to use. */
export async function createVault(deviceName = "Test PC"): Promise<Enrolled> {
  await licenseInstall();
  const response = await postJson("/v1/vaults", { deviceName, kind: "desktop" });
  if (response.status !== 201) {
    throw new Error(`could not create a vault: ${response.status} ${await response.text()}`);
  }
  return response.json<Enrolled>();
}

/** Mint an invite code on an existing vault. */
export async function invite(vault: Enrolled): Promise<string> {
  const response = await postJson(
    `/v1/vaults/${vault.vaultId}/invites`,
    {},
    asDevice(vault.deviceToken),
  );
  if (response.status !== 201) {
    throw new Error(`could not create an invite: ${response.status} ${await response.text()}`);
  }
  return (await response.json<{ code: string }>()).code;
}

/** Pair a phone into a vault and return its enrolment. */
export async function pairPhone(vault: Enrolled, deviceName = "Test iPhone"): Promise<Enrolled> {
  const code = await invite(vault);
  const response = await postJson("/v1/pair", { code, deviceName, kind: "phone" });
  if (response.status !== 201) {
    throw new Error(`could not pair: ${response.status} ${await response.text()}`);
  }
  return response.json<Enrolled>();
}

/** Upload a vault item as a given device. */
export async function postItem(
  vault: Enrolled,
  token: string,
  itemId: string,
  body = new Uint8Array([0x48, 0x4f, 0x50, 0x31, 9, 9, 9]),
  query = "?ttl=24h",
): Promise<Response> {
  return send(`/v1/vaults/${vault.vaultId}/items/${itemId}${query}`, {
    method: "POST",
    headers: {
      ...asDevice(token),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.byteLength),
      "X-Hopshot-Meta": "c2VhbGVkLW1ldGE",
      "CF-Connecting-IP": "203.0.113.1",
    },
    body,
  });
}

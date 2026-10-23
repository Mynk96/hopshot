import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { limits } from "shared";
import {
  applyMigrations,
  asDevice,
  createVault,
  freshId,
  invite,
  pairPhone,
  postItem,
  postJson,
  send,
  startTrial,
  runCron,
  type Enrolled,
} from "./helpers.ts";

/**
 * Vaults, pairing, devices, items and live tickets (ARCHITECTURE §7.2–§7.4).
 *
 * CLAUDE.md rule 8: every route gets happy path + limit + auth + expired.
 */

beforeEach(applyMigrations);

describe("POST /v1/trial/start", () => {
  it("records the trial and reports it active", async () => {
    const response = await postJson("/v1/trial/start", {});
    expect(response.status).toBe(200);

    const json = await response.json<{ startedAt: number; endsAt: number; active: boolean }>();
    expect(json.active).toBe(true);
    expect(json.endsAt - json.startedAt).toBe(limits.trial.days * 86_400_000);
  });

  it("does not restart an existing trial", async () => {
    const first = await (await postJson("/v1/trial/start", {})).json<{ startedAt: number }>();

    // A reinstall must not buy another 7 days.
    await env.DB.prepare("UPDATE trials SET started_at = ?1 WHERE install_id = 'install-test'")
      .bind(first.startedAt - 3 * 86_400_000)
      .run();

    const second = await (await postJson("/v1/trial/start", {})).json<{ startedAt: number }>();
    expect(second.startedAt).toBe(first.startedAt - 3 * 86_400_000);
  });

  it("needs an install id", async () => {
    const response = await send("/v1/trial/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /v1/vaults", () => {
  it("creates a vault and enrols the computer", async () => {
    const vault = await createVault("Mayank's PC");
    expect(vault.vaultId).toHaveLength(22);
    expect(vault.deviceToken).toHaveLength(43);

    // The token is only ever stored hashed (ARCHITECTURE §7).
    const row = await env.DB.prepare(
      "SELECT token_hash, kind, name FROM devices WHERE id = ?1",
    )
      .bind(vault.deviceId)
      .first<{ token_hash: string; kind: string; name: string }>();

    expect(row!.token_hash).not.toBe(vault.deviceToken);
    expect(row!.token_hash).toHaveLength(64);
    expect(row!.kind).toBe("desktop");
    expect(row!.name).toBe("Mayank's PC");
  });

  it("refuses without Sync or a trial", async () => {
    // No trial started, so resolvePlan says lifetime, and lifetime.vault is false.
    const response = await postJson("/v1/vaults", { deviceName: "PC", kind: "desktop" });
    expect(response.status).toBe(403);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("forbidden");
  });

  it("refuses a vault created from a phone", async () => {
    await startTrial();
    const response = await postJson("/v1/vaults", { deviceName: "iPhone", kind: "phone" });
    expect(response.status).toBe(400);
  });

  it("needs a device name", async () => {
    await startTrial();
    const response = await postJson("/v1/vaults", { deviceName: "  ", kind: "desktop" });
    expect(response.status).toBe(400);
  });
});

describe("POST /v1/vaults/:id/invites", () => {
  it("mints a single-use code and stores only its hash", async () => {
    const vault = await createVault();
    const code = await invite(vault);

    expect(code.length).toBeGreaterThan(10);

    const row = await env.DB.prepare("SELECT code_hash, used_at FROM invites").first<{
      code_hash: string;
      used_at: number | null;
    }>();
    expect(row!.code_hash).not.toBe(code);
    expect(row!.used_at).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const vault = await createVault();
    const response = await postJson(
      `/v1/vaults/${vault.vaultId}/invites`,
      {},
      asDevice("not-a-real-token"),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a token for a different vault", async () => {
    const a = await createVault("PC A");
    await env.DB.prepare("DELETE FROM trials").run();
    await startTrial("install-b");
    const b = await (
      await postJson(
        "/v1/vaults",
        { deviceName: "PC B", kind: "desktop" },
        { "X-Hopshot-Install": "install-b" },
      )
    ).json<Enrolled>();

    // B's token must not work against A's vault.
    const response = await postJson(
      `/v1/vaults/${a.vaultId}/invites`,
      {},
      asDevice(b.deviceToken),
    );
    expect(response.status).toBe(401);
  });

  it("will not let a phone mint invites", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);

    const response = await postJson(
      `/v1/vaults/${vault.vaultId}/invites`,
      {},
      asDevice(phone.deviceToken),
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /v1/pair", () => {
  it("pairs a phone", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault, "Mayank's iPhone");

    expect(phone.vaultId).toBe(vault.vaultId);
    expect(phone.deviceToken).not.toBe(vault.deviceToken);

    const row = await env.DB.prepare("SELECT kind, name FROM devices WHERE id = ?1")
      .bind(phone.deviceId)
      .first<{ kind: string; name: string }>();
    expect(row!.kind).toBe("phone");
    expect(row!.name).toBe("Mayank's iPhone");
  });

  it("burns the code: a second use fails", async () => {
    const vault = await createVault();
    const code = await invite(vault);

    expect((await postJson("/v1/pair", { code, deviceName: "A", kind: "phone" })).status).toBe(201);

    const second = await postJson("/v1/pair", { code, deviceName: "B", kind: "phone" });
    expect(second.status).toBe(404);
  });

  it("rejects an expired code", async () => {
    const vault = await createVault();
    const code = await invite(vault);

    await env.DB.prepare("UPDATE invites SET expires_at = ?1")
      .bind(Date.now() - 1000)
      .run();

    const response = await postJson("/v1/pair", { code, deviceName: "A", kind: "phone" });
    expect(response.status).toBe(404);
  });

  it("enforces maxPhones", async () => {
    const vault = await createVault();
    for (let n = 0; n < limits.sync.maxPhones; n++) {
      await pairPhone(vault, `Phone ${n}`);
    }

    const code = await invite(vault);
    const response = await postJson("/v1/pair", {
      code,
      deviceName: "One too many",
      kind: "phone",
    });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain(String(limits.sync.maxPhones));
  });

  /**
   * ARCHITECTURE §7.2: "At most 5 failed attempts per IP per 10 min". This is the one
   * unauthenticated write in the API, so it is the one that gets brute-forced.
   */
  it("locks an IP out after 5 failures", async () => {
    await createVault();

    for (let n = 0; n < limits.server.inviteTtlSeconds && n < 5; n++) {
      const response = await postJson("/v1/pair", {
        code: `wrong-code-${n}`,
        deviceName: "Attacker",
        kind: "phone",
      });
      expect(response.status).toBe(404);
    }

    // The 6th is refused before the code is even looked at.
    const locked = await postJson("/v1/pair", {
      code: "wrong-code-6",
      deviceName: "Attacker",
      kind: "phone",
    });
    expect(locked.status).toBe(429);

    const row = await env.DB.prepare("SELECT failures FROM pair_attempts").first<{
      failures: number;
    }>();
    expect(row!.failures).toBe(5);
  });

  it("locks out by IP, so another address is unaffected", async () => {
    const vault = await createVault();

    for (let n = 0; n < 5; n++) {
      await postJson("/v1/pair", { code: `bad-${n}`, deviceName: "A", kind: "phone" });
    }
    expect(
      (await postJson("/v1/pair", { code: "bad-x", deviceName: "A", kind: "phone" })).status,
    ).toBe(429);

    // A real phone on a different network can still pair.
    const code = await invite(vault);
    const other = await postJson(
      "/v1/pair",
      { code, deviceName: "Innocent", kind: "phone" },
      { "CF-Connecting-IP": "198.51.100.7" },
    );
    expect(other.status).toBe(201);
  });

  it("does not count a malformed body against the lockout", async () => {
    const vault = await createVault();

    // A buggy client must not be able to lock out a whole office NAT.
    for (let n = 0; n < 8; n++) {
      const response = await postJson("/v1/pair", { deviceName: "No code" });
      expect(response.status).toBe(400);
    }

    const code = await invite(vault);
    expect(
      (await postJson("/v1/pair", { code, deviceName: "Fine", kind: "phone" })).status,
    ).toBe(201);
  });
});

describe("GET /v1/vaults/:id/devices", () => {
  it("lists paired devices and marks the caller", async () => {
    const vault = await createVault("PC");
    const phone = await pairPhone(vault, "iPhone");

    const response = await send(`/v1/vaults/${vault.vaultId}/devices`, {
      headers: asDevice(vault.deviceToken),
    });
    expect(response.status).toBe(200);

    const devices = await response.json<{ id: string; name: string; isSelf: boolean }[]>();
    expect(devices).toHaveLength(2);
    expect(devices.find((d) => d.id === vault.deviceId)!.isSelf).toBe(true);
    expect(devices.find((d) => d.id === phone.deviceId)!.isSelf).toBe(false);
  });

  it("needs a token", async () => {
    const vault = await createVault();
    const response = await send(`/v1/vaults/${vault.vaultId}/devices`);
    expect(response.status).toBe(401);
  });
});

describe("DELETE /v1/vaults/:id/devices/:deviceId", () => {
  it("revokes a phone, and its token stops working at once", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);

    const response = await send(`/v1/vaults/${vault.vaultId}/devices/${phone.deviceId}`, {
      method: "DELETE",
      headers: asDevice(vault.deviceToken),
    });
    expect(response.status).toBe(204);

    // PRD F4.7: "A revoked device loses access right away."
    const after = await send(`/v1/vaults/${vault.vaultId}/items`, {
      headers: asDevice(phone.deviceToken),
    });
    expect(after.status).toBe(401);
  });

  it("will not let a computer remove itself", async () => {
    const vault = await createVault();

    // Otherwise there would be no desktop token left to mint an invite with.
    const response = await send(`/v1/vaults/${vault.vaultId}/devices/${vault.deviceId}`, {
      method: "DELETE",
      headers: asDevice(vault.deviceToken),
    });
    expect(response.status).toBe(403);
  });

  it("will not let a phone revoke the computer", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);

    const response = await send(`/v1/vaults/${vault.vaultId}/devices/${vault.deviceId}`, {
      method: "DELETE",
      headers: asDevice(phone.deviceToken),
    });
    expect(response.status).toBe(403);
  });

  it("is idempotent", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);
    const path = `/v1/vaults/${vault.vaultId}/devices/${phone.deviceId}`;

    expect((await send(path, { method: "DELETE", headers: asDevice(vault.deviceToken) })).status).toBe(204);
    expect((await send(path, { method: "DELETE", headers: asDevice(vault.deviceToken) })).status).toBe(204);
  });
});

describe("vault items (ARCHITECTURE §7.3)", () => {
  it("round-trips a sealed item", async () => {
    const vault = await createVault();
    const itemId = freshId();
    const body = new Uint8Array([0x48, 0x4f, 0x50, 0x31, 7, 7, 7]);

    const created = await postItem(vault, vault.deviceToken, itemId, body);
    expect(created.status).toBe(201);
    expect((await created.json<{ itemId: string }>()).itemId).toBe(itemId);

    // Stored byte for byte, under the vault-scoped key.
    const stored = await env.BUCKET.get(`v/${vault.vaultId}/${itemId}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(body);

    const blob = await send(`/v1/vaults/${vault.vaultId}/items/${itemId}/blob`, {
      headers: asDevice(vault.deviceToken),
    });
    expect(blob.status).toBe(200);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(body);
  });

  it("a phone sees what the computer uploaded", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);
    const itemId = freshId();

    await postItem(vault, vault.deviceToken, itemId);

    const response = await send(`/v1/vaults/${vault.vaultId}/items`, {
      headers: asDevice(phone.deviceToken),
    });
    const list = await response.json<{ id: string; sourceDeviceId: string; meta: string }[]>();

    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(itemId);
    expect(list[0]!.sourceDeviceId).toBe(vault.deviceId);
    // The metadata is opaque ciphertext, passed through untouched.
    expect(list[0]!.meta).toBe("c2VhbGVkLW1ldGE");
  });

  it("filters by ?since=", async () => {
    const vault = await createVault();
    const older = freshId();
    await postItem(vault, vault.deviceToken, older);

    const cutoff = Date.now();
    await env.DB.prepare("UPDATE items SET created_at = ?1 WHERE id = ?2")
      .bind(cutoff - 60_000, older)
      .run();

    const newer = freshId();
    await postItem(vault, vault.deviceToken, newer);

    const response = await send(`/v1/vaults/${vault.vaultId}/items?since=${cutoff}`, {
      headers: asDevice(vault.deviceToken),
    });
    const list = await response.json<{ id: string }[]>();
    expect(list.map((i) => i.id)).toEqual([newer]);
  });

  it("hides an expired item before the cron catches it", async () => {
    const vault = await createVault();
    const itemId = freshId();
    await postItem(vault, vault.deviceToken, itemId);

    // The sweep runs every 15 min, so the read path has to filter too.
    await env.DB.prepare("UPDATE items SET expires_at = ?1 WHERE id = ?2")
      .bind(Date.now() - 1000, itemId)
      .run();

    const list = await (
      await send(`/v1/vaults/${vault.vaultId}/items`, { headers: asDevice(vault.deviceToken) })
    ).json<unknown[]>();
    expect(list).toHaveLength(0);

    const blob = await send(`/v1/vaults/${vault.vaultId}/items/${itemId}/blob`, {
      headers: asDevice(vault.deviceToken),
    });
    expect(blob.status).toBe(410);
  });

  it("refuses an item without sealed metadata", async () => {
    const vault = await createVault();
    const response = await send(`/v1/vaults/${vault.vaultId}/items/${freshId()}?ttl=24h`, {
      method: "POST",
      headers: { ...asDevice(vault.deviceToken), "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a ciphertext over the server cap", async () => {
    const vault = await createVault();
    const response = await send(`/v1/vaults/${vault.vaultId}/items/${freshId()}?ttl=24h`, {
      method: "POST",
      headers: {
        ...asDevice(vault.deviceToken),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(limits.server.maxCiphertextBytes + 1),
        "X-Hopshot-Meta": "c2VhbGVk",
      },
      body: new Uint8Array(8),
    });
    expect(response.status).toBe(413);
  });

  it("refuses a ttl the plan does not offer", async () => {
    const vault = await createVault();
    const response = await postItem(
      vault,
      vault.deviceToken,
      freshId(),
      undefined,
      "?ttl=30d",
    );
    expect(response.status).toBe(403);
  });

  it("rejects a duplicate id with 409", async () => {
    const vault = await createVault();
    const itemId = freshId();

    expect((await postItem(vault, vault.deviceToken, itemId)).status).toBe(201);
    expect((await postItem(vault, vault.deviceToken, itemId)).status).toBe(409);
  });

  it("enforces the daily upload cap", async () => {
    const vault = await createVault();

    // Seed the counter rather than uploading 500 times.
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO usage (day, subject, kind, count, bytes) VALUES (?1, ?2, 'vault_items', ?3, 0)",
    )
      .bind(day, vault.vaultId, limits.sync.vaultUploadsPerDay)
      .run();

    const response = await postItem(vault, vault.deviceToken, freshId());
    expect(response.status).toBe(429);
  });

  it("needs a token, and refuses another vault's token", async () => {
    const vault = await createVault();
    const itemId = freshId();
    await postItem(vault, vault.deviceToken, itemId);

    const anonymous = await send(`/v1/vaults/${vault.vaultId}/items/${itemId}/blob`);
    expect(anonymous.status).toBe(401);

    const wrong = await send(`/v1/vaults/${vault.vaultId}/items/${itemId}/blob`, {
      headers: asDevice("some-other-token"),
    });
    expect(wrong.status).toBe(401);
  });

  it("deletes the blob and the row", async () => {
    const vault = await createVault();
    const itemId = freshId();
    await postItem(vault, vault.deviceToken, itemId);

    const response = await send(`/v1/vaults/${vault.vaultId}/items/${itemId}`, {
      method: "DELETE",
      headers: asDevice(vault.deviceToken),
    });
    expect(response.status).toBe(204);

    expect(await env.BUCKET.get(`v/${vault.vaultId}/${itemId}`)).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM items WHERE id = ?1").bind(itemId).first(),
    ).toBeNull();

    // Idempotent: a phone retrying a delete should not see an error.
    const again = await send(`/v1/vaults/${vault.vaultId}/items/${itemId}`, {
      method: "DELETE",
      headers: asDevice(vault.deviceToken),
    });
    expect(again.status).toBe(204);
  });
});

describe("live tickets (ARCHITECTURE §7.4)", () => {
  it("mints a ticket and stores only its hash", async () => {
    const vault = await createVault();

    const response = await postJson(
      `/v1/vaults/${vault.vaultId}/live-ticket`,
      {},
      asDevice(vault.deviceToken),
    );
    expect(response.status).toBe(201);

    const { ticket } = await response.json<{ ticket: string }>();
    const row = await env.DB.prepare("SELECT ticket_hash, used_at FROM live_tickets").first<{
      ticket_hash: string;
      used_at: number | null;
    }>();

    expect(row!.ticket_hash).not.toBe(ticket);
    expect(row!.used_at).toBeNull();
  });

  it("needs a device token", async () => {
    const vault = await createVault();
    const response = await postJson(`/v1/vaults/${vault.vaultId}/live-ticket`, {});
    expect(response.status).toBe(401);
  });

  it("refuses a plain GET on the socket endpoint", async () => {
    const vault = await createVault();
    const response = await send(`/v1/vaults/${vault.vaultId}/live?ticket=whatever`);
    expect(response.status).toBe(400);
  });

  it("refuses an unknown ticket", async () => {
    const vault = await createVault();
    const response = await send(`/v1/vaults/${vault.vaultId}/live?ticket=nope`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  it("burns a ticket: the second upgrade is refused", async () => {
    const vault = await createVault();
    const { ticket } = await (
      await postJson(`/v1/vaults/${vault.vaultId}/live-ticket`, {}, asDevice(vault.deviceToken))
    ).json<{ ticket: string }>();

    const first = await send(`/v1/vaults/${vault.vaultId}/live?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(first.status).toBe(101);

    // Replaying it must not open a second socket.
    const second = await send(`/v1/vaults/${vault.vaultId}/live?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(second.status).toBe(401);
  });

  it("refuses an expired ticket", async () => {
    const vault = await createVault();
    const { ticket } = await (
      await postJson(`/v1/vaults/${vault.vaultId}/live-ticket`, {}, asDevice(vault.deviceToken))
    ).json<{ ticket: string }>();

    await env.DB.prepare("UPDATE live_tickets SET expires_at = ?1")
      .bind(Date.now() - 1000)
      .run();

    const response = await send(`/v1/vaults/${vault.vaultId}/live?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  /**
   * A ticket lives 60 s, so a device revoked in between must not still get a socket —
   * otherwise revocation has a one-minute hole in it (PRD F4.7).
   */
  it("refuses a ticket whose device was revoked after minting", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);

    const { ticket } = await (
      await postJson(`/v1/vaults/${vault.vaultId}/live-ticket`, {}, asDevice(phone.deviceToken))
    ).json<{ ticket: string }>();

    await send(`/v1/vaults/${vault.vaultId}/devices/${phone.deviceId}`, {
      method: "DELETE",
      headers: asDevice(vault.deviceToken),
    });

    const response = await send(`/v1/vaults/${vault.vaultId}/live?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });
});

describe("DELETE /v1/vaults/:id", () => {
  it("removes every blob, item, device and the vault itself", async () => {
    const vault = await createVault();
    await pairPhone(vault);
    const itemId = freshId();
    await postItem(vault, vault.deviceToken, itemId);

    const response = await send(`/v1/vaults/${vault.vaultId}`, {
      method: "DELETE",
      headers: asDevice(vault.deviceToken),
    });
    expect(response.status).toBe(204);

    // DESIGN S7: "Delete everything Hopshot stored online."
    expect(await env.BUCKET.get(`v/${vault.vaultId}/${itemId}`)).toBeNull();
    for (const table of ["items", "devices", "invites"]) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE vault_id = ?1`,
      )
        .bind(vault.vaultId)
        .first<{ n: number }>();
      expect(row!.n).toBe(0);
    }
    expect(
      await env.DB.prepare("SELECT id FROM vaults WHERE id = ?1").bind(vault.vaultId).first(),
    ).toBeNull();
  });

  it("will not let a phone delete the vault", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);

    const response = await send(`/v1/vaults/${vault.vaultId}`, {
      method: "DELETE",
      headers: asDevice(phone.deviceToken),
    });
    expect(response.status).toBe(403);
  });
});

describe("the retention cron (ARCHITECTURE §7.8)", () => {
  it("prunes spent tickets and old lockout buckets", async () => {
    const vault = await createVault();

    const { ticket } = await (
      await postJson(`/v1/vaults/${vault.vaultId}/live-ticket`, {}, asDevice(vault.deviceToken))
    ).json<{ ticket: string }>();
    await send(`/v1/vaults/${vault.vaultId}/live?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });

    // A lockout bucket well outside its window.
    await env.DB.prepare(
      "INSERT INTO pair_attempts (ip_hash, window_start, failures) VALUES ('old', ?1, 5)",
    )
      .bind(Date.now() - 60 * 60 * 1000)
      .run();

    await runCron();

    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM live_tickets").first<{ n: number }>())!.n,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM pair_attempts").first<{ n: number }>())!.n,
    ).toBe(0);
  });
});

describe("live fan-out through VaultHub (ARCHITECTURE §7.4)", () => {
  /** Open a real socket for a device, the way the phone and the desktop both do. */
  async function connect(vault: Enrolled, token: string): Promise<WebSocket> {
    const { ticket } = await (
      await postJson(`/v1/vaults/${vault.vaultId}/live-ticket`, {}, asDevice(token))
    ).json<{ ticket: string }>();

    const response = await send(`/v1/vaults/${vault.vaultId}/live?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);

    const socket = response.webSocket!;
    socket.accept();
    return socket;
  }

  /** The next message on a socket, or a timeout rather than hanging the suite. */
  function nextMessage(socket: WebSocket, ms = 4000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no live event arrived")), ms);
      socket.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      });
    });
  }

  /**
   * PRD F4.3: a capture on the laptop appears on the phone in under 3 s. Polling is 15 s,
   * so this delivery path is the only thing that can meet it.
   */
  it("delivers item.created to a phone when the computer uploads", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);

    const socket = await connect(vault, phone.deviceToken);
    const waiting = nextMessage(socket);

    const itemId = freshId();
    expect((await postItem(vault, vault.deviceToken, itemId)).status).toBe(201);

    const event = JSON.parse(await waiting) as {
      type: string;
      item: { id: string; sourceDeviceId: string };
    };
    expect(event.type).toBe("item.created");
    expect(event.item.id).toBe(itemId);
    expect(event.item.sourceDeviceId).toBe(vault.deviceId);
  });

  /** F4.5 in the other direction: the phone uploads, the computer's shelf hears about it. */
  it("delivers item.created to the computer when the phone uploads", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);

    const socket = await connect(vault, vault.deviceToken);
    const waiting = nextMessage(socket);

    const itemId = freshId();
    expect((await postItem(vault, phone.deviceToken, itemId)).status).toBe(201);

    const event = JSON.parse(await waiting) as { type: string; item: { sourceDeviceId: string } };
    expect(event.type).toBe("item.created");
    expect(event.item.sourceDeviceId).toBe(phone.deviceId);
  });

  it("delivers item.deleted", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);
    const itemId = freshId();
    await postItem(vault, vault.deviceToken, itemId);

    const socket = await connect(vault, phone.deviceToken);
    const waiting = nextMessage(socket);

    await send(`/v1/vaults/${vault.vaultId}/items/${itemId}`, {
      method: "DELETE",
      headers: asDevice(vault.deviceToken),
    });

    const event = JSON.parse(await waiting) as { type: string; id: string };
    expect(event.type).toBe("item.deleted");
    expect(event.id).toBe(itemId);
  });

  it("tells the computer when a phone pairs", async () => {
    const vault = await createVault();
    const socket = await connect(vault, vault.deviceToken);
    const waiting = nextMessage(socket);

    await pairPhone(vault, "A new iPhone");

    const event = JSON.parse(await waiting) as { type: string; device: { name: string } };
    expect(event.type).toBe("device.joined");
    expect(event.device.name).toBe("A new iPhone");
  });

  /**
   * PRD F4.7: "A revoked device loses access right away." Token checks only run on HTTP
   * requests, so without the DO closing the socket a revoked phone would keep receiving
   * events on the connection it already holds.
   */
  it("closes a revoked device's socket", async () => {
    const vault = await createVault();
    const phone = await pairPhone(vault);
    const socket = await connect(vault, phone.deviceToken);

    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the socket stayed open")), 4000);
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });

    await send(`/v1/vaults/${vault.vaultId}/devices/${phone.deviceId}`, {
      method: "DELETE",
      headers: asDevice(vault.deviceToken),
    });

    // 1008 tells the client not to reconnect, unlike the 1006 it retries after.
    expect(await closed).toBe(1008);
  });

  /** One hub per vault: a neighbour's upload must not leak into this vault's stream. */
  it("does not cross vaults", async () => {
    const mine = await createVault("Mine");
    const phone = await pairPhone(mine);
    const socket = await connect(mine, phone.deviceToken);

    await env.DB.prepare("DELETE FROM trials").run();
    await startTrial("install-other");
    const theirs = await (
      await postJson(
        "/v1/vaults",
        { deviceName: "Theirs", kind: "desktop" },
        { "X-Hopshot-Install": "install-other" },
      )
    ).json<Enrolled>();

    let leaked: string | null = null;
    socket.addEventListener("message", (event) => {
      leaked = String(event.data);
    });

    await postItem(theirs, theirs.deviceToken, freshId());
    // Long enough for a misrouted broadcast to have shown up.
    await scheduler.wait(300);

    expect(leaked).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  EnvelopeError,
  KEY_BYTES,
  importVaultKey,
  importVaultKeyFromBase64Url,
  keyToBytes,
  newId,
  newKey,
  open,
  openMetaWith,
  openWith,
  seal,
  sealMetaWith,
  sealWith,
} from "../src/index.ts";

/**
 * The `CryptoKey` API (ARCHITECTURE §8).
 *
 * The phone PWA keeps the vault key as a non-extractable `CryptoKey` in IndexedDB rather
 * than as raw bytes, so that injected script can use it but never read it. These tests pin
 * both halves of that claim: that the key really is unreadable, and that the two APIs
 * produce interchangeable envelopes.
 */

describe("importVaultKey", () => {
  /** The entire point: if this ever starts succeeding, the key is readable again. */
  it("produces a key WebCrypto refuses to export", async () => {
    const key = await importVaultKeyFromBase64Url(newKey());

    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("allows only encrypt and decrypt", async () => {
    const key = await importVaultKeyFromBase64Url(newKey());

    expect([...key.usages].sort()).toEqual(["decrypt", "encrypt"]);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM" });
  });

  it("rejects a key of the wrong length", async () => {
    await expect(importVaultKey(new Uint8Array(KEY_BYTES - 1))).rejects.toThrow(EnvelopeError);
    await expect(importVaultKeyFromBase64Url("too-short")).rejects.toThrow(EnvelopeError);
  });
});

describe("sealWith / openWith", () => {
  it("round-trips", async () => {
    const key = await importVaultKeyFromBase64Url(newKey());
    const id = newId();
    const plaintext = new TextEncoder().encode("a screenshot, pretend");

    const envelope = await sealWith(key, "item", id, plaintext);
    expect(await openWith(key, "item", id, envelope)).toEqual(plaintext);
  });

  /**
   * `seal` is `sealWith` with an import in front, so an envelope from either must open with
   * the other. If that ever stops holding, the desktop and the phone have diverged.
   */
  it("is interchangeable with the raw-bytes API", async () => {
    const base64 = newKey();
    const bytes = keyToBytes(base64);
    const key = await importVaultKey(bytes);
    const id = newId();
    const plaintext = new TextEncoder().encode("interchangeable");

    const fromBytes = await seal(bytes, "item", id, plaintext);
    const fromKey = await sealWith(key, "item", id, plaintext);

    // Each opens under the other's API.
    expect(await openWith(key, "item", id, fromBytes)).toEqual(plaintext);
    expect(await open(bytes, "item", id, fromKey)).toEqual(plaintext);
  });

  it("still binds the envelope to its kind and id", async () => {
    const key = await importVaultKeyFromBase64Url(newKey());
    const id = newId();
    const envelope = await sealWith(key, "item", id, new Uint8Array([1, 2, 3]));

    // The AAD is what stops the server moving a blob between records.
    await expect(openWith(key, "meta", id, envelope)).rejects.toThrow(EnvelopeError);
    await expect(openWith(key, "item", newId(), envelope)).rejects.toThrow(EnvelopeError);
  });

  it("fails under a different key", async () => {
    const mine = await importVaultKeyFromBase64Url(newKey());
    const theirs = await importVaultKeyFromBase64Url(newKey());
    const id = newId();

    const envelope = await sealWith(mine, "item", id, new Uint8Array([9]));
    await expect(openWith(theirs, "item", id, envelope)).rejects.toThrow(EnvelopeError);
  });

  it("detects a tampered envelope", async () => {
    const key = await importVaultKeyFromBase64Url(newKey());
    const id = newId();
    const envelope = await sealWith(key, "item", id, new Uint8Array([1, 2, 3, 4]));

    // Flip a bit in the ciphertext.
    const tampered = Uint8Array.from(envelope);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;

    await expect(openWith(key, "item", id, tampered)).rejects.toThrow(EnvelopeError);
  });
});

describe("sealMetaWith / openMetaWith", () => {
  it("round-trips the metadata the phone reads for every card", async () => {
    const key = await importVaultKeyFromBase64Url(newKey());
    const id = newId();
    const meta = {
      name: "Screenshot 2026-10-18 at 16.20.11.png",
      mime: "image/png",
      w: 1280,
      h: 720,
      createdAt: 1792322456918,
      origin: "Mayank's PC",
    };

    const header = await sealMetaWith(key, id, meta);

    // Base64url, so it survives an HTTP header.
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    // And the plaintext name is not sitting in it.
    expect(header).not.toContain("Screenshot");

    expect(await openMetaWith(key, id, header)).toEqual(meta);
  });
});

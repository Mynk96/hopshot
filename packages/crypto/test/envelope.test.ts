import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aad,
  ENVELOPE_MAGIC,
  EnvelopeError,
  fromBase64Url,
  idFromBytes,
  ID_CHARS,
  KEY_BYTES,
  KEY_CHARS,
  NONCE_BYTES,
  newId,
  newKey,
  open,
  openMeta,
  seal,
  sealMeta,
  toBase64Url,
  type EnvelopeKind,
  type Meta,
} from "../src/index.ts";

/**
 * The same `test-vectors.json` the Rust suite compiles in with `include_str!`
 * (ARCHITECTURE §6: "Both the Rust and TS test suites must pass the same vectors").
 *
 * Read from disk by path rather than imported, so there is exactly one copy and no bundler
 * can quietly substitute another.
 */
const VECTORS_PATH = fileURLToPath(new URL("../test-vectors.json", import.meta.url));
const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as {
  algorithm: string;
  magic: string;
  nonceBytes: number;
  tagBits: number;
  aadTemplate: string;
  vectors: {
    name: string;
    kind: EnvelopeKind;
    id: string;
    keyBase64Url: string;
    nonceHex: string;
    aad: string;
    plaintextHex: string;
    envelopeHex: string;
  }[];
  tampered: { name: string; envelopeHex: string; reason: string }[];
  wrongContext: { name: string; kind: EnvelopeKind; id: string; keyBase64Url?: string }[];
  ids: { bytesHex: string; id: string }[];
  base64url: { bytesHex: string; text: string }[];
};

const hex = (text: string): Uint8Array =>
  Uint8Array.from((text.match(/../g) ?? []).map((byte) => parseInt(byte, 16)));

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const keyOf = (base64url: string) => fromBase64Url(base64url);

describe("HOP1 constants", () => {
  it("matches ARCHITECTURE §6", () => {
    expect(ENVELOPE_MAGIC).toBe("HOP1");
    expect(NONCE_BYTES).toBe(12);
    expect(KEY_BYTES).toBe(32);
  });

  it("agrees with the vectors file", () => {
    expect(vectors.algorithm).toBe("AES-256-GCM");
    expect(vectors.magic).toBe(ENVELOPE_MAGIC);
    expect(vectors.nonceBytes).toBe(NONCE_BYTES);
    expect(vectors.tagBits).toBe(128);
  });

  it("binds the AAD to kind and id", () => {
    expect(aad("drop", "abc")).toBe("hopshot/v1/drop/abc");
    expect(vectors.aadTemplate).toBe("hopshot/v1/{kind}/{id}");
  });
});

describe("test vectors", () => {
  it.each(vectors.vectors)("seals $name byte-for-byte", async (vector) => {
    const sealed = await seal(
      keyOf(vector.keyBase64Url),
      vector.kind,
      vector.id,
      hex(vector.plaintextHex),
      hex(vector.nonceHex),
    );
    expect(toHex(sealed)).toBe(vector.envelopeHex);
  });

  it.each(vectors.vectors)("opens $name back to its plaintext", async (vector) => {
    const opened = await open(
      keyOf(vector.keyBase64Url),
      vector.kind,
      vector.id,
      hex(vector.envelopeHex),
    );
    expect(toHex(opened)).toBe(vector.plaintextHex);
  });

  it.each(vectors.vectors)("derives the AAD for $name", (vector) => {
    expect(aad(vector.kind, vector.id)).toBe(vector.aad);
  });

  it("lays the envelope out as magic ‖ nonce ‖ ct‖tag", () => {
    const vector = vectors.vectors[0]!;
    const envelope = hex(vector.envelopeHex);

    expect(new TextDecoder().decode(envelope.subarray(0, 4))).toBe("HOP1");
    expect(toHex(envelope.subarray(4, 16))).toBe(vector.nonceHex);
    // Empty plaintext, so what remains is exactly the 128-bit tag.
    expect(envelope.length - 16).toBe(16);
  });
});

describe("tampering", () => {
  const good = vectors.vectors[1]!;

  it.each(vectors.tampered)("rejects $name", async (tampered) => {
    await expect(
      open(keyOf(good.keyBase64Url), good.kind, good.id, hex(tampered.envelopeHex)),
    ).rejects.toBeInstanceOf(EnvelopeError);
  });

  // The AAD is what stops a blob being swapped between records (ARCHITECTURE §6).
  it.each(vectors.wrongContext)("refuses to open with the $name", async (context) => {
    await expect(
      open(
        keyOf(context.keyBase64Url ?? good.keyBase64Url),
        context.kind,
        context.id,
        hex(good.envelopeHex),
      ),
    ).rejects.toThrow(/authentication/i);
  });
});

describe("ids", () => {
  it.each(vectors.ids)("encodes $bytesHex", (vector) => {
    const bytes = hex(vector.bytesHex);
    expect(idFromBytes(bytes)).toBe(vector.id);
    expect(vector.id).toHaveLength(ID_CHARS);
  });

  it("is 22 base62 chars and does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newId();
      expect(id).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("keeps leading zeros so every id is the same width", () => {
    expect(idFromBytes(new Uint8Array(16))).toBe("0".repeat(ID_CHARS));
  });
});

describe("base64url", () => {
  it.each(vectors.base64url)("round-trips $bytesHex", (vector) => {
    const bytes = hex(vector.bytesHex);
    expect(toBase64Url(bytes)).toBe(vector.text);
    expect(toHex(fromBase64Url(vector.text))).toBe(vector.bytesHex);
  });

  it("never emits padding or a non-url character", () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37) % 256);
      const text = toBase64Url(bytes);
      expect(text).not.toContain("=");
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(toHex(fromBase64Url(text))).toBe(toHex(bytes));
    }
  });

  it("gives a key 43 chars, as the URL fragment needs", () => {
    const key = newKey();
    expect(key).toHaveLength(KEY_CHARS);
    expect(fromBase64Url(key)).toHaveLength(KEY_BYTES);
  });
});

describe("round trips", () => {
  it("opens what it sealed with a random nonce", async () => {
    const key = fromBase64Url(newKey());
    const plaintext = new TextEncoder().encode("a payload");

    const sealed = await seal(key, "item", "abc", plaintext);
    expect(await open(key, "item", "abc", sealed)).toEqual(plaintext);
  });

  it("uses a fresh nonce every time", async () => {
    const key = fromBase64Url(newKey());
    const first = await seal(key, "drop", "abc", new Uint8Array([1]));
    const second = await seal(key, "drop", "abc", new Uint8Array([1]));
    expect(toHex(first)).not.toBe(toHex(second));
  });

  it("carries metadata through the X-Hopshot-Meta header encoding", async () => {
    const key = fromBase64Url(newKey());
    const meta: Meta = {
      name: "Screenshot.png",
      mime: "image/png",
      w: 1920,
      h: 1080,
      createdAt: 1727618602000,
    };

    const header = await sealMeta(key, "abc", meta);
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await openMeta(key, "abc", header)).toEqual(meta);
  });

  it("seals metadata under the meta kind, so it cannot open as the item", async () => {
    const key = fromBase64Url(newKey());
    const header = await sealMeta(key, "abc", {
      name: "a.png",
      mime: "image/png",
      w: 1,
      h: 1,
      createdAt: 0,
    });

    await expect(open(key, "item", "abc", fromBase64Url(header))).rejects.toBeInstanceOf(
      EnvelopeError,
    );
  });

  it("handles a payload larger than one AES block", async () => {
    const key = fromBase64Url(newKey());
    const plaintext = new Uint8Array(100_000).map((_, i) => i % 256);

    const sealed = await seal(key, "drop", "abc", plaintext);
    expect(sealed.length).toBe(4 + NONCE_BYTES + plaintext.length + 16);
    expect(await open(key, "drop", "abc", sealed)).toEqual(plaintext);
  });
});

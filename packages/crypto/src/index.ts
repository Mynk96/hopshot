/**
 * HOP1 envelope (ARCHITECTURE §6) in WebCrypto.
 *
 * ```text
 * "HOP1" (4 ASCII) ‖ nonce (12) ‖ ciphertext‖tag
 * ```
 *
 * AES-256-GCM, 96-bit nonce, 128-bit tag. The AAD is UTF-8 of `hopshot/v1/{kind}/{id}`,
 * which binds a ciphertext to the record it belongs to: a blob moved to a different id
 * fails to open rather than decrypting into the wrong place.
 *
 * The Rust side (`apps/desktop/src-tauri/src/crypto.rs`) is byte-for-byte equivalent, and
 * both suites run `test-vectors.json` so they cannot drift.
 *
 * Runs in the browser, in Workers and in Node 20+ — all expose `globalThis.crypto.subtle`.
 */

export const ENVELOPE_MAGIC = "HOP1";
export const NONCE_BYTES = 12;
export const TAG_BITS = 128;
export const TAG_BYTES = TAG_BITS / 8;
export const KEY_BYTES = 32;
/** 32 bytes in base64url without padding. */
export const KEY_CHARS = 43;
/** 128 bits in base62. */
export const ID_CHARS = 22;

const MAGIC_BYTES = new Uint8Array([0x48, 0x4f, 0x50, 0x31]); // "HOP1"
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** What the AAD binds a ciphertext to, so blobs can't be swapped between records. */
export type EnvelopeKind = "drop" | "item" | "meta";

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** UTF-8 of this string is the AES-GCM additional authenticated data. */
export function aad(kind: EnvelopeKind, id: string): string {
  return `hopshot/v1/${kind}/${id}`;
}

// ── base64url (no padding) ───────────────────────────────────────────────────

/**
 * Hand-rolled rather than via `btoa`: `btoa` needs a binary string, which means a
 * character-at-a-time conversion of multi-megabyte ciphertext, and it is not available in
 * every runtime this package targets.
 */
export function toBase64Url(bytes: Uint8Array): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];

    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 0x3f];
  }

  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const values = new Uint8Array(text.length);

  for (let i = 0; i < text.length; i++) {
    const value = ALPHABET.indexOf(text[i]!);
    if (value < 0) throw new EnvelopeError(`not base64url: ${JSON.stringify(text[i])}`);
    values[i] = value;
  }

  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let written = 0;

  for (const value of values) {
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
    }
  }

  return out;
}

// ── ids and keys ─────────────────────────────────────────────────────────────

/** A 22-char base62 id from 128 random bits (ARCHITECTURE §6). */
export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return idFromBytes(bytes);
}

/** Deterministic half of {@link newId}, so the vectors can pin it. */
export function idFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new EnvelopeError(`an id needs 16 bytes, got ${bytes.length}`);
  }

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  // Fixed width: leading zeros stay, so every id is exactly 22 chars.
  const out = new Array<string>(ID_CHARS);
  for (let i = ID_CHARS - 1; i >= 0; i--) {
    out[i] = BASE62[Number(value % 62n)]!;
    value /= 62n;
  }
  return out.join("");
}

/** A fresh 256-bit key, base64url-encoded for a URL fragment. */
export function newKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function keyToBytes(key: string): Uint8Array {
  const bytes = fromBase64Url(key);
  if (bytes.length !== KEY_BYTES) {
    throw new EnvelopeError(`a key needs ${KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

// ── seal / open ──────────────────────────────────────────────────────────────

/**
 * Import raw key bytes as a **non-extractable** AES-GCM key.
 *
 * `extractable: false` means WebCrypto will refuse `exportKey` on the result, so once the
 * raw bytes are dropped the key can be *used* but never read back out — not by us, and not
 * by injected script. A `CryptoKey` is also structured-cloneable, so the phone PWA can keep
 * one in IndexedDB and never store the bytes at all (ARCHITECTURE §8: "keep the vault key
 * as a non-extractable WebCrypto CryptoKey after import").
 *
 * Exported because that storage pattern is the whole point; `seal`/`open` call it too.
 */
export async function importVaultKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== KEY_BYTES) {
    throw new EnvelopeError(`a key needs ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Parse a base64url key straight into a non-extractable `CryptoKey`. */
export async function importVaultKeyFromBase64Url(key: string): Promise<CryptoKey> {
  return importVaultKey(keyToBytes(key));
}

/**
 * Encrypt into a HOP1 envelope.
 *
 * `nonce` is only for the test vectors. In production leave it out: a reused nonce under
 * the same key breaks GCM completely, so the random default is the safe path.
 */
export async function seal(
  key: Uint8Array,
  kind: EnvelopeKind,
  id: string,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  return sealWith(await importVaultKey(key), kind, id, plaintext, nonce);
}

/**
 * [`seal`] with an already-imported key.
 *
 * Byte-for-byte identical output: `seal` is this function with an import in front of it, so
 * the shared test vectors cover both.
 */
export async function sealWith(
  key: CryptoKey,
  kind: EnvelopeKind,
  id: string,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  if (nonce && nonce.length !== NONCE_BYTES) {
    throw new EnvelopeError(`a nonce needs ${NONCE_BYTES} bytes, got ${nonce.length}`);
  }

  const iv = nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: new TextEncoder().encode(aad(kind, id)) as BufferSource,
        tagLength: TAG_BITS,
      },
      key,
      plaintext as BufferSource,
    ),
  );

  const envelope = new Uint8Array(MAGIC_BYTES.length + NONCE_BYTES + sealed.length);
  envelope.set(MAGIC_BYTES, 0);
  envelope.set(iv, MAGIC_BYTES.length);
  envelope.set(sealed, MAGIC_BYTES.length + NONCE_BYTES);
  return envelope;
}

/**
 * Open a HOP1 envelope. Throws if the magic is wrong, the envelope is truncated, or the
 * tag does not verify — including when `kind`/`id` do not match what it was sealed with.
 */
export async function open(
  key: Uint8Array,
  kind: EnvelopeKind,
  id: string,
  envelope: Uint8Array,
): Promise<Uint8Array> {
  return openWith(await importVaultKey(key), kind, id, envelope);
}

/** [`open`] with an already-imported key. */
export async function openWith(
  key: CryptoKey,
  kind: EnvelopeKind,
  id: string,
  envelope: Uint8Array,
): Promise<Uint8Array> {
  const header = MAGIC_BYTES.length + NONCE_BYTES;
  // Below this there is not even a tag, let alone a payload.
  if (envelope.length < header + TAG_BYTES) {
    throw new EnvelopeError("this envelope is too short to be HOP1");
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (envelope[i] !== MAGIC_BYTES[i]) throw new EnvelopeError("this is not a HOP1 envelope");
  }

  const iv = envelope.subarray(MAGIC_BYTES.length, header);
  const sealed = envelope.subarray(header);

  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv as BufferSource,
          additionalData: new TextEncoder().encode(aad(kind, id)) as BufferSource,
          tagLength: TAG_BITS,
        },
        key,
        sealed as BufferSource,
      ),
    );
  } catch {
    // WebCrypto throws a bare OperationError; say what actually happened.
    throw new EnvelopeError("this envelope failed its authentication check");
  }
}

/** Metadata travels base64url-encoded in `X-Hopshot-Meta` (ARCHITECTURE §6). */
export type Meta = {
  name: string;
  mime: string;
  w: number;
  h: number;
  createdAt: number;
  origin?: string;
};

export async function sealMeta(key: Uint8Array, id: string, meta: Meta): Promise<string> {
  return sealMetaWith(await importVaultKey(key), id, meta);
}

export async function openMeta(key: Uint8Array, id: string, header: string): Promise<Meta> {
  return openMetaWith(await importVaultKey(key), id, header);
}

/** [`sealMeta`] with an already-imported key. */
export async function sealMetaWith(key: CryptoKey, id: string, meta: Meta): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  return toBase64Url(await sealWith(key, "meta", id, json));
}

/** [`openMeta`] with an already-imported key. */
export async function openMetaWith(key: CryptoKey, id: string, header: string): Promise<Meta> {
  const json = await openWith(key, "meta", id, fromBase64Url(header));
  return JSON.parse(new TextDecoder().decode(json)) as Meta;
}

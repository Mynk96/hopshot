import { get, set, del } from "idb-keyval";
import {
  importVaultKeyFromBase64Url,
  newId,
  openMetaWith,
  openWith,
  sealMetaWith,
  sealWith,
  type Meta,
} from "@hopshot/crypto";
import type {
  DeviceSummary,
  Enrolment,
  ItemSummary,
  LiveTicket,
  PairBody,
} from "shared";

/**
 * The phone's half of the vault (ARCHITECTURE §8, PRD F4.2–F4.7).
 *
 * **The vault key is never stored as bytes.** It arrives once in a URL fragment, is imported
 * immediately as a non-extractable `CryptoKey`, and only that handle is persisted — a
 * `CryptoKey` is structured-cloneable, so IndexedDB can hold it while WebCrypto refuses to
 * export it. Script running on this origin can therefore *use* the key but never read it,
 * and there is no copy of the raw key anywhere on the device.
 *
 * Everything the server sees is HOP1 ciphertext plus a sealed metadata header, so file names
 * never leave the phone in the clear (CLAUDE.md privacy invariant).
 */

const API_BASE = import.meta.env.PUBLIC_HOPSHOT_API ?? "https://api.hopshot.xyz/v1";

/** One IndexedDB key per field, under `idb-keyval`'s default store. */
const KEYS = {
  vaultId: "hopshot:vaultId",
  deviceId: "hopshot:deviceId",
  deviceToken: "hopshot:deviceToken",
  vaultKey: "hopshot:vaultKey",
  deviceName: "hopshot:deviceName",
} as const;

export type Credentials = {
  vaultId: string;
  deviceId: string;
  deviceToken: string;
  /** Non-extractable. There is deliberately no way back to the bytes. */
  key: CryptoKey;
};

export class VaultError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/* ── Pairing ──────────────────────────────────────────────────────────────── */

/**
 * Split a `/pair#{code}.{vaultKey}` fragment.
 *
 * The key is base64url, which has no `.`, so a single split on the first dot is
 * unambiguous. Returns `null` for anything malformed — DESIGN S6 has copy for an incomplete
 * link, and guessing at a half-scanned QR would be worse than saying so.
 */
export function parsePairFragment(
  fragment: string,
): { code: string; vaultKey: string } | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;

  const code = raw.slice(0, dot);
  const vaultKey = raw.slice(dot + 1);
  if (code.length < 8 || vaultKey.length === 0) return null;

  return { code, vaultKey };
}

/**
 * Redeem a pairing code and store the credentials (PRD F4.1/F4.2).
 *
 * The key is imported *before* the network call, so a malformed key fails fast without
 * burning the single-use invite.
 */
export async function pair(
  code: string,
  vaultKey: string,
  deviceName: string,
): Promise<Credentials> {
  const key = await importVaultKeyFromBase64Url(vaultKey);

  const body: PairBody = { code, deviceName, kind: "phone" };
  const response = await fetch(`${API_BASE}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) throw await asVaultError(response);

  const enrolment = (await response.json()) as Enrolment;
  const credentials: Credentials = {
    vaultId: enrolment.vaultId,
    deviceId: enrolment.deviceId,
    deviceToken: enrolment.deviceToken,
    key,
  };

  await save(credentials, deviceName);
  return credentials;
}

/** Persist an enrolment. Only the `CryptoKey` handle is written, never the key bytes. */
async function save(credentials: Credentials, deviceName: string): Promise<void> {
  await Promise.all([
    set(KEYS.vaultId, credentials.vaultId),
    set(KEYS.deviceId, credentials.deviceId),
    set(KEYS.deviceToken, credentials.deviceToken),
    set(KEYS.vaultKey, credentials.key),
    set(KEYS.deviceName, deviceName),
  ]);
}

/**
 * Load the stored credentials, or `null` if this browser is not paired.
 *
 * All four are required together: a token without its key could talk to the server but
 * decrypt nothing, so a partial set reads as "not paired" rather than half-working.
 *
 * On iOS this is also the mechanism behind F4.8 — a home-screen app has its own storage, so
 * credentials saved in Safari are simply absent here, and the UI explains the re-scan.
 */
export async function loadCredentials(): Promise<Credentials | null> {
  const [vaultId, deviceId, deviceToken, key] = await Promise.all([
    get<string>(KEYS.vaultId),
    get<string>(KEYS.deviceId),
    get<string>(KEYS.deviceToken),
    get<CryptoKey>(KEYS.vaultKey),
  ]);

  if (!vaultId || !deviceId || !deviceToken || !key) return null;

  // A stored value that is not a CryptoKey means someone wrote to IndexedDB by hand, or an
  // older build stored bytes. Refusing is safer than trying to coerce it.
  if (!(key instanceof CryptoKey)) {
    console.error("the stored vault key is not a CryptoKey; treating this device as unpaired");
    return null;
  }

  return { vaultId, deviceId, deviceToken, key };
}

export async function deviceName(): Promise<string> {
  return (await get<string>(KEYS.deviceName)) ?? "This phone";
}

export async function setDeviceName(name: string): Promise<void> {
  await set(KEYS.deviceName, name);
}

/** Unpair (DESIGN S5 menu). Local only — the computer revokes server-side. */
export async function forget(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => del(key)));
}

/* ── Items ────────────────────────────────────────────────────────────────── */

/** An item plus its decrypted metadata, ready to render as a card. */
export type FeedItem = {
  summary: ItemSummary;
  meta: Meta;
};

function auth(credentials: Credentials): HeadersInit {
  return { Authorization: `Bearer ${credentials.deviceToken}` };
}

/**
 * The feed, newest first, with every item's metadata unsealed (PRD F4.4).
 *
 * An item whose metadata will not open is skipped rather than thrown on: that happens when
 * the vault was re-created and this phone still holds the previous key, and one stale item
 * must not blank the whole feed.
 */
export async function listItems(
  credentials: Credentials,
  since = 0,
): Promise<FeedItem[]> {
  const response = await fetch(
    `${API_BASE}/vaults/${credentials.vaultId}/items?since=${since}`,
    { headers: auth(credentials), cache: "no-store" },
  );
  if (!response.ok) throw await asVaultError(response);

  const summaries = (await response.json()) as ItemSummary[];
  const items: FeedItem[] = [];

  for (const summary of summaries) {
    try {
      items.push({
        summary,
        meta: await openMetaWith(credentials.key, summary.id, summary.meta),
      });
    } catch {
      console.warn(`could not read the metadata for item ${summary.id}; skipping it`);
    }
  }

  return items;
}

/**
 * Download and decrypt one item's image.
 *
 * Returns a `Blob` so it can go straight into an object URL, `navigator.share` or a
 * download — the plaintext never touches storage.
 */
export async function fetchImage(
  credentials: Credentials,
  item: FeedItem,
): Promise<Blob> {
  const response = await fetch(
    `${API_BASE}/vaults/${credentials.vaultId}/items/${item.summary.id}/blob`,
    { headers: auth(credentials), cache: "no-store" },
  );
  if (!response.ok) throw await asVaultError(response);

  const sealed = new Uint8Array(await response.arrayBuffer());
  const plain = await openWith(credentials.key, "item", item.summary.id, sealed);

  // `slice()` detaches the view from the larger decrypt buffer so the Blob owns its bytes.
  return new Blob([plain.slice().buffer as ArrayBuffer], { type: item.meta.mime });
}

/**
 * Seal a file and upload it (PRD F4.5 — the phone's "send to computer").
 *
 * Both the image and its metadata are sealed here, before anything leaves the phone, and
 * under different AAD kinds so the server cannot swap one for the other.
 */
export async function uploadImage(
  credentials: Credentials,
  file: File,
  ttl = "24h",
): Promise<string> {
  const itemId = newId();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { width, height } = await imageSize(file);

  const meta: Meta = {
    name: file.name || "Photo.jpg",
    mime: file.type || "image/jpeg",
    w: width,
    h: height,
    createdAt: Date.now(),
    origin: await deviceName(),
  };

  const [sealedImage, sealedMeta] = await Promise.all([
    sealWith(credentials.key, "item", itemId, bytes),
    sealMetaWith(credentials.key, itemId, meta),
  ]);

  const response = await fetch(
    `${API_BASE}/vaults/${credentials.vaultId}/items/${itemId}?ttl=${ttl}`,
    {
      method: "POST",
      headers: {
        ...auth(credentials),
        "Content-Type": "application/octet-stream",
        "X-Hopshot-Meta": sealedMeta,
      },
      body: sealedImage as BufferSource,
      cache: "no-store",
    },
  );
  if (!response.ok) throw await asVaultError(response);

  return itemId;
}

export async function deleteItem(
  credentials: Credentials,
  itemId: string,
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/vaults/${credentials.vaultId}/items/${itemId}`,
    { method: "DELETE", headers: auth(credentials), cache: "no-store" },
  );
  // Already gone is the outcome the caller wanted.
  if (!response.ok && response.status !== 404) throw await asVaultError(response);
}

export async function devices(credentials: Credentials): Promise<DeviceSummary[]> {
  const response = await fetch(`${API_BASE}/vaults/${credentials.vaultId}/devices`, {
    headers: auth(credentials),
    cache: "no-store",
  });
  if (!response.ok) throw await asVaultError(response);
  return (await response.json()) as DeviceSummary[];
}

/* ── Live ─────────────────────────────────────────────────────────────────── */

/**
 * A 60-second single-use WebSocket ticket (ARCHITECTURE §7.4).
 *
 * A browser cannot set `Authorization` on a WebSocket, so the device token is exchanged for
 * this over HTTP first. A ticket in a query string is acceptable where a key never would be:
 * it dies on first use and grants only a read-only event stream.
 */
export async function liveTicket(credentials: Credentials): Promise<string> {
  const response = await fetch(
    `${API_BASE}/vaults/${credentials.vaultId}/live-ticket`,
    { method: "POST", headers: auth(credentials), cache: "no-store" },
  );
  if (!response.ok) throw await asVaultError(response);
  return ((await response.json()) as LiveTicket).ticket;
}

/** `wss://…/vaults/{id}/live?ticket=…` for an already-minted ticket. */
export function liveUrl(credentials: Credentials, ticket: string): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/vaults/${credentials.vaultId}/live?ticket=${encodeURIComponent(ticket)}`;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Turn the API's `{error:{code,message}}` into something throwable and showable. */
async function asVaultError(response: Response): Promise<VaultError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) {
      return new VaultError(body.error.code ?? "server_error", body.error.message);
    }
  } catch {
    // A gateway error has no JSON body.
  }

  if (response.status === 401) {
    return new VaultError("unauthorized", "This phone is no longer paired.");
  }
  return new VaultError("server_error", "Hopshot couldn't reach the server.");
}

/**
 * An image's pixel dimensions, for the card aspect ratio on the other end.
 *
 * Falls back to zeroes rather than failing the upload: the dimensions are a presentation
 * nicety and a HEIC the browser cannot decode must still be sendable.
 */
async function imageSize(file: File): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== "function") return { width: 0, height: 0 };

  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Is this running as an installed home-screen app?
 *
 * On iOS a home-screen web app gets storage separate from Safari, so pairing has to be
 * completed *inside* the installed app (PRD F4.8). This is what the pairing screen branches
 * on to decide whether to show the Add-to-Home-Screen instructions.
 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;

  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari predates the media query and only exposes this non-standard flag.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;

  // iPadOS 13+ reports itself as a Mac, so touch points are what separate an iPad from a
  // desktop. `navigator.platform` would be the obvious check but it is deprecated.
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

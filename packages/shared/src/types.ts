/**
 * Shared API DTOs (ARCHITECTURE §7).
 *
 * The wire shapes for vaults, pairing, devices, items and live events. The Worker, the
 * desktop app and the phone PWA all read these, so a rename here is a compile error in
 * every consumer rather than a runtime surprise on someone's phone.
 *
 * Field names are camelCase on the wire even though D1 columns are snake_case — the routes
 * map between them explicitly.
 */

import type { Ttl } from "./limits.ts";

/** The error envelope every route uses on failure (ARCHITECTURE §7). */
export interface ApiError {
  readonly error: { readonly code: string; readonly message: string };
}

export type DeviceKind = "desktop" | "phone";

/* ── Vaults, pairing, devices (§7.2) ──────────────────────────────────────── */

/** `POST /vaults` body. */
export interface CreateVaultBody {
  readonly deviceName: string;
  readonly kind: "desktop";
}

/**
 * What a device gets on joining a vault, from `POST /vaults` or `POST /pair`.
 *
 * `deviceToken` is a bearer credential and is returned exactly once, at join time — the
 * server only keeps its hash. The desktop puts it in the OS keychain (CLAUDE.md rule 10);
 * the phone puts it in IndexedDB.
 */
export interface Enrolment {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly deviceToken: string;
}

/** `POST /vaults/{vaultId}/invites` → a single-use code, valid 10 minutes. */
export interface Invite {
  readonly code: string;
  readonly expiresAt: number;
}

/** `POST /pair` body. */
export interface PairBody {
  readonly code: string;
  readonly deviceName: string;
  readonly kind: DeviceKind;
}

/** A row in `GET /vaults/{vaultId}/devices` (DESIGN S7 "Devices"). */
export interface DeviceSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  /** True for the device that made the request, so the UI can label it "This computer". */
  readonly isSelf: boolean;
}

/* ── Vault items (§7.3) ───────────────────────────────────────────────────── */

/**
 * The per-item metadata envelope, sent in the `X-Hopshot-Meta` header.
 *
 * It travels **encrypted** — the plaintext file name never reaches the server (CLAUDE.md
 * privacy invariant), so this is what the client finds *inside* the sealed blob, not a
 * JSON body the Worker can read. The header carries the sealed bytes, base64url.
 */
export interface ItemMeta {
  readonly fileName: string;
  readonly width: number;
  readonly height: number;
  readonly originDevice?: string;
}

/** A row in `GET /vaults/{vaultId}/items`. */
export interface ItemSummary {
  readonly id: string;
  readonly sourceDeviceId: string;
  readonly size: number;
  /** The sealed `ItemMeta`, base64url — opaque to the server. */
  readonly meta: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** `POST /vaults/{vaultId}/items/{itemId}` → 201. */
export interface ItemCreated {
  readonly itemId: string;
  readonly expiresAt: number;
}

export type ItemTtl = Ttl;

/* ── Live updates (§7.4) ──────────────────────────────────────────────────── */

/** `POST /vaults/{vaultId}/live-ticket` → a 60-second single-use WebSocket ticket. */
export interface LiveTicket {
  readonly ticket: string;
  readonly expiresAt: number;
}

/**
 * Server → client events on the live socket (ARCHITECTURE §7.4).
 *
 * A discriminated union so a `switch` on `type` is exhaustive: adding an event without
 * handling it becomes a compile error in the desktop app and the PWA.
 */
export type LiveEvent =
  | { readonly type: "item.created"; readonly item: ItemSummary }
  | { readonly type: "item.deleted"; readonly id: string }
  | { readonly type: "device.joined"; readonly device: DeviceSummary }
  | { readonly type: "device.revoked"; readonly deviceId: string };

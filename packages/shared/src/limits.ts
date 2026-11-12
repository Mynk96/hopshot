/**
 * Typed loader for config/limits.json — the ONLY place plan limits live (CLAUDE.md rule 2,
 * ARCHITECTURE §4). Rust reads the same file via include_str! in
 * apps/desktop/src-tauri/src/limits.rs. Never hard-code a limit anywhere else.
 */
import limitsJson from "../../../config/limits.json";

/**
 * ARCHITECTURE §4 plan resolution order: expired → lifetime → sync.
 *
 * `expired` means "no active licence" — never bought, or bought and refunded. Hopshot is
 * pay-first (PRD F8.1): there is no trial, so an install holds no plan at all until a
 * purchase, and `expired` is where every new install starts.
 */
export type PlanName = "expired" | "lifetime" | "sync";

/** Item/drop time-to-live options, as they appear in the JSON and in `?ttl=` query params. */
export type Ttl = "1h" | "24h" | "7d";

export interface LifetimeLimits {
  readonly shelfCapacity: number;
  readonly itemTtlOptions: readonly Ttl[];
  readonly dropTtlOptions: readonly Ttl[];
  readonly dropsPerDay: number;
  readonly maxImageBytes: number;
  readonly maxComputers: number;
  readonly vault: boolean;
}

export interface SyncLimits {
  readonly requires: "lifetime";
  readonly dropTtlOptions: readonly Ttl[];
  readonly dropsPerDay: number;
  readonly vault: boolean;
  readonly maxPhones: number;
  readonly maxComputers: number;
  readonly vaultUploadsPerDay: number;
  readonly vaultLiveBytes: number;
}

export interface ServerLimits {
  readonly maxCiphertextBytes: number;
  readonly inviteTtlSeconds: number;
  readonly liveTicketTtlSeconds: number;
  readonly licenseRecheckDays: number;
  readonly licenseOfflineGraceDays: number;
  readonly perIpDropsPerDay: number;
}

/** Usage counts, the mailing list and in-app feedback (ARCHITECTURE §7.10). */
export interface InsightsLimits {
  readonly pingsPerIpPerDay: number;
  /** How many recent UTC days one ping may carry. */
  readonly pingMaxDays: number;
  readonly subscribesPerIpPerDay: number;
  readonly feedbackPerIpPerDay: number;
  readonly feedbackCommentMaxChars: number;
  /** The app asks "Is Hopshot useful?" once, this many days after its first ping… */
  readonly feedbackAfterDays: number;
  /** …and only after at least this many captures. */
  readonly feedbackMinCaptures: number;
}

export interface Limits {
  readonly lifetime: LifetimeLimits;
  readonly sync: SyncLimits;
  readonly server: ServerLimits;
  readonly insights: InsightsLimits;
}

/**
 * `as` is needed because a JSON import widens `"sync"` to `string`; the interfaces above keep
 * the literal types so call sites get them. The shape itself is checked for comparability
 * here, and the Rust loader asserts the same values in apps/desktop/src-tauri/src/limits.rs.
 */
export const limits = limitsJson as Limits;

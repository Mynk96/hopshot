/** Shape of a row from `list_items` (ARCHITECTURE §5.3 `items`). */
export type ShelfItem = {
  id: string;
  createdAt: number;
  /** `null` means pinned: it never expires (PRD F2.11). */
  expiresAt: number | null;
  source: "capture" | "clipboard" | "folder" | "phone" | "computer";
  originDevice: string | null;
  fileName: string;
  path: string;
  thumbPath: string;
  width: number;
  height: number;
  bytes: number;
};

export type Toast = { text: string; kind?: "info" | "error" };

/** DESIGN S3: the time chip turns warning-coloured under an hour left. */
export const WARN_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Time left on an item, as the chip shows it (PRD F2.3).
 *
 * Pinned items have no expiry and show a pin glyph instead of a countdown.
 */
export function timeLeft(item: ShelfItem, now = Date.now()): { label: string; warn: boolean } {
  if (item.expiresAt === null) return { label: "📌", warn: false };

  const remaining = item.expiresAt - now;
  if (remaining <= 0) return { label: "0m", warn: true };

  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) return { label: `${Math.max(1, minutes)}m`, warn: true };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { label: `${hours}h`, warn: remaining < WARN_THRESHOLD_MS };

  return { label: `${Math.floor(hours / 24)}d`, warn: false };
}

/** Mirrors `license::PlanState` — PRD F8.1/F8.1a. */
export type PlanState = {
  plan: "expired" | "lifetime" | "sync";
  /** Nothing has been bought yet: capture is paused, the shelf is not (PRD F8.1). */
  capturePaused: boolean;
};

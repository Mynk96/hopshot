import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Icon } from "../shelf/icons";

/**
 * Over the computer limit (DESIGN S9, PRD F8.3).
 *
 * One computer on Lifetime, three while Sync is active. When the limit drops — a bundle's
 * included Sync year ending — the licence can hold more slots than it is now allowed, so the
 * server keeps the most recently seen devices valid and tells the rest `over_limit`. This is
 * what those machines see.
 *
 * Three shapes, exactly as S9 specifies:
 *
 * - **Lifetime (1)**: "Hopshot is active on {other}. Move it here?" with **Move here** and a
 *   small *Add Sync to use up to 3 computers* link.
 * - **Lifetime + Sync (3)**: "Hopshot is on 3 computers. Remove one to use it here." with the
 *   list and Remove buttons.
 * - **After Sync ends**: the Lifetime shape, but the link reads *Renew Sync*.
 */

export type LicensedComputer = {
  id: string;
  label: string;
  lastSeenAt: number;
  isSelf: boolean;
};

export type LicenseStatus = {
  valid: boolean;
  reason?: string | null;
  plan: string;
  limit?: number | null;
  syncActive?: boolean | null;
  /** Unix ms when Sync lapses if nothing is renewed; null once it is off. */
  syncEndsAt?: number | null;
  devices?: LicensedComputer[] | null;
};

export function OverLimit({
  status,
  onResolved,
}: {
  status: LicenseStatus;
  onResolved: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const others = (status.devices ?? []).filter((device) => !device.isSelf);
  const limit = status.limit ?? 1;

  /*
   * A limit above one means Sync is still active, so this is the "remove one" case. At one,
   * it is the move case — and whether the link offers *Add Sync* or *Renew Sync* depends on
   * whether this licence ever had Sync, which is what `plan` tells us: a bundle whose year
   * lapsed reports `lifetime`, same as a plain Lifetime, so the distinguishing signal is
   * `syncActive === false` on a licence that has devices beyond the cap.
   */
  const isMoveCase = limit <= 1;
  const hadSync = status.plan === "sync" || (status.syncActive === false && others.length > 1);

  const moveHere = async (releaseDeviceId: string) => {
    setBusy(releaseDeviceId);
    setError(null);
    try {
      await invoke("license_move_here", { releaseDeviceId });
      await onResolved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (deviceId: string) => {
    setBusy(deviceId);
    setError(null);
    try {
      await invoke("license_remove_computer", { deviceId });
      await onResolved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h3 className="text-title">
          {isMoveCase
            ? others.length === 1
              ? `Hopshot is active on ${others[0]!.label}. Move it here?`
              : "Hopshot is active on another computer. Move it here?"
            : `Hopshot is on ${limit} computers. Remove one to use it here.`}
        </h3>
        <p className="text-small text-text-2">
          {isMoveCase
            ? "Your licence covers one computer at a time. Moving it here frees the other one."
            : "Pick one to free up. You can move it back whenever you like."}
        </p>
      </header>

      {error && (
        <p
          className="text-small"
          style={{
            background: "color-mix(in srgb, var(--danger) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
            borderRadius: "var(--radius-control)",
            color: "var(--danger)",
            padding: "8px 10px",
          }}
        >
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {others.map((device) => (
          <li
            key={device.id}
            className="flex items-center gap-2.5"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              padding: "9px 11px",
            }}
          >
            <span style={{ color: "var(--text-2)", display: "grid" }}>
              <Icon name="layers" size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body-strong">{device.label}</span>
              <span className="text-caption text-text-2">{lastUsed(device.lastSeenAt)}</span>
            </span>
            <button
              type="button"
              className={isMoveCase ? "btn btn-primary btn-compact" : "btn btn-danger-ghost btn-compact"}
              disabled={busy !== null}
              onClick={() => void (isMoveCase ? moveHere(device.id) : remove(device.id))}
            >
              {busy === device.id ? "Working…" : isMoveCase ? "Move here" : "Remove"}
            </button>
          </li>
        ))}
      </ul>

      {/*
        S9: the Lifetime case carries a small upsell link, which reads "Renew Sync" when this
        licence used to have Sync rather than never having had it.
      */}
      {isMoveCase && (
        <button
          type="button"
          className="btn btn-ghost btn-compact self-start text-caption"
          onClick={() => void invoke("open_plans").catch(() => undefined)}
        >
          {hadSync ? "Renew Sync" : "Add Sync to use up to 3 computers"}
        </button>
      )}

      <p className="text-caption text-text-3">Secure checkout by Stripe · 14-day refund</p>
    </section>
  );
}

/** "2 days ago" — coarse on purpose; the exact minute is not a decision input. */
function lastUsed(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 2) return "Last used just now";
  if (minutes < 60) return `Last used ${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last used ${hours} h ago`;

  const days = Math.round(hours / 24);
  return `Last used ${days} day${days === 1 ? "" : "s"} ago`;
}

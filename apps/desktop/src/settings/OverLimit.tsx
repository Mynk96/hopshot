import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Icon } from "../shelf/icons";

/**
 * Over the computer limit (DESIGN S9, PRD F8.3).
 *
 * Three computers on the current $19 licence, one on a pre-launch Lifetime licence. A
 * licence can hold more slots than it is allowed — usually an old licence that was used on
 * several machines — so the server keeps the most recently seen devices valid and tells the
 * rest `over_limit`. This is what those machines see.
 *
 * Two shapes now that there is one plan (PRD §7):
 *
 * - **Three computers**: "Hopshot is on 3 computers. Remove one to use it here." with the
 *   list and Remove buttons.
 * - **One computer** (pre-launch licence): "Hopshot is active on {other}. Move it here?"
 *   with **Move here**. S9's *Add Sync* link is gone — Sync is not sold separately.
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
   * A limit above one is the current $19 licence, so this is the "remove one" case. At one
   * it is a pre-launch Lifetime licence, and the only option is moving the licence rather
   * than freeing a slot — there is no longer an add-on to sell that would raise the cap.
   */
  const isMoveCase = limit <= 1;

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
        S9 used to carry an "Add Sync" upsell here. Sync is not sold separately any more
        (PRD §7), so there is nothing to offer: a one-computer licence is a pre-launch one,
        and the only route to three is a conversation, not a checkout.
      */}
      {isMoveCase && (
        <p className="text-caption text-text-3">
          This is a pre-launch licence, good for one computer. Email founder@hopshot.xyz if
          you need it on more.
        </p>
      )}
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

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../shelf/icons";
import { Row, Switch } from "./controls";
import type { AppSettings } from "./types";

/**
 * Settings → Devices (DESIGN S7, PRD F4.1/F4.7).
 *
 * Shows the paired list, mints a pairing QR, and revokes a device.
 *
 * **The QR is the one place the vault key is ever visible.** `pairing.url` contains
 * `#{code}.{vaultKey}`, so it is rendered as a code and never written to the DOM as text,
 * never logged, and never copied to the clipboard — unlike the drop popover, where the link
 * is meant to be shared. Only the host is shown in words.
 */

type DeviceSummary = {
  id: string;
  name: string;
  kind: "desktop" | "phone";
  createdAt: number;
  lastSeenAt: number | null;
  isSelf: boolean;
};

type Pairing = { url: string; expiresAt: number; qrSvg: string };

export function Devices({
  settings,
  onUpdate,
}: {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const vaultId = await invoke<string | null>("vault_status");
      setPaired(vaultId !== null);

      if (vaultId === null) {
        setDevices([]);
        return;
      }
      setDevices(await invoke<DeviceSummary[]>("list_devices"));
      setError(null);
    } catch (reason) {
      // Offline is the common case here and reads badly as a red error, so it keeps the
      // DESIGN §5 wording rather than the raw message.
      setError(String(reason));
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refresh();

    // Rust emits this when the live socket sees device.joined / device.revoked, so the
    // list updates the moment a phone finishes scanning.
    const subscription = listen("devices:changed", () => void refresh());
    return () => {
      void subscription.then((off) => off());
    };
  }, [refresh]);

  const startPairing = async () => {
    setBusy(true);
    setError(null);
    try {
      setPairing(await invoke<Pairing>("pair_phone"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (device: DeviceSummary) => {
    try {
      await invoke("revoke_device", { deviceId: device.id });
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-title">Devices</h2>
        <p className="text-small text-text-2">
          Captures sync to these devices, end-to-end encrypted. Everything expires.
        </p>
      </section>

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

      {devices === null ? (
        <p className="text-small text-text-2">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="text-small text-text-2">
          {paired
            ? "No devices yet."
            : "No phone paired yet. Pair one to send screenshots straight to it."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {devices.map((device) => (
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
                <Icon name={device.kind === "phone" ? "smartphone" : "layers"} size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body-strong">
                  {device.name}
                  {device.isSelf && (
                    <span className="ml-1.5 text-caption font-normal text-text-3">
                      This computer
                    </span>
                  )}
                </span>
                <span className="text-caption text-text-2">{lastSeen(device.lastSeenAt)}</span>
              </span>
              {/* A computer cannot remove itself — there would be no token left to pair with. */}
              {!device.isSelf && (
                <button
                  type="button"
                  className="btn btn-danger-ghost btn-compact"
                  onClick={() => void revoke(device)}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* DESIGN S7 → Devices. Only meaningful once something is paired. */}
      <Row
        label="Auto-sync captures to my devices"
        hint="Every new capture is encrypted and sent to your paired phones."
      >
        <Switch
          label="Auto-sync captures to my devices"
          checked={settings.autoSync}
          disabled={paired !== true}
          onChange={(autoSync) => onUpdate({ autoSync })}
        />
      </Row>

      {pairing ? (
        <PairingCard pairing={pairing} onDone={() => setPairing(null)} />
      ) : (
        <div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void startPairing()}
          >
            <Icon name="smartphone" size={14} />
            {busy ? "Preparing…" : "Pair a phone"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The pairing QR. Valid for 10 minutes and single-use (ARCHITECTURE §7.2).
 *
 * The URL is deliberately not shown or copyable: its fragment is the vault key, and unlike a
 * drop link this is not meant to be shared with anyone but the user's own phone.
 */
function PairingCard({ pairing, onDone }: { pairing: Pairing; onDone: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [pairing.expiresAt]);

  const expired = secondsLeft === 0;
  // Only the host, never the fragment.
  const host = (() => {
    try {
      return new URL(pairing.url).host;
    } catch {
      return "hopshot.xyz";
    }
  })();

  return (
    <div
      className="raised flex flex-col items-center gap-3 self-start p-4"
      style={{ width: 268 }}
    >
      <b className="text-body-strong">Scan with your phone</b>

      <div
        className="grid aspect-square w-full place-items-center"
        style={{
          background: "#fff",
          borderRadius: "var(--radius-card)",
          padding: 10,
          // An expired code should not look scannable.
          opacity: expired ? 0.25 : 1,
        }}
      >
        <div
          className="size-full [&>svg]:block [&>svg]:size-full"
          // Built by qrcode-rs in our own process from a URL we generated.
          dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
        />
      </div>

      {expired ? (
        <p className="text-caption text-text-2">
          This code expired. Make a new one to pair.
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-caption text-text-2">
          <Icon name="lock" size={11} />
          Expires in {formatCountdown(secondsLeft)} · {host}
        </p>
      )}

      <p className="text-caption leading-4 text-text-3" style={{ textAlign: "center" }}>
        On iPhone, add Hopshot to your Home Screen first, then scan again from inside the app.
      </p>

      <button type="button" className="btn btn-secondary btn-compact w-full" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

function lastSeen(at: number | null): string {
  if (at === null) return "Never used";

  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "Active now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

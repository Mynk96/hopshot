import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { OverLimit, type LicenseStatus } from "./OverLimit";

/**
 * Settings → License (DESIGN S7, S9).
 *
 * The over-limit case is the substance here: PRD F8.3 gives Lifetime one computer and Sync
 * three, so a licence can end up holding more slots than it is allowed — most often when a
 * bundle's included Sync year runs out. `OverLimit` renders S9's chooser for that.
 *
 * Buying and restoring arrive with the plans sheet; this pane reports what the server says
 * and offers the one action a blocked computer actually needs.
 */
export function License() {
  const [status, setStatus] = useState<LicenseStatus | null | "loading">("loading");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setStatus(await invoke<LicenseStatus | null>("license_status"));
    } catch (reason) {
      // Offline is the common case; the app keeps working on its cached state.
      setError(String(reason));
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (status === "loading") {
    return <p className="text-small text-text-2">Checking your licence…</p>;
  }

  if (status && !status.valid && status.reason === "over_limit") {
    return <OverLimit status={status} onResolved={refresh} />;
  }

  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-title">License</h3>

      {error && <p className="text-small text-text-2">{error}</p>}

      {status === null && (
        <p className="text-body text-text-2">
          You're on the free trial. Everything is unlocked, including Sync.
        </p>
      )}

      {status?.valid && (
        <div className="flex flex-col gap-1">
          <b className="text-body-strong">
            {status.plan === "sync" ? "Lifetime + Sync" : "Lifetime"}
          </b>
          <span className="text-small text-text-2">
            {status.limit === 1
              ? "Covers one computer at a time."
              : `Covers up to ${status.limit} computers.`}
          </span>
        </div>
      )}

      {status && !status.valid && status.reason === "revoked" && (
        <p className="text-body" style={{ color: "var(--danger)" }}>
          This licence is no longer active. If that's unexpected, reply to your receipt email.
        </p>
      )}

      <p className="text-caption text-text-3">
        There is no licence key — your purchase belongs to the email you bought with.
      </p>
    </section>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

  const [buying, setBuying] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();

    /*
     * The unlock arrives asynchronously: the user pays in a browser window we do not
     * control, and Rust reports through this event once the claim poll collects a token.
     * Without it the pane would sit on "Finish paying in your browser" until reopened.
     */
    const subscription = listen("license:changed", () => {
      setBuying(null);
      void refresh();
    });
    return () => {
      void subscription.then((off) => off());
    };
  }, [refresh]);

  /*
   * PRD F8.8: the bundle's year of Sync does not renew itself. Showing the date is what keeps
   * that honest — the customer learns when their phones stop pairing from this pane, not from
   * the day it happens.
   */
  const manageSync = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("license_manage_sync");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const buy = async (plan: "lifetime" | "bundle") => {
    setBuying(plan);
    setError(null);
    try {
      await invoke("license_buy", { plan });
    } catch (reason) {
      setError(String(reason));
      setBuying(null);
    }
  };

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
        <>
          <p className="text-body text-text-2">
            You&apos;re on the free trial. Everything is unlocked, including Sync.
          </p>

          {/* DESIGN S9 price block, at the launch prices from PRD §7. */}
          {buying ? (
            <p className="text-body text-text-2">Finish paying in your browser…</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void buy("lifetime")}
                >
                  Buy Lifetime · $12
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void buy("bundle")}
                >
                  Buy Lifetime + Sync · $19
                </button>
              </div>
              <span className="text-caption text-text-3">
                Lifetime covers one computer. Sync adds three computers, three phones and
                longer links, and includes the first year.
              </span>
            </div>
          )}
        </>
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

          {status.syncActive && status.syncEndsAt && (
            <span className="text-small text-text-2">
              Sync runs until {formatDate(status.syncEndsAt)}. Nothing renews on its own —
              we&apos;ll email you before then.
            </span>
          )}

          {!status.syncActive && (
            <span className="text-small text-text-2">
              Sync is off, so phones and extra computers are paused. The rest of Hopshot is
              yours for good.
            </span>
          )}

          {status.plan === "sync" && (
            <button
              type="button"
              className="btn btn-secondary mt-2 self-start"
              disabled={busy}
              onClick={() => void manageSync()}
            >
              {busy ? "Opening…" : "Manage Sync"}
            </button>
          )}
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

/** "4 March 2027" — a plain date, because a countdown would read as pressure. */
function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

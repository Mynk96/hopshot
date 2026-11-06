import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/**
 * Send to phone (DESIGN S4, PRD F3).
 *
 * Two paths, and the right one is chosen for the user:
 *
 * 1. **A phone is paired** → the item goes straight into the vault and appears in that
 *    phone's feed in seconds. No QR, no scanning, and no public link created at all.
 *    DESIGN S4: *"instead of the QR, show 'Sent to Mayank's iPhone ✓' with a 'Show QR
 *    instead' link"*. This is the common case once someone has set Hopshot up, and it used
 *    to be unreachable — every send showed a QR as though nothing were paired.
 * 2. **Nothing paired, or the user wants a link to share** → create a drop and show the QR.
 *
 * The QR path widens the shelf while it is open. DESIGN S4 specifies a 260 px popover and
 * the shelf is 208 px, so a code squeezed inside rendered at about 148 px — dense enough
 * that phone cameras could not lock onto it.
 */

type Drop = { id: string; url: string; expiresAt: number; qrSvg: string };

type Mode =
  /** No licence on this computer: the phone is the paid part (free shelf, phase 1). */
  | { name: "paywall" }
  | { name: "deciding" }
  | { name: "sending" }
  | { name: "sent"; phones: string[] }
  | { name: "qr"; label: string }
  | { name: "ready"; drop: Drop }
  | { name: "failed"; message: string };

/** Height the shelf is grown to while the sheet is open, so the QR has room. */
const SHEET_HEIGHT = 520;
/** Quiet zone around the code; scanners need the margin. */
const QUIET_ZONE_PX = 12;

export function SendSheet({
  itemId,
  paywall,
  onClose,
  onToast,
}: {
  itemId: string;
  /** True when nothing has been bought: show the offer instead of calling the server. */
  paywall: boolean;
  onClose: () => void;
  onToast: (text: string, kind?: "info" | "error") => void;
}) {
  const [mode, setMode] = useState<Mode>(paywall ? { name: "paywall" } : { name: "deciding" });
  const container = useRef<HTMLDivElement>(null);
  /** Tracks whether the shelf is currently widened, so it is always restored once. */
  const widened = useRef(false);

  const widen = useCallback(async (wide: boolean) => {
    if (widened.current === wide) return;
    widened.current = wide;
    try {
      await invoke("set_shelf_wide", { wide, height: wide ? SHEET_HEIGHT : 420 });
    } catch (error) {
      console.error("could not resize the shelf", error);
    }
  }, []);

  /** Create the drop and show its QR. Also the "Show QR instead" action. */
  const showQr = useCallback(async () => {
    setMode({ name: "qr", label: "Encrypting…" });
    await widen(true);

    try {
      const drop = await invoke<Drop>("send_drop", { id: itemId });
      setMode({ name: "ready", drop });
    } catch (error) {
      setMode({ name: "failed", message: String(error) });
    }
  }, [itemId, widen]);

  useEffect(() => {
    // The server would refuse every phone action anyway; the offer is the honest answer.
    if (paywall) return;
    let cancelled = false;

    void (async () => {
      // Ask first, so a paired user never sees a QR they do not need.
      const phones = await invoke<string[]>("paired_phones").catch(() => [] as string[]);
      if (cancelled) return;

      if (phones.length === 0) {
        await showQr();
        return;
      }

      setMode({ name: "sending" });
      try {
        const sentTo = await invoke<string[]>("send_to_phones", { id: itemId });
        if (cancelled) return;

        // An empty list means the phone disappeared between the two calls.
        if (sentTo.length === 0) await showQr();
        else setMode({ name: "sent", phones: sentTo });
      } catch (error) {
        if (cancelled) return;
        setMode({ name: "failed", message: String(error) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [itemId, showQr, paywall]);

  // Always hand the shelf back its width, however the sheet closes.
  useEffect(() => {
    return () => {
      if (widened.current) void invoke("set_shelf_wide", { wide: false, height: 420 });
    };
  }, []);

  // Esc or a click outside, like the More menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose();
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose]);

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url);
    onToast("Link copied");
  };

  const deleteNow = async (drop: Drop) => {
    try {
      await invoke("delete_drop", { id: itemId });
      onToast("Deleted from the cloud");
      onClose();
    } catch (error) {
      console.error("could not delete the drop", drop.id, error);
      onToast("That link couldn't be deleted.", "error");
    }
  };

  return (
    <div
      ref={container}
      role="dialog"
      aria-label="Send to phone"
      className="raised hop-in absolute inset-x-2 bottom-11 z-20 flex flex-col gap-2.5 p-3"
    >
      <header className="flex items-center gap-1.5">
        <b className="flex-1 text-body-strong">
          {mode.name === "sent"
            ? "Sent"
            : mode.name === "paywall"
              ? "Phone · $19 once"
              : "Send to phone"}
        </b>
        <button type="button" className="icon-btn size-6" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>

      {mode.name === "deciding" && <p className="text-caption text-text-2">Checking…</p>}

      {/* Free shelf, paid phone: the offer appears at the moment of intent, never as a nag. */}
      {mode.name === "paywall" && (
        <>
          <p className="text-caption leading-4 text-text-2">
            Send to phone, share links and a paired phone feed. Pay once, no subscription. 14-day
            refund, no questions.
          </p>
          {/* Stacked: the shelf is 208px and this sheet does not widen it (no QR to fit). */}
          <div className="flex flex-col items-start gap-1">

            <button
              type="button"
              className="btn btn-primary btn-compact text-caption"
              onClick={() =>
                void invoke("license_buy", { plan: "bundle" }).catch(() =>
                  onToast("Couldn't open checkout. Try again in a moment.", "error"),
                )
              }
            >
              Buy · $19 once
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-compact text-caption"
              onClick={() =>
                void invoke("open_settings", { tab: "license" }).catch(() => undefined)
              }
            >
              Already bought? Restore
            </button>
          </div>
        </>
      )}

      {mode.name === "sending" && (
        <p className="flex items-center gap-1.5 text-caption text-text-2">
          <Icon name="lock" size={11} />
          Encrypting and sending…
        </p>
      )}

      {/* DESIGN S4: the paired case. No QR, nothing to scan. */}
      {mode.name === "sent" && (
        <>
          <div className="flex items-center gap-2.5 py-1">
            <span
              aria-hidden
              className="grid shrink-0 place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: "var(--radius-chip)",
                background: "color-mix(in srgb, var(--success) 18%, transparent)",
                color: "var(--success)",
              }}
            >
              <Icon name="check" size={17} />
            </span>
            <span className="flex min-w-0 flex-col">
              <b className="truncate text-body-strong">Sent to {mode.phones.join(", ")}</b>
              <span className="text-caption text-text-2">It should be there already.</span>
            </span>
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-compact self-start text-caption"
            onClick={() => void showQr()}
          >
            Show QR instead
          </button>
        </>
      )}

      {mode.name === "qr" && <Shimmer label={mode.label} />}

      {mode.name === "failed" && (
        <p className="text-caption" style={{ color: "var(--danger)" }}>
          {mode.message}
        </p>
      )}

      {mode.name === "ready" && (
        <>
          <QrTile svg={mode.drop.qrSvg} />

          <div className="flex items-center gap-1.5">
            <code
              title={mode.drop.url}
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-caption text-text-2"
              style={{
                fontFamily: "var(--mono)",
                background: "var(--surface-raised-2)",
                border: "1px solid var(--raised-border)",
                borderRadius: 6,
                padding: "5px 7px",
              }}
            >
              {/* Truncated by CSS, never cut in the string: Copy must give the whole key. */}
              {mode.drop.url}
            </code>
            <button
              type="button"
              onClick={() => void copyLink(mode.drop.url)}
              className="btn btn-secondary btn-compact shrink-0 text-caption"
            >
              Copy
            </button>
          </div>

          <p className="flex items-center gap-1.5 text-caption text-text-2">
            <Icon name="lock" size={11} />
            <span>Expires in {untilLabel(mode.drop.expiresAt)}</span>
            <span aria-hidden>·</span>
            <span>Encrypted</span>
          </p>
        </>
      )}

      {mode.name !== "paywall" && (
        <div
          className="flex items-center justify-between gap-2"
          style={{ borderTop: "1px solid var(--raised-border)", paddingTop: 8 }}
        >
          <button
            type="button"
            disabled={mode.name !== "ready"}
            onClick={() => mode.name === "ready" && void deleteNow(mode.drop)}
            className="btn btn-danger-ghost btn-compact text-caption"
          >
            Delete now
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-primary btn-compact text-caption"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The QR on a white tile — always light, whatever the theme, because scanners need the
 * dark-on-light polarity and a quiet border.
 *
 * `imageRendering: pixelated` matters: the SVG's modules are whole pixels, and the browser's
 * default smoothing blurs their edges at small sizes, which is exactly what stops a camera
 * resolving them.
 */
function QrTile({ svg }: { svg: string }) {
  return (
    <div
      className="relative grid aspect-square w-full place-items-center"
      style={{
        background: "#fff",
        borderRadius: "var(--radius-card)",
        padding: QUIET_ZONE_PX,
      }}
    >
      <div
        className="size-full [&>svg]:block [&>svg]:size-full"
        style={{ imageRendering: "pixelated" }}
        // Built by qrcode-rs in our own process from a URL we generated.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

function Shimmer({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="aspect-square w-full animate-pulse"
        style={{ background: "var(--surface-raised-2)", borderRadius: "var(--radius-card)" }}
      />
      <span className="flex items-center gap-1.5 text-caption text-text-2">
        <Icon name="lock" size={12} />
        {label}
      </span>
    </div>
  );
}

/** "23h" / "45m" — the sheet shows a coarse figure; the viewer counts down live. */
function untilLabel(expiresAt: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

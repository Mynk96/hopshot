import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/**
 * Send to phone — the QR popover (DESIGN S4, PRD F3).
 *
 * Loading → QR on a white tile with the mark in the middle → link + Copy → expiry line →
 * Delete now / Done.
 *
 * The QR SVG and the URL both come from Rust: it holds the key, seals the image and builds
 * `https://app.hopshot.xyz/d/{id}#{key}`. This component never sees a key except as part of
 * that string, and never sends it anywhere.
 *
 * Two things here are load-bearing rather than decorative:
 *
 * 1. **The panel is opaque** (`.raised`). It used to use `--surface-3`, which is a 4-10%
 *    hover tint — as a panel background that left the popover ~90% transparent, so the
 *    wallpaper showed through the QR and the text was unreadable.
 * 2. **The tile is sized to fit.** DESIGN S4 asks for a 260 px popover with a 180 px QR,
 *    but the shelf window is 208 px wide (DESIGN S3), so a 180 px tile plus padding
 *    overflowed its own panel. The tile is measured from the panel instead, and keeps the
 *    white quiet zone a scanner needs to find the code at all.
 */

type Drop = { id: string; url: string; expiresAt: number; qrSvg: string };

type State =
  | { phase: "working"; label: string }
  | { phase: "ready"; drop: Drop }
  | { phase: "failed"; message: string };

/** Quiet zone around the code. Below ~8 px scanners start failing on busy backgrounds. */
const QUIET_ZONE_PX = 10;

export function QrPopover({
  itemId,
  onClose,
  onToast,
}: {
  itemId: string;
  onClose: () => void;
  onToast: (text: string, kind?: "info" | "error") => void;
}) {
  const [state, setState] = useState<State>({ phase: "working", label: "Encrypting…" });
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    // DESIGN S4 loading copy: the encrypt is local and quick, the upload is the wait.
    const uploading = setTimeout(() => {
      if (!cancelled) setState({ phase: "working", label: "Uploading…" });
    }, 400);

    // No ttl: the lifetime is a plan limit, so Rust reads it from config/limits.json.
    void invoke<Drop>("send_drop", { id: itemId })
      .then((drop) => {
        if (!cancelled) setState({ phase: "ready", drop });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: "failed", message: String(error) });
      })
      .finally(() => clearTimeout(uploading));

    return () => {
      cancelled = true;
      clearTimeout(uploading);
    };
  }, [itemId]);

  // Dismiss on Esc or a click outside, like the More menu.
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
        <b className="flex-1 text-body-strong">Scan with your phone</b>
        <button type="button" className="icon-btn size-6" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>

      {state.phase === "working" && <Shimmer label={state.label} />}

      {state.phase === "failed" && (
        <p className="text-caption" style={{ color: "var(--danger)" }}>
          {state.message}
        </p>
      )}

      {state.phase === "ready" && (
        <>
          <QrTile svg={state.drop.qrSvg} />

          <div className="flex items-center gap-1.5">
            <code
              title={state.drop.url}
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-caption text-text-2"
              style={{
                fontFamily: "var(--mono)",
                background: "var(--surface-raised-2)",
                border: "1px solid var(--raised-border)",
                borderRadius: 6,
                padding: "5px 7px",
              }}
            >
              {/* Shown truncated by CSS, never cut in the string: Copy must give the key. */}
              {state.drop.url}
            </code>
            <button
              type="button"
              onClick={() => void copyLink(state.drop.url)}
              className="btn btn-secondary btn-compact shrink-0 text-caption"
            >
              Copy
            </button>
          </div>

          <p className="flex items-center gap-1.5 text-caption text-text-2">
            <Icon name="lock" size={11} />
            <span>Expires in {untilLabel(state.drop.expiresAt)}</span>
            <span aria-hidden>·</span>
            <span>Encrypted</span>
          </p>
        </>
      )}

      <div
        className="flex items-center justify-between gap-2"
        style={{ borderTop: "1px solid var(--raised-border)", paddingTop: 8 }}
      >
        <button
          type="button"
          disabled={state.phase !== "ready"}
          onClick={() => state.phase === "ready" && void deleteNow(state.drop)}
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
    </div>
  );
}

/**
 * DESIGN S4: the QR on a white tile — always light, whatever the theme, because scanners
 * need the dark-on-light polarity and a quiet border. The tile fills the popover's width
 * rather than taking a fixed 180 px it does not have room for.
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
      {/* The SVG is built by Rust from the link; nothing here is user input. */}
      <div
        className="size-full [&>svg]:block [&>svg]:size-full"
        // The SVG comes from qrcode-rs in our own process, built from a URL we generated.
        // No user input reaches it.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {/*
        The mark in the centre. Error correction is M (recovers ~15% of modules), so the
        patch has to stay well under that: at 17% of the tile's width it hides ~3%.
      */}
      <span
        aria-hidden
        className="absolute grid place-items-center"
        style={{ width: "17%", height: "17%", background: "#fff", borderRadius: 7 }}
      >
        <span
          style={{ width: "62%", height: "62%", background: "var(--accent)", borderRadius: 4 }}
        />
      </span>
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

/** "23h" / "45m" — the popover shows a coarse figure; the viewer counts down live. */
function untilLabel(expiresAt: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

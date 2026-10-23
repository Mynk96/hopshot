import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Capture overlay (DESIGN S2, PRD F1.2–F1.3).
 *
 * One of these runs per monitor, in its own `overlay-{monitorId}` window that covers that
 * monitor exactly. All geometry here is CSS px relative to this window, which is what
 * `crop::to_physical` expects — Rust converts to physical pixels using this monitor's own
 * scale factor.
 */

/** Payload of `overlay:start`, built in Rust so the URL scheme can differ per platform. */
type OverlayStart = {
  monitorId: number;
  frameUrl: string;
  width: number;
  height: number;
  scaleFactor: number;
};

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

/** A drag shorter than this is a click: capture the whole monitor (PRD F1.3). */
const CLICK_SLOP_PX = 4;
/** DESIGN S2: 80 ms white flash inside the selection on commit. */
const FLASH_MS = 80;
/** Keeps the size label from touching the screen edge when it flips. */
const LABEL_MARGIN_PX = 8;

function rectFrom(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Overlay() {
  const [start, setStart] = useState<OverlayStart | null>(null);
  const [origin, setOrigin] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [flash, setFlash] = useState<Rect | null>(null);

  // Read inside global key handlers, which would otherwise close over a stale selection.
  const live = useRef({ start, origin, cursor });
  live.current = { start, origin, cursor };

  useEffect(() => {
    const begin = (next: OverlayStart) => {
      setStart(next);
      setOrigin(null);
      setCursor(null);
      setFlash(null);
    };

    // Subscribed to this window only: Rust addresses `overlay:start` at one overlay, and a
    // listener registered without a target receives every target's events, so an untargeted
    // subscription would still see the other monitors' payloads.
    const label = getCurrentWindow().label;
    const pending = listen<OverlayStart>("overlay:start", (event) => begin(event.payload), {
      target: label,
    });

    // A window created for a newly attached monitor misses the event that opened this
    // capture, so ask for the current state once on mount.
    const monitorId = Number(label.replace("overlay-", ""));
    if (Number.isFinite(monitorId)) {
      void invoke<OverlayStart | null>("overlay_pending", { monitorId }).then((current) => {
        if (current) begin(current);
      });
    }

    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  const cancel = useCallback(() => {
    setOrigin(null);
    setCursor(null);
    void invoke("overlay_cancel");
  }, []);

  /** Flash the selection, then hand the rect to Rust (DESIGN S2 "Committed"). */
  const commit = useCallback(async (monitorId: number, rect: Rect) => {
    if (rect.width < 1 || rect.height < 1) return;

    if (!prefersReducedMotion()) {
      setFlash(rect);
      await new Promise((resolve) => setTimeout(resolve, FLASH_MS));
      setFlash(null);
    }
    setOrigin(null);
    setCursor(null);
    await invoke("overlay_commit", { monitorId, rect });
  }, []);

  const commitFullScreen = useCallback(async (monitorId: number) => {
    setOrigin(null);
    setCursor(null);
    await invoke("overlay_commit_full", { monitorId });
  }, []);

  // PRD F1.3: Esc cancels, F captures the whole monitor, Enter commits the selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { start: current, origin: from, cursor: to } = live.current;
      if (!current) return;

      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        void commitFullScreen(current.monitorId);
        return;
      }
      if (event.key === "Enter" && from && to) {
        event.preventDefault();
        void commit(current.monitorId, rectFrom(from, to));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, commit, commitFullScreen]);

  if (!start) return null;

  const selection = origin && cursor ? rectFrom(origin, cursor) : null;
  const dragging = selection !== null && (selection.width > 0 || selection.height > 0);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    setOrigin(point);
    setCursor(point);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    setCursor({ x: event.clientX, y: event.clientY });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!origin) return;
    const end = { x: event.clientX, y: event.clientY };
    const rect = rectFrom(origin, end);

    // A click without a drag captures this whole monitor (PRD F1.3).
    if (rect.width < CLICK_SLOP_PX && rect.height < CLICK_SLOP_PX) {
      void commitFullScreen(start.monitorId);
      return;
    }
    void commit(start.monitorId, rect);
  };

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{ cursor: "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* The frozen screen. draggable=false stops the webview starting an image drag. */}
      <img
        src={start.frameUrl}
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none"
      />

      {/* DESIGN S2: the whole frame is dimmed… */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "var(--overlay-dim)" }}
      />

      {/* …except the selection, which shows the undimmed pixels underneath. */}
      {dragging && selection && (
        <div
          className="pointer-events-none absolute overflow-hidden"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
            // 1 px white inner border, 1 px black outer border.
            boxShadow: "inset 0 0 0 1px #fff, 0 0 0 1px #000",
          }}
        >
          <img
            src={start.frameUrl}
            alt=""
            draggable={false}
            className="absolute max-w-none select-none"
            style={{
              left: -selection.x,
              top: -selection.y,
              width: start.width,
              height: start.height,
            }}
          />
        </div>
      )}

      {flash && (
        <div
          className="pointer-events-none absolute bg-white"
          style={{
            left: flash.x,
            top: flash.y,
            width: flash.width,
            height: flash.height,
          }}
        />
      )}

      {!dragging && <HintPill />}
      {dragging && selection && cursor && (
        <SizeLabel
          selection={selection}
          cursor={cursor}
          bounds={start}
          scaleFactor={start.scaleFactor}
        />
      )}
    </div>
  );
}

/**
 * DESIGN S2 idle state: a centered pill near the top.
 *
 * Opaque, not glass. The pill floats over whatever the user happened to be looking at, so a
 * 78%-translucent surface put 11 px text on top of arbitrary screenshot content — and the
 * keys are the one thing in the overlay the user has to be able to read.
 */
function HintPill() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center">
      <div
        className="flex items-center gap-2 text-caption text-text"
        style={{
          background: "var(--surface-raised)",
          borderRadius: "var(--radius-chip)",
          boxShadow: "var(--shadow-raised)",
          padding: "7px 14px",
        }}
      >
        <span>Drag to capture</span>
        <Sep />
        <Keycap>F</Keycap>
        <span>full screen</span>
        <Sep />
        <Keycap>Esc</Keycap>
        <span>cancel</span>
      </div>
    </div>
  );
}

function Sep() {
  return (
    <span aria-hidden style={{ color: "var(--text-3)" }}>
      ·
    </span>
  );
}

/** DESIGN §3 "Keycap": mono 11, 1 px border, radius 5, padding 1 5. */
function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        fontFamily: "var(--mono)",
        fontSize: 11,
        lineHeight: "14px",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        padding: "1px 5px",
      }}
    >
      {children}
    </kbd>
  );
}

/**
 * Mono W×H label, below-right of the cursor, flipped inside near the screen edges
 * (DESIGN S2 "Dragging").
 */
function SizeLabel({
  selection,
  cursor,
  bounds,
  scaleFactor,
}: {
  selection: Rect;
  cursor: Point;
  bounds: { width: number; height: number };
  scaleFactor: number;
}) {
  const offset = 14;
  const estimatedWidth = 92;
  const estimatedHeight = 24;

  const overflowsRight = cursor.x + offset + estimatedWidth > bounds.width - LABEL_MARGIN_PX;
  const overflowsBottom = cursor.y + offset + estimatedHeight > bounds.height - LABEL_MARGIN_PX;

  return (
    <div
      className="pointer-events-none absolute text-caption"
      style={{
        left: overflowsRight ? cursor.x - offset - estimatedWidth : cursor.x + offset,
        top: overflowsBottom ? cursor.y - offset - estimatedHeight : cursor.y + offset,
        fontFamily: "var(--mono)",
        // Opaque for the same reason as the hint pill: the backdrop is the user's screen.
        background: "var(--surface-raised)",
        borderRadius: "var(--radius-control)",
        color: "var(--text)",
        boxShadow: "var(--shadow-raised)",
        padding: "4px 8px",
        // Dimensions are numbers being compared; stop them jittering as digits change.
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {/* Physical pixels: what the saved PNG will actually be (PRD F1.2). */}
      {Math.round(selection.width * scaleFactor)} ×{" "}
      {Math.round(selection.height * scaleFactor)}
    </div>
  );
}

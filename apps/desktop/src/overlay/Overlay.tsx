import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Capture overlay (DESIGN S2, PRD F1.2–F1.3, F1.6).
 *
 * One of these runs per monitor, in its own `overlay-{monitorId}` window that covers that
 * monitor exactly. All geometry here is CSS px relative to this window, which is what
 * `crop::to_physical` expects — Rust converts to physical pixels using this monitor's own
 * scale factor.
 *
 * Two modes, switched with Space: region (drag a rectangle) and window (hover highlights
 * the topmost window, click or Enter captures it). In window mode only an index goes back
 * to Rust, which looks the rect up in the list it sent; the UI just draws and hit-tests.
 */

/** Payload of `overlay:start`, built in Rust so the URL scheme can differ per platform. */
type OverlayStart = {
  monitorId: number;
  frameUrl: string;
  width: number;
  height: number;
  scaleFactor: number;
  /** Highlightable windows on this monitor, front-to-back (PRD F1.6). */
  windows: Rect[];
  /** Tray "Capture window" opens straight into window mode. */
  startInWindowMode: boolean;
};

type Mode = "region" | "window";

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

function contains(rect: Rect, point: Point) {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

/** The topmost window under the pointer: the list is front-to-back, so the first hit. */
function windowAt(windows: Rect[], point: Point | null): number | null {
  if (!point) return null;
  const index = windows.findIndex((rect) => contains(rect, point));
  return index === -1 ? null : index;
}

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Overlay() {
  const [start, setStart] = useState<OverlayStart | null>(null);
  const [origin, setOrigin] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [flash, setFlash] = useState<Rect | null>(null);
  const [mode, setMode] = useState<Mode>("region");
  // Where the pointer is, for the window-mode highlight. Region mode only tracks the cursor
  // while dragging, so this is kept separately.
  const [hover, setHover] = useState<Point | null>(null);

  const hovered = start && mode === "window" ? windowAt(start.windows, hover) : null;

  // Read inside global key handlers, which would otherwise close over a stale selection.
  const live = useRef({ start, origin, cursor, mode, hovered });
  live.current = { start, origin, cursor, mode, hovered };

  useEffect(() => {
    const begin = (next: OverlayStart) => {
      setStart(next);
      setOrigin(null);
      setCursor(null);
      setFlash(null);
      setHover(null);
      setMode(next.startInWindowMode ? "window" : "region");
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

  /** Capture the highlighted window (PRD F1.6). Rust resolves the index to its own rect. */
  const commitWindow = useCallback(async (monitorId: number, rect: Rect, index: number) => {
    if (!prefersReducedMotion()) {
      setFlash(rect);
      await new Promise((resolve) => setTimeout(resolve, FLASH_MS));
      setFlash(null);
    }
    setHover(null);
    await invoke("overlay_commit_window", { monitorId, index });
  }, []);

  const commitFullScreen = useCallback(async (monitorId: number) => {
    setOrigin(null);
    setCursor(null);
    await invoke("overlay_commit_full", { monitorId });
  }, []);

  // PRD F1.3: Esc cancels, F captures the whole monitor, Enter commits the selection.
  // PRD F1.6: Space switches between region and window mode.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { start: current, origin: from, cursor: to, mode: now, hovered: index } =
        live.current;
      if (!current) return;

      if (event.key === " ") {
        event.preventDefault();
        if (event.repeat) return;
        // A half-finished drag doesn't carry over into the other mode.
        setOrigin(null);
        setCursor(null);
        setMode(now === "region" ? "window" : "region");
        return;
      }
      if (now === "window" && event.key === "Enter") {
        event.preventDefault();
        const rect = index === null ? undefined : current.windows[index];
        if (index !== null && rect) void commitWindow(current.monitorId, rect, index);
        return;
      }

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
  }, [cancel, commit, commitFullScreen, commitWindow]);

  if (!start) return null;

  const selection = origin && cursor ? rectFrom(origin, cursor) : null;
  const dragging = selection !== null && (selection.width > 0 || selection.height > 0);

  const highlight = hovered === null ? null : (start.windows[hovered] ?? null);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // Window mode captures on release; there is no drag.
    if (mode === "window") return;
    const point = { x: event.clientX, y: event.clientY };
    setOrigin(point);
    setCursor(point);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const point = { x: event.clientX, y: event.clientY };
    setCursor(point);
    setHover(point);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (mode === "window") {
      // A click with nothing highlighted does nothing (cleanshot-gaps.md, overlay states).
      if (event.button === 0 && hovered !== null && highlight) {
        void commitWindow(start.monitorId, highlight, hovered);
      }
      return;
    }
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
      style={{ cursor: mode === "window" ? "default" : "crosshair" }}
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
      {mode === "region" && dragging && selection && (
        <Undimmed
          rect={selection}
          frame={start}
          // 1 px white inner border, 1 px black outer border.
          ring="inset 0 0 0 1px #fff, 0 0 0 1px #000"
        />
      )}

      {/* Window mode: the topmost window under the pointer, undimmed with an accent ring.
          No transition, so reduced motion needs nothing extra. */}
      {mode === "window" && highlight && (
        <Undimmed rect={highlight} frame={start} ring="inset 0 0 0 2px var(--accent)" />
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

      {mode === "region" && !dragging && <RegionHint />}
      {mode === "window" && <WindowHint hasWindows={start.windows.length > 0} />}
      {mode === "region" && dragging && selection && cursor && (
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

/** A piece of the frozen frame shown undimmed, for the selection or a window highlight. */
function Undimmed({ rect, frame, ring }: { rect: Rect; frame: OverlayStart; ring: string }) {
  return (
    <div
      className="pointer-events-none absolute overflow-hidden"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        boxShadow: ring,
      }}
    >
      <img
        src={frame.frameUrl}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={{
          left: -rect.x,
          top: -rect.y,
          width: frame.width,
          height: frame.height,
        }}
      />
    </div>
  );
}

/**
 * DESIGN S2 hint: a centered pill near the top.
 *
 * Opaque, not glass. The pill floats over whatever the user happened to be looking at, so a
 * 78%-translucent surface put 11 px text on top of arbitrary screenshot content — and the
 * keys are the one thing in the overlay the user has to be able to read.
 */
function HintPill({ children }: { children: React.ReactNode }) {
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
        {children}
      </div>
    </div>
  );
}

/** DESIGN S2 idle state in region mode. */
function RegionHint() {
  return (
    <HintPill>
      <span>Drag to capture</span>
      <Sep />
      <Keycap>Space</Keycap>
      <span>window</span>
      <Sep />
      <Keycap>F</Keycap>
      <span>full screen</span>
      <Sep />
      <Keycap>Esc</Keycap>
      <span>cancel</span>
    </HintPill>
  );
}

/** DESIGN S2 window mode (PRD F1.6). */
function WindowHint({ hasWindows }: { hasWindows: boolean }) {
  return (
    <HintPill>
      <span>{hasWindows ? "Click a window" : "No windows to capture here"}</span>
      <Sep />
      <Keycap>Space</Keycap>
      <span>for area</span>
    </HintPill>
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

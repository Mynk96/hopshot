import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { type ShelfItem, timeLeft } from "./types";

/**
 * One shelf card (PRD F2.3, DESIGN S3, `design/mockups.html` `.card`).
 *
 * 184x115, thumbnail-filled, with the time chip top-right, the source badge top-left when
 * the item did not come from a capture, and the action bar revealed on hover or selection.
 */

/** Pointer travel, in px, that turns a press into a drag rather than a click. */
const DRAG_SLOP_PX = 4;
/** The chip counts down, so it has to re-render without a store change. */
const TICK_MS = 30_000;

export function ItemCard({
  item,
  selected,
  highlighted,
  dragging,
  onSelect,
  onCopy,
  onPress,
  onDrag,
  onPhone,
  onLink,
  onMore,
}: {
  item: ShelfItem;
  selected: boolean;
  highlighted: boolean;
  dragging: boolean;
  onSelect: () => void;
  onCopy: () => void;
  onPress: () => void;
  onDrag: () => void;
  onPhone: () => void;
  onLink: () => void;
  onMore: () => void;
}) {
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const [, setTick] = useState(0);
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const { label, warn } = timeLeft(item);

  return (
    <li
      // Focusable and activatable: the shelf-wide key handler (DESIGN §7) drives it, so
      // there is no per-card keydown.
      role="button"
      tabIndex={0}
      aria-label={item.fileName}
      className={`group relative shrink-0 overflow-hidden hover:-translate-y-px ${
        highlighted ? "arriving" : ""
      }`}
      style={{
        height: 115,
        borderRadius: "var(--radius-card)",
        boxShadow: selected ? "0 0 0 2px var(--accent)" : "0 0 0 1px var(--border)",
        /*
         * Letterbox colour behind a thumbnail that does not fill the card. Opaque on
         * purpose: `--surface-3` is a 10% white tint, so on a transparent window the
         * wallpaper showed through the bars around every screenshot that was not 16:10 —
         * which made the card look broken rather than letterboxed.
         */
        background: "var(--card-letterbox)",
        cursor: "grab",
        opacity: dragging ? 0.5 : 1,
        transition:
          "opacity var(--dur-exit) var(--ease-hop), box-shadow .12s, transform var(--dur-exit) var(--ease-hop)",
      }}
      // Click copies (F2.5), drag drags (F2.4). Telling them apart needs the pointer to
      // actually move before the OS drag loop starts.
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        onSelect();
        press.current = { x: event.clientX, y: event.clientY, dragged: false };
        onPress();
      }}
      onPointerMove={(event) => {
        const held = press.current;
        if (!held || held.dragged) return;
        if (Math.abs(event.clientX - held.x) + Math.abs(event.clientY - held.y) > DRAG_SLOP_PX) {
          held.dragged = true;
          onDrag();
        }
      }}
      onPointerUp={(event) => {
        const held = press.current;
        press.current = null;
        // Only a primary-button press that started on this card counts as a click. Without
        // this, a right- or middle-click — or a release that drifted in from outside —
        // copies the image, because `held` is null and so "was not a drag".
        if (!held || held.dragged || event.button !== 0) return;
        // The action bar handles its own clicks.
        if (!(event.target as HTMLElement).closest("[data-act]")) onCopy();
      }}
      onPointerLeave={() => {
        press.current = null;
      }}
    >
      {thumbFailed ? (
        // A thumbnail that will not load is worth saying out loud: silently showing an empty
        // card looks like the capture itself failed, which sends debugging the wrong way.
        <div className="absolute inset-0 grid place-items-center px-2 text-center">
          <span className="text-caption" style={{ color: "var(--danger)" }}>
            Preview unavailable
          </span>
        </div>
      ) : (
        <img
          src={convertFileSrc(item.thumbPath)}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full select-none"
          // `contain`, not `cover`: screenshots are any shape, and a portrait one cropped to
          // a landscape card becomes a meaningless horizontal band. The whole shot has to be
          // recognisable — that is the entire job of this thumbnail.
          style={{ objectFit: "contain" }}
          onError={() => {
            console.error("thumbnail failed to load", {
              thumbPath: item.thumbPath,
              url: convertFileSrc(item.thumbPath),
            });
            setThumbFailed(true);
          }}
        />
      )}

      {item.source !== "capture" && (
        <Chip className="left-1.5 top-1.5">
          {item.source === "phone" && <Icon name="smartphone" size={11} />}
          {item.originDevice ?? item.source}
        </Chip>
      )}

      <Chip className="right-1.5 top-1.5" color={warn ? "var(--warning)" : "var(--on-scrim)"}>
        {label}
      </Chip>

      <div
        className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 gap-0.5 p-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
        style={{
          // Over a screenshot, not over the UI surface — hence the fixed scrim rather than
          // a themed token. The blur is real here: the backdrop is the thumbnail, which is
          // page content, so Chromium can sample it.
          background: "var(--scrim)",
          backdropFilter: "blur(12px)",
          borderRadius: "var(--radius-chip)",
          boxShadow: "0 2px 10px rgba(0,0,0,.35)",
          opacity: selected ? 1 : undefined,
        }}
      >
        <Action label="Copy" onClick={onCopy}>
          <Icon name="copy" />
        </Action>
        <Action label="Send to phone" onClick={onPhone}>
          <Icon name="smartphone" />
        </Action>
        <Action label="Copy link" onClick={onLink}>
          <Icon name="link" />
        </Action>
        <Action label="More" onClick={onMore}>
          <Icon name="more" />
        </Action>
      </div>
    </li>
  );
}

function Chip({
  children,
  className,
  color = "var(--on-scrim)",
}: {
  children: React.ReactNode;
  className?: string;
  color?: string;
}) {
  return (
    <span
      className={`absolute flex items-center gap-1 text-caption ${className ?? ""}`}
      style={{
        background: "var(--scrim)",
        backdropFilter: "blur(8px)",
        borderRadius: "var(--radius-chip)",
        color,
        padding: "1px 6px",
      }}
    >
      {children}
    </span>
  );
}

function Action({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-act
      aria-label={label}
      title={label}
      className="scrim-btn"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

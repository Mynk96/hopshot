import { useEffect, useRef } from "react";
import { Icon } from "./icons";
import type { ShelfItem } from "./types";

/**
 * The card's More menu (DESIGN S3, `design/mockups.html` `openMore`).
 *
 * "Delete link" is omitted: it only applies once an item has a drop, which arrives with
 * PRD F3 in Phase 5.
 */
export function MoreMenu({
  item,
  onClose,
  onSaveAs,
  onReveal,
  onPin,
  onDelete,
  onBackground,
}: {
  item: ShelfItem;
  onClose: () => void;
  onBackground: () => void;
  onSaveAs: () => void;
  onReveal: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);

  // Dismiss on Esc or on any click outside, like a native menu.
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

  const isMac = navigator.userAgent.includes("Mac");
  const pinned = item.expiresAt === null;

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <div
      ref={container}
      role="menu"
      // Opaque, like any native menu. `--surface-3` is a hover tint (DESIGN §2.1): as a
      // background it left the menu ~90% transparent over the user's wallpaper.
      className="raised hop-in absolute inset-x-2 bottom-11 z-10 flex flex-col overflow-hidden p-1 text-caption"
      style={{ borderRadius: "var(--radius-control)" }}
    >
      <Row icon="image" label="Background" shortcut="B" onClick={run(onBackground)} />
      <hr style={{ borderColor: "var(--raised-border)", margin: "4px 0" }} />
      <Row icon="save" label="Save as…" onClick={run(onSaveAs)} />
      <Row
        icon="folder"
        label={isMac ? "Reveal in Finder" : "Show in File Explorer"}
        onClick={run(onReveal)}
      />
      <Row
        icon="pin"
        label={pinned ? "Let it expire" : "Keep (don't expire)"}
        onClick={run(onPin)}
      />
      <hr style={{ borderColor: "var(--raised-border)", margin: "4px 0" }} />
      <Row icon="trash" label="Delete" danger onClick={run(onDelete)} />
    </div>
  );
}

function Row({
  icon,
  label,
  shortcut,
  danger,
  onClick,
}: {
  icon: string;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`menu-row ${danger ? "menu-row-danger" : ""}`}
    >
      <Icon name={icon} />
      {label}
      {shortcut && (
        <span className="ml-auto" style={{ color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { ItemCard } from "./ItemCard";
import { MoreMenu } from "./MoreMenu";
import { SendSheet } from "./SendSheet";
import { useAutoHide } from "./useAutoHide";
import { useShelfKeys } from "./useShelfKeys";
import type { ShelfItem, Toast } from "./types";

/**
 * The shelf (DESIGN S3, PRD F2) — the app's core screen.
 *
 * Layout and interaction follow `design/mockups.html`: a 208 px panel parked against the
 * screen edge, 184x115 cards newest first, hover actions, a More menu, a footer and a
 * toast. Rust owns every mutation; this file owns view state only (CLAUDE.md rule 3).
 */

/** DESIGN S3: the shelf grows with its content up to 80% of the screen. */
const MAX_VIEWPORT_FRACTION = 0.8;
const HEADER_PX = 40;
const FOOTER_PX = 34;
const CARD_PX = 115;
const CARD_GAP_PX = 8;
const LIST_PADDING_PX = 12;

export default function Shelf() {
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Item whose QR popover is open (DESIGN S4). Also what "Copy link" opens. */
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [pinnedOpen, setPinnedOpen] = useState(false);

  /** id → staged path promise, so a drag never waits on IPC. */
  const staged = useRef(new Map<string, Promise<{ path: string; icon: string }>>());

  const flash = useCallback((text: string, kind: Toast["kind"] = "info") => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 1600);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<ShelfItem[]>("list_items");
      setItems(next);
      staged.current.clear();
    } catch (error) {
      console.error("could not list shelf items", error);
    }
  }, []);

  /*
   * DESIGN §7: fall back to `--surface-solid` when the OS gave us no backdrop — Windows 10,
   * a failed `apply_acrylic`, or "Reduce transparency" on macOS. The window is transparent,
   * so without a backdrop the glass surface composites straight onto the wallpaper and
   * `backdrop-filter` cannot help: Chromium samples only the page, never the desktop.
   */
  useEffect(() => {
    void invoke<boolean>("shelf_has_vibrancy")
      .then((glass) => {
        document.documentElement.classList.toggle("no-vibrancy", !glass);
      })
      .catch((error: unknown) => {
        // Unknown means assume the worst: a plain readable panel beats an unreadable one.
        document.documentElement.classList.add("no-vibrancy");
        console.error("could not read the shelf backdrop state", error);
      });
  }, []);

  useEffect(() => {
    void refresh();

    const subscriptions = [
      listen("shelf:changed", () => void refresh()),
      listen<{ id: string }>("shelf:highlight", (event) => {
        setHighlighted(event.payload.id);
        setSelected(event.payload.id);
        // DESIGN S3: the accent ring is an arrival cue, not a persistent state.
        setTimeout(() => setHighlighted(null), 900);
      }),
      listen<Toast>("toast", (event) => flash(event.payload.text, event.payload.kind)),
    ];

    return () => {
      for (const pending of subscriptions) void pending.then((off) => off());
    };
  }, [refresh, flash]);

  /** Grow the window to fit, capped at DESIGN S3's 80% of the screen. */
  useEffect(() => {
    const content =
      HEADER_PX +
      FOOTER_PX +
      LIST_PADDING_PX * 2 +
      Math.max(1, items.length) * CARD_PX +
      Math.max(0, items.length - 1) * CARD_GAP_PX;
    const cap = Math.round(window.screen.availHeight * MAX_VIEWPORT_FRACTION);
    void invoke("resize_shelf", { height: Math.min(content, cap) });
  }, [items.length]);

  const hide = useCallback(() => void invoke("hide_shelf"), []);

  // PRD F2.2 — auto-hide after the configured idle time unless pinned open or busy.
  const { onActivity } = useAutoHide({
    // A shelf that vanished mid-scan would be the worst possible moment for it.
    enabled: !pinnedOpen && menuFor === null && qrFor === null && dragging === null,
    onHide: hide,
  });

  const copy = useCallback(
    async (id: string) => {
      try {
        await invoke("copy_item", { id });
        flash("Copied");
      } catch (error) {
        flash("That one just expired.", "error");
        console.error("copy failed", error);
      }
    },
    [flash],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await invoke("delete_item", { id });
        flash("Deleted");
      } catch (error) {
        console.error("delete failed", error);
      }
    },
    [flash],
  );

  const togglePin = useCallback(
    async (item: ShelfItem) => {
      try {
        const next = await invoke<ShelfItem>("pin_item", {
          id: item.id,
          pinned: item.expiresAt !== null,
        });
        flash(next.expiresAt === null ? "Kept — won't expire" : "Expiry restarted");
      } catch (error) {
        console.error("pin failed", error);
      }
    },
    [flash],
  );

  const saveAs = useCallback(
    async (id: string) => {
      try {
        const written = await invoke<string | null>("save_item_as", { id });
        if (written) flash("Saved a copy");
      } catch (error) {
        console.error("save as failed", error);
      }
    },
    [flash],
  );

  const reveal = useCallback(async (id: string) => {
    try {
      await invoke("reveal_item", { id });
    } catch (error) {
      console.error("reveal failed", error);
    }
  }, []);

  /** Stage on press so `startDrag` can fire the instant the pointer moves. */
  const prestage = useCallback((id: string) => {
    if (!staged.current.has(id)) {
      staged.current.set(id, invoke<{ path: string; icon: string }>("prepare_drag", { id }));
    }
  }, []);

  const drag = useCallback(
    async (id: string) => {
      try {
        const pending =
          staged.current.get(id) ??
          invoke<{ path: string; icon: string }>("prepare_drag", { id });
        const { path, icon } = await pending;

        setDragging(id);
        startDrag({ item: [path], icon }, (payload) => {
          setDragging(null);
          const dropped = payload?.result === "Dropped";
          if (dropped) flash("Dropped");
          // PRD F2.10 — whether a completed drop removes the item is the "Remove after
          // dragging out" setting, which only Rust reads.
          void invoke("drag_finished", { id, dropped }).catch((error) =>
            console.error("drag completion failed", error),
          );
        });
      } catch (error) {
        setDragging(null);
        console.error("drag failed", error);
      }
    },
    [flash],
  );

  // DESIGN §7 shelf keyboard map.
  useShelfKeys({
    items,
    selected,
    setSelected,
    onCopy: (id) => void copy(id),
    onDelete: (id) => void remove(id),
    onHide: hide,
    // PRD F3: both open the same popover — "Copy link" is the QR flow with the link in
    // front rather than a second code path.
    onPhone: (id) => setQrFor(id),
    onLink: (id) => setQrFor(id),
  });

  const menuItem = useMemo(
    () => items.find((item) => item.id === menuFor) ?? null,
    [items, menuFor],
  );

  return (
    <div
      className="relative flex h-dvh flex-col overflow-hidden text-text"
      style={{
        borderRadius: "var(--radius-panel)",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        boxShadow: "var(--shadow)",
      }}
      onPointerMove={onActivity}
      onPointerDown={onActivity}
    >
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-1.5 pl-2.5 pr-1"
        style={{ height: HEADER_PX, borderBottom: "1px solid var(--border)" }}
      >
        <BrandMark />
        <b className="text-body-strong">Hopshot</b>
        {items.length > 0 && (
          <span
            // The count is information, not decoration: an empty shelf says "Nothing here
            // yet" in the body already, so a "0" chip is just noise.
            className="text-caption tabular-nums text-text-2"
            style={{
              background: "var(--surface-2)",
              borderRadius: "var(--radius-chip)",
              padding: "1px 6px",
            }}
          >
            {items.length}
          </span>
        )}
        <span className="flex-1" />
        <IconButton
          label="Keep shelf open"
          pressed={pinnedOpen}
          onClick={() => setPinnedOpen((open) => !open)}
        >
          <Icon name="pin" />
        </IconButton>
        <IconButton label="Settings" onClick={() => void invoke("open_settings")}>
          <Icon name="settings" />
        </IconButton>
        <IconButton label="Hide shelf" onClick={hide}>
          <Icon name="x" />
        </IconButton>
      </header>

      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <ul
          className="thin-scroll flex flex-1 flex-col gap-2 overflow-y-auto"
          style={{ padding: LIST_PADDING_PX }}
        >
          {items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              selected={selected === item.id}
              highlighted={highlighted === item.id}
              dragging={dragging === item.id}
              onSelect={() => setSelected(item.id)}
              onCopy={() => void copy(item.id)}
              onPress={() => prestage(item.id)}
              onDrag={() => void drag(item.id)}
              onPhone={() => setQrFor(item.id)}
              onLink={() => setQrFor(item.id)}
              onMore={() => setMenuFor(item.id)}
            />
          ))}
        </ul>
      )}

      <Footer count={items.length} />

      {qrFor && (
        <SendSheet itemId={qrFor} onClose={() => setQrFor(null)} onToast={flash} />
      )}

      {menuItem && (
        <MoreMenu
          item={menuItem}
          onClose={() => setMenuFor(null)}
          onSaveAs={() => void saveAs(menuItem.id)}
          onReveal={() => void reveal(menuItem.id)}
          onPin={() => void togglePin(menuItem)}
          onDelete={() => void remove(menuItem.id)}
        />
      )}

      {toast && (
        <div
          // DESIGN S3 puts the toast at the top of the shelf, clear of the action bar and
          // the popovers that occupy the bottom.
          className="pointer-events-none absolute inset-x-0 top-12 flex justify-center px-3"
          role="status"
        >
          <span
            // Opaque: a toast that is 90% transparent over a screenshot cannot be read, and
            // it is on screen for only 1.6 s (DESIGN §2.3).
            className="toast-in flex max-w-full items-center gap-1.5 text-caption"
            style={{
              background: "var(--surface-raised)",
              boxShadow: "var(--shadow-raised)",
              borderRadius: "var(--radius-chip)",
              color: toast.kind === "error" ? "var(--danger)" : "var(--text)",
              padding: "5px 11px",
            }}
          >
            {toast.kind !== "error" && (
              <span aria-hidden style={{ color: "var(--success)", display: "grid" }}>
                <Icon name="check" size={13} />
              </span>
            )}
            <span className="truncate">{toast.text}</span>
          </span>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      // Hover and press states come from the class: an inline style cannot express them,
      // which is why the shelf header used to feel inert under the pointer.
      className="icon-btn size-7"
    >
      {children}
    </button>
  );
}

/**
 * The app mark from DESIGN §6, at 14 px: an orange shelf line with a tilted card resting on
 * it. A plain orange square read as a loading placeholder rather than a logo.
 */
function BrandMark() {
  return (
    <svg
      aria-hidden
      width="15"
      height="15"
      viewBox="0 0 16 16"
      className="shrink-0"
      style={{ overflow: "visible" }}
    >
      <rect
        x="4.5"
        y="2.5"
        width="8"
        height="8"
        rx="1.6"
        transform="rotate(-7 8.5 6.5)"
        fill="var(--text)"
        opacity="0.92"
      />
      <rect x="1.5" y="11.5" width="13" height="2.2" rx="1.1" fill="var(--accent)" />
    </svg>
  );
}

/** DESIGN S3 empty state. */
function EmptyState() {
  // The keycaps are the capture hotkey; Ctrl on Windows, ⌘ on macOS.
  const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-4 text-center">
      <span
        aria-hidden
        className="grid place-items-center"
        style={{
          width: 38,
          height: 38,
          borderRadius: "var(--radius-card)",
          background: "var(--surface-2)",
          color: "var(--text-3)",
        }}
      >
        <Icon name="image" size={18} />
      </span>
      <b className="text-body-strong">Nothing here yet</b>
      <p className="flex gap-1">
        {[mod, "⇧", "2"].map((key) => (
          <kbd
            key={key}
            className="text-caption"
            style={{
              fontFamily: "var(--mono)",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "2px 5px",
            }}
          >
            {key}
          </kbd>
        ))}
      </p>
      <p className="text-caption leading-4 text-text-2">
        Screenshots land here, not on your desktop.
      </p>
    </div>
  );
}

/**
 * DESIGN S3 footer. The trial and Sync variants need the plan, which arrives with
 * `get_plan()` in Phase 4; until then it shows the Lifetime line.
 */
function Footer({ count }: { count: number }) {
  // Navigator.onLine is the only offline signal available in the webview; Rust reports the
  // authoritative one per request (DESIGN S3 "Offline — sending paused").
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <footer
      className="flex shrink-0 items-center gap-1.5 text-caption text-text-2"
      style={{ height: FOOTER_PX, borderTop: "1px solid var(--border)", padding: "0 12px" }}
    >
      {online ? (
        <>
          <span className="tabular-nums">
            {count} {count === 1 ? "item" : "items"}
          </span>
          <span aria-hidden>·</span>
          {/* DESIGN §1.5: say it briefly, every time, and never as a paragraph. */}
          <span className="truncate">Gone in 24h</span>
        </>
      ) : (
        <span className="flex items-center gap-1.5 truncate" style={{ color: "var(--warning)" }}>
          <Icon name="wifiOff" size={12} />
          Offline — sending paused
        </span>
      )}
    </footer>
  );
}

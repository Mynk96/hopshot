import { useEffect, useRef } from "react";
import type { ShelfItem } from "./types";

/**
 * The shelf keyboard map from DESIGN §7:
 * `↑/↓` select · `Enter` copy · `⌘/Ctrl+C` copy · `P` send to phone · `L` copy link ·
 * `Delete` remove · `Esc` hide.
 */
export function useShelfKeys({
  items,
  selected,
  setSelected,
  onCopy,
  onDelete,
  onHide,
  onPhone,
  onLink,
}: {
  items: ShelfItem[];
  selected: string | null;
  setSelected: (id: string | null) => void;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onHide: () => void;
  onPhone: (id: string) => void;
  onLink: (id: string) => void;
}) {
  // Handlers are registered once; reading through a ref keeps them from closing over a
  // stale item list on every render.
  const live = useRef({ items, selected, setSelected, onCopy, onDelete, onHide, onPhone, onLink });
  live.current = { items, selected, setSelected, onCopy, onDelete, onHide, onPhone, onLink };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = live.current;
      if (state.items.length === 0) {
        if (event.key === "Escape") state.onHide();
        return;
      }

      const index = state.items.findIndex((item) => item.id === state.selected);
      const current = index >= 0 ? (state.items[index] ?? null) : null;

      // Move the selection, wrapping at both ends so the list is a loop.
      const move = (delta: number) => {
        event.preventDefault();
        const next = index < 0 ? 0 : (index + delta + state.items.length) % state.items.length;
        const target = state.items[next];
        if (target) state.setSelected(target.id);
      };

      switch (event.key) {
        case "ArrowDown":
          return move(1);
        case "ArrowUp":
          return move(-1);
        case "Escape":
          event.preventDefault();
          return state.onHide();
        case "Enter":
          if (!current) return;
          event.preventDefault();
          return state.onCopy(current.id);
        case "Delete":
        case "Backspace":
          if (!current) return;
          event.preventDefault();
          return state.onDelete(current.id);
        default:
          break;
      }

      if (!current) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        return state.onCopy(current.id);
      }
      // Bare letters, so they must not fire while a modifier is held.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        return state.onPhone(current.id);
      }
      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        return state.onLink(current.id);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

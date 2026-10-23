import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Settings from "./settings/Settings.tsx";
import Overlay from "./overlay/Overlay.tsx";
import Shelf from "./shelf/Shelf.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

/**
 * Every Hopshot window loads this one bundle, so the window label picks the screen
 * (ARCHITECTURE §5.1 labels: `overlay-{n}`, `settings`, later `shelf` and `onboarding`).
 */
const label = getCurrentWindow().label;
const isOverlay = label.startsWith("overlay-");
const isShelf = label === "shelf";

// Both are transparent, frameless windows: a page background would paint over the frozen
// screen (overlay) or the vibrancy layer (shelf).
if (isOverlay || isShelf) {
  document.documentElement.classList.add("transparent-window");

  // DESIGN §2.1: dark is the default for the shelf and overlay, and it is not optional.
  //
  // Each Tauri window is its own document, so without this line these two followed
  // `prefers-color-scheme` and loaded the *light* tokens on a light-themed OS — near-black
  // text (`--text: #18181B`) over the hardcoded dark acrylic that `platform/windows.rs`
  // paints behind the shelf, and a QR popover backed by `rgba(0,0,0,.07)`. Both were
  // unreadable. The overlay floats over arbitrary screen content, where dark chrome is the
  // only safe choice; the shelf's backdrop tint is dark on both platforms.
  document.documentElement.setAttribute("data-theme", "dark");
}

function Window() {
  if (isOverlay) return <Overlay />;
  if (isShelf) return <Shelf />;
  return <Settings />;
}

createRoot(root).render(
  <StrictMode>
    <Window />
  </StrictMode>,
);

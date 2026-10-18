import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef } from "react";

/**
 * PRD F2.2 — the shelf auto-hides after a quiet period.
 *
 * "Without hover" in the PRD means without interaction: the timer restarts on any pointer
 * activity over the shelf, and is suspended entirely while the user is mid-drag or has a
 * menu open, since both are states where a disappearing shelf would be hostile.
 *
 * The delay comes from `settings.autoHideSeconds`; `null` there means never.
 *
 * This webview mounts once at launch and the window is then shown and hidden repeatedly,
 * so nothing here can infer an appearance from a render. Rust says when, via `shelf:shown`
 * and `shelf:hidden`.
 */

/** The delay before the setting has been read — distinct from a number and from "never". */
const UNKNOWN = "unknown";

export function useAutoHide({ enabled, onHide }: { enabled: boolean; onHide: () => void }) {
  const timer = useRef<number | null>(null);
  const seconds = useRef<number | null | typeof UNKNOWN>(UNKNOWN);
  const live = useRef({ enabled, onHide });
  live.current = { enabled, onHide };
  /** The window is declared hidden in tauri.conf.json, so nothing is counting down yet. */
  const visible = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const restart = useCallback(() => {
    clear();
    const delay = seconds.current;
    // An unread setting must not be guessed at: a user who chose "Never" would otherwise
    // lose the shelf on the first cycle.
    if (delay === UNKNOWN || delay === null) return;
    if (!live.current.enabled || !visible.current) return;
    timer.current = window.setTimeout(() => live.current.onHide(), delay * 1000);
  }, [clear]);

  useEffect(() => {
    let cancelled = false;
    void invoke<{ settings: { autoHideSeconds: number | null } }>("get_settings")
      .then((response) => {
        if (cancelled) return;
        seconds.current = response.settings.autoHideSeconds;
        // The setting arrives after mount, so the countdown starts (or is cancelled) here.
        restart();
      })
      .catch((error) => console.error("could not read the auto-hide setting", error));
    return () => {
      cancelled = true;
    };
  }, [restart]);

  useEffect(() => {
    const subscriptions = [
      listen("shelf:shown", () => {
        visible.current = true;
        restart();
      }),
      listen("shelf:hidden", () => {
        visible.current = false;
        clear();
      }),
    ];

    // The shelf can already be up by the time these listeners are registered — Rust shows
    // it from the capture pipeline, which does not wait for the webview.
    void getCurrentWindow()
      .isVisible()
      .then((up) => {
        visible.current = up;
        restart();
      })
      .catch((error) => console.error("could not read the shelf visibility", error));

    return () => {
      for (const pending of subscriptions) void pending.then((off) => off());
    };
  }, [restart, clear]);

  // Restart whenever the shelf becomes eligible again (a drag finished, a menu closed).
  useEffect(() => {
    restart();
    return clear;
  }, [enabled, restart, clear]);

  return { onActivity: restart };
}

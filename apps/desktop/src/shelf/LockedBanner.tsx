import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { limits } from "shared";

/**
 * The locked shelf (DESIGN S3, docs/designs/pay-first-10.md): nothing bought, or refunded.
 * Capture is paused; the shelf stays readable and draggable. The price comes from
 * config/limits.json so the app, the website and the release notes always agree.
 */
export function LockedBanner({ onHeight }: { onHeight: (px: number) => void }) {
  const box = useRef<HTMLDivElement>(null);

  // The shelf sizes its window to its content, and this banner's copy wraps.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => onHeight(element.offsetHeight));
    observer.observe(element);
    return () => {
      observer.disconnect();
      onHeight(0);
    };
  }, [onHeight]);

  return (
    <div
      ref={box}
      className="flex shrink-0 flex-col gap-1.5 px-3 py-2.5"
      style={{
        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <b className="text-caption">Unlock Hopshot for {limits.pricing.display}</b>
      <span className="text-caption leading-4 text-text-2">
        One payment, everything included. 14-day refund, no questions.
      </span>
      <button
        type="button"
        className="btn btn-primary btn-compact mt-0.5 self-start text-caption"
        onClick={() => void invoke("license_buy", { plan: "bundle" }).catch(() => undefined)}
      >
        Buy · {limits.pricing.display} once
      </button>
    </div>
  );
}

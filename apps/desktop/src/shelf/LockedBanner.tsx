import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { limits } from "shared";

/**
 * The Free plan's banner (docs/designs/free-plan.md), in the slot the locked shelf used.
 *
 * Quiet while there are captures left ("7 of 10 free today"); once today's are used it says
 * so and offers the upgrade. The shelf stays readable and draggable either way. The numbers
 * and the price come from config/limits.json so the app and the website always agree.
 */
export function LockedBanner({
  onHeight,
  capturesLeft,
  capturesPerDay,
}: {
  onHeight: (px: number) => void;
  capturesLeft: number;
  capturesPerDay: number;
}) {
  const used = capturesLeft <= 0;
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

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
        // Tinted only once today's captures are used; quiet while there are some left.
        background: used ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <b className="text-caption">
        {used
          ? `That's today's ${capturesPerDay} free screenshots`
          : `${capturesLeft} of ${capturesPerDay} free screenshots left today`}
      </b>
      <span className="text-caption leading-4 text-text-2">
        {used
          ? `Keep going tomorrow, or unlock unlimited + a paired phone for ${limits.pricing.display} once.`
          : `Unlimited + a paired phone: ${limits.pricing.display} once. 14-day refund.`}
      </span>
      <button
        type="button"
        className="btn btn-primary btn-compact mt-0.5 self-start text-caption"
        onClick={() => {
          setError(null);
          void invoke("license_buy", { plan: "bundle" }).catch((reason) =>
            setError(String(reason) || "Couldn't open checkout. Try again in a moment."),
          );
        }}
      >
        Unlock · {limits.pricing.display} once
      </button>
      {error && (
        <span className="text-caption leading-4" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

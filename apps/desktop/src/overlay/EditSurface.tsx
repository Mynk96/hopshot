import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented, Switch } from "../settings/controls";

/**
 * The Edit surface with the Background panel (DESIGN S2 "Edit surface" and "Background",
 * docs/designs/next-features.md 0.1.16).
 *
 * A view only: every preview is rendered by Rust (`edit_preview`) from the kept original,
 * so what is shown is exactly what Done saves. This component holds the panel's state and
 * nothing else.
 */

export type Fill = "none" | "mist" | "sand" | "sage" | "sky" | "sunset";
export type Style = {
  fill: Fill;
  padding: "s" | "m" | "l";
  radius: number;
  shadow: boolean;
  aspect: "auto" | "16:9" | "1:1";
};

type Preview = {
  url: string;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
};

/** Payload of `overlay:edit`, built in Rust. */
export type EditStart = {
  itemId: string;
  kind: "background";
  style: Style;
  preview: Preview;
  width: number;
  height: number;
};

const FILLS: { value: Fill; label: string; swatch: string }[] = [
  { value: "none", label: "None", swatch: "transparent" },
  { value: "mist", label: "Mist", swatch: "var(--fill-mist)" },
  { value: "sand", label: "Sand", swatch: "var(--fill-sand)" },
  { value: "sage", label: "Sage", swatch: "var(--fill-sage)" },
  { value: "sky", label: "Sky", swatch: "var(--fill-sky)" },
  { value: "sunset", label: "Sunset", swatch: "var(--fill-sunset)" },
];

/** DESIGN S2: the panel sits 24 px to the right of the image. Mirrors edit.rs. */
const PANEL_WIDTH = 248;
const PANEL_GAP = 24;
/** Slider drags fire many changes; one render per frame-ish is plenty. */
const PREVIEW_DEBOUNCE_MS = 60;

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function EditSurface({ start }: { start: EditStart }) {
  const [style, setStyle] = useState<Style>(start.style);
  const [preview, setPreview] = useState<Preview>(start.preview);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = useRef({ style, saving });
  live.current = { style, saving };

  // A new edit (another item) resets everything.
  useEffect(() => {
    setStyle(start.style);
    setPreview(start.preview);
    setLoaded(false);
    setSaving(false);
    setError(null);
  }, [start]);

  // Re-render on change, debounced, and drop answers to requests that were overtaken.
  const latest = useRef(0);
  useEffect(() => {
    if (style === start.style) return;
    const ticket = ++latest.current;
    const timer = window.setTimeout(() => {
      invoke<Preview>("edit_preview", { style })
        .then((next) => {
          if (ticket === latest.current) setPreview(next);
        })
        .catch((reason) => setError(String(reason)));
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [style, start.style]);

  const cancel = useCallback(() => {
    if (live.current.saving) return;
    void invoke("edit_cancel");
  }, []);

  const done = useCallback(async () => {
    if (live.current.saving) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("edit_done", { style: live.current.style });
    } catch (reason) {
      // DESIGN §5: the surface stays open, and the screenshot is unchanged.
      setError(String(reason));
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter") {
        // Enter on a focused control would otherwise activate it instead.
        event.preventDefault();
        void done();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, done]);

  const update = (patch: Partial<Style>) => setStyle((current) => ({ ...current, ...patch }));

  const groupWidth = preview.width + PANEL_GAP + PANEL_WIDTH;
  const left = Math.max(0, (start.width - groupWidth) / 2);
  const top = Math.max(0, (start.height - preview.height) / 2);
  const isMac = navigator.userAgent.includes("Mac");

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      // The live desktop shows through the transparent window, dimmed (DESIGN S2).
      style={{ background: "var(--overlay-dim)" }}
      onPointerDown={(event) => {
        // A click on the dim, outside the image and panel, is not a cancel: too easy to
        // lose a choice by accident. Esc and Cancel are explicit.
        event.stopPropagation();
      }}
    >
      <img
        src={preview.url}
        alt="Preview of the screenshot with its background"
        draggable={false}
        onLoad={() => setLoaded(true)}
        className="pointer-events-none absolute select-none"
        style={{
          left,
          top,
          width: preview.width,
          height: preview.height,
          opacity: loaded ? 1 : 0,
          transition: prefersReducedMotion() ? undefined : "opacity var(--dur-enter) ease-out",
        }}
      />

      <section
        aria-label="Background"
        className="raised absolute flex flex-col gap-4 p-4 text-caption text-text"
        style={{
          left: left + preview.width + PANEL_GAP,
          // Centred on the image, whatever height the panel ends up.
          top: start.height / 2,
          transform: "translateY(-50%)",
          width: PANEL_WIDTH,
          borderRadius: "var(--radius-panel)",
        }}
      >
        <h2 className="text-body font-semibold">Background</h2>

        <div role="radiogroup" aria-label="Fill" className="grid grid-cols-6 gap-2">
          {FILLS.map((fill) => {
            const active = style.fill === fill.value;
            return (
              <button
                key={fill.value}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={fill.label}
                title={fill.label}
                onClick={() => update({ fill: fill.value })}
                className="aspect-square rounded-md"
                style={{
                  background: fill.swatch,
                  border: fill.value === "none" ? "1px dashed var(--text-3)" : "none",
                  boxShadow: active ? "var(--focus-ring)" : "inset 0 0 0 1px var(--border)",
                }}
              />
            );
          })}
        </div>

        <Field label="Padding">
          <Segmented
            options={[
              { value: "s", label: "S" },
              { value: "m", label: "M" },
              { value: "l", label: "L" },
            ]}
            value={style.padding}
            onChange={(padding) => update({ padding: padding as Style["padding"] })}
          />
        </Field>

        <Field label="Corners">
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={style.radius}
            aria-label="Corner radius"
            onChange={(event) => update({ radius: Number(event.target.value) })}
            className="w-28 accent-[var(--accent)]"
          />
        </Field>

        <Field label="Shadow">
          <Switch
            checked={style.shadow}
            label="Shadow"
            onChange={(shadow) => update({ shadow })}
          />
        </Field>

        <Field label="Size">
          <Segmented
            options={[
              { value: "auto", label: "Auto" },
              { value: "16:9", label: "16:9" },
              { value: "1:1", label: "1:1" },
            ]}
            value={style.aspect}
            onChange={(aspect) => update({ aspect: aspect as Style["aspect"] })}
          />
        </Field>

        <p
          className="text-text-3"
          style={{ fontFamily: "var(--mono)", fontVariantNumeric: "tabular-nums" }}
        >
          {preview.outputWidth} × {preview.outputHeight}
        </p>

        {error && (
          <p role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={cancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void done()}
            disabled={saving}
          >
            {saving ? "Saving…" : `Done ${isMac ? "↵" : "Enter"}`}
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-2">{label}</span>
      {children}
    </div>
  );
}

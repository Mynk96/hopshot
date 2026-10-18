import { invoke } from "@tauri-apps/api/core";
import { Icon } from "../shelf/icons";

/**
 * The Settings controls from `design/mockups.html`: `.srow`, `.switch` and `.seg`.
 *
 * `locked` is the Sync gate (DESIGN S7): a Lifetime user sees the control with a padlock,
 * and touching it opens the plans sheet instead of changing anything.
 */

export function Row({
  label,
  hint,
  problem,
  children,
}: {
  label: string;
  hint?: string;
  problem?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-3 py-2.5"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex-1">
        <div className="text-body">{label}</div>
        {hint && <small className="block text-caption text-text-2">{hint}</small>}
        {problem && (
          <small className="block text-caption" style={{ color: "var(--danger)" }}>
            {problem}
          </small>
        )}
      </div>
      {children}
    </div>
  );
}

export function Switch({
  checked,
  label,
  disabled,
  locked,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  locked?: boolean;
  onChange: (next: boolean) => void;
}) {
  const inert = disabled || locked;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled && !locked}
      onClick={() => (locked ? void invoke("open_plans") : onChange(!checked))}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition"
      style={{
        background: checked ? "var(--accent)" : "var(--surface-3)",
        opacity: inert ? 0.5 : 1,
        cursor: inert && !locked ? "not-allowed" : "pointer",
      }}
    >
      <span
        className="absolute size-4 rounded-full bg-white transition-all"
        style={{ left: checked ? 18 : 2 }}
      />
    </button>
  );
}

export function Segmented({
  options,
  value,
  lockedValues,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  /** Values only available with Sync; they show a padlock (DESIGN S7). */
  lockedValues?: string[];
  onChange: (next: string) => void;
}) {
  return (
    <div
      className="flex gap-0.5 p-0.5"
      style={{ background: "var(--surface-3)", borderRadius: "var(--radius-control)" }}
    >
      {options.map((option) => {
        const locked = lockedValues?.includes(option.value) ?? false;
        const active = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => (locked ? void invoke("open_plans") : onChange(option.value))}
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-caption"
            style={{
              background: active ? "var(--surface-solid)" : "transparent",
              color: active ? "var(--text)" : "var(--text-2)",
              opacity: locked ? 0.6 : 1,
            }}
          >
            {option.label}
            {locked && <Icon name="lock" size={11} />}
          </button>
        );
      })}
    </div>
  );
}

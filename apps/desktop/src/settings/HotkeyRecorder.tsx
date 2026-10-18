import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Records a shortcut by listening to one real key press (DESIGN S7 → "Change").
 *
 * Produces a Tauri accelerator string (`CmdOrCtrl+Shift+2`) rather than a display string,
 * because that is what `settings.json` stores and what the global-shortcut plugin parses.
 * Conflicts are *not* decided here: the Rust side owns that, and reports them back through
 * `set_settings`, which is the only way to know whether the OS will actually grant it.
 */

/** A shortcut with no modifier would swallow ordinary typing. */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/** Turn a KeyboardEvent into an accelerator the Rust side can parse. */
export function toAccelerator(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const parts: string[] = [];
  // CmdOrCtrl keeps one stored string working on both OSes.
  if (event.metaKey || event.ctrlKey) parts.push("CmdOrCtrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const code = event.code;
  let key: string | null = null;

  if (code.startsWith("Digit")) key = code.slice(5);
  else if (code.startsWith("Key")) key = code.slice(3);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (code === "Space") key = "Space";
  else if (code === "Comma") key = ",";
  else if (code === "Period") key = ".";
  else if (code === "Slash") key = "/";
  else if (code === "Backquote") key = "`";

  if (!key) return null;
  // The OS would deliver a bare letter on every keystroke, so require a modifier.
  if (parts.length === 0) return null;

  parts.push(key);
  return parts.join("+");
}

/** `CmdOrCtrl+Shift+2` → the keycaps DESIGN §2 specifies. */
export function toKeycaps(accelerator: string): string[] {
  const isMac = navigator.userAgent.includes("Mac");
  return accelerator.split("+").map((part) => {
    switch (part) {
      case "CmdOrCtrl":
      case "CommandOrControl":
        return isMac ? "⌘" : "Ctrl";
      case "Shift":
        return "⇧";
      case "Alt":
        return isMac ? "⌥" : "Alt";
      default:
        return part;
    }
  });
}

export function HotkeyRecorder({
  value,
  clearable,
  onChange,
}: {
  value: string | null;
  clearable?: boolean;
  onChange: (next: string | null) => void;
}) {
  const [recording, setRecording] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  const stop = useCallback(() => setRecording(false), []);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // While recording, every key belongs to the recorder — including Tab, which would
      // otherwise move focus out mid-capture.
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        stop();
        return;
      }

      const accelerator = toAccelerator(event);
      if (!accelerator) return; // a lone modifier, or a key with no accelerator name

      onChange(accelerator);
      stop();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, onChange, stop]);

  return (
    <div className="flex items-center gap-2">
      {recording ? (
        <span className="text-caption text-text-2">Press keys…</span>
      ) : value ? (
        <span className="flex gap-1">
          {toKeycaps(value).map((cap, index) => (
            <kbd
              // Keycaps repeat (⇧ twice in some combos), so the index is part of the key.
              key={`${cap}-${index}`}
              className="text-caption"
              style={{
                fontFamily: "var(--mono)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                padding: "1px 5px",
              }}
            >
              {cap}
            </kbd>
          ))}
        </span>
      ) : (
        <span className="text-caption text-text-2">Not set</span>
      )}

      <button
        ref={button}
        type="button"
        onClick={() => setRecording((on) => !on)}
        onBlur={stop}
        className="rounded-md px-2 py-1 text-caption"
        style={{ background: "var(--surface-3)", color: "var(--text)" }}
      >
        {recording ? "Cancel" : "Change"}
      </button>

      {clearable && value && !recording && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="rounded-md px-2 py-1 text-caption text-text-2"
          style={{ background: "var(--surface-3)" }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

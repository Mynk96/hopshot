import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../shelf/icons";
import { Devices } from "./Devices";
import { License } from "./License";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { Row, Segmented, Switch } from "./controls";
import type { AppSettings, HotkeyConflict, PlanStatus, Tab } from "./types";

/**
 * Settings (DESIGN S7, 720x520, sidebar + content), matching `design/mockups.html`.
 *
 * General, Shelf, Devices, License and About are live. Privacy is a placeholder, shown so
 * the sidebar is honest about what exists rather than hiding a section that is coming.
 *
 * Every write goes through `set_settings`, which validates, persists and re-binds the
 * global shortcuts in one call — so the UI never has to keep its own copy in sync.
 */

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "general", label: "General", icon: "settings" },
  { key: "shelf", label: "Shelf", icon: "layers" },
  { key: "devices", label: "Devices", icon: "smartphone" },
  { key: "license", label: "License", icon: "key" },
  { key: "privacy", label: "Privacy", icon: "shield" },
  { key: "about", label: "About", icon: "info" },
];

export default function Settings() {
  const [tab, setTab] = useState<Tab>("general");

  /*
   * The tray's "Pair phone…" opens this window and asks for a tab (DESIGN S1). Rust emits
   * the event rather than the window being opened at a URL, because the window already
   * exists and is only revealed — reloading it to carry a query string would throw away
   * whatever the user had open.
   */
  useEffect(() => {
    const subscription = listen<Tab>("settings:tab", (event) => setTab(event.payload));
    return () => {
      void subscription.then((off) => off());
    };
  }, []);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [conflicts, setConflicts] = useState<HotkeyConflict[]>([]);
  const [plan, setPlan] = useState<PlanStatus | null>(null);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [current, planStatus, autostart] = await Promise.all([
          invoke<{ settings: AppSettings; hotkeyConflicts: HotkeyConflict[] }>("get_settings"),
          invoke<PlanStatus>("get_plan"),
          invoke<boolean>("get_launch_at_login").catch(() => false),
        ]);
        setSettings(current.settings);
        setConflicts(current.hotkeyConflicts);
        setPlan(planStatus);
        setLaunchAtLogin(autostart);
      } catch (cause) {
        console.error("could not load settings", cause);
        setError(String(cause));
      }
    })();
  }, []);

  /** Persist one key. Rust is the source of truth for what comes back. */
  const update = useCallback(async (patch: Partial<AppSettings>) => {
    try {
      setError(null);
      const next = await invoke<{
        settings: AppSettings;
        hotkeyConflicts: HotkeyConflict[];
      }>("set_settings", { patch });
      setSettings(next.settings);
      setConflicts(next.hotkeyConflicts);
    } catch (cause) {
      // A rejected patch is usually a malformed accelerator; show it rather than silently
      // reverting the control.
      setError(String(cause));
    }
  }, []);

  const toggleAutostart = useCallback(async (enabled: boolean) => {
    try {
      setLaunchAtLogin(await invoke<boolean>("set_launch_at_login", { enabled }));
    } catch (cause) {
      console.error("could not change the login item", cause);
      setError(String(cause));
    }
  }, []);

  // Theme follows the setting; "system" defers to the OS (DESIGN tokens header).
  useEffect(() => {
    const root = document.documentElement;
    if (!settings || settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
  }, [settings]);

  if (!settings || !plan) {
    return <div className="grid h-dvh place-items-center text-caption text-text-2">Loading…</div>;
  }

  return (
    <div className="flex h-dvh bg-surface-solid text-text">
      <nav
        className="flex w-44 shrink-0 flex-col gap-0.5 p-2"
        style={{ borderRight: "1px solid var(--border)" }}
        aria-label="Settings sections"
      >
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-selected={tab === entry.key}
            onClick={() => setTab(entry.key)}
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body"
            style={{
              background: tab === entry.key ? "var(--surface-3)" : "transparent",
              color: tab === entry.key ? "var(--text)" : "var(--text-2)",
            }}
          >
            <Icon name={entry.icon} />
            {entry.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-6">
        {error && (
          <p
            className="mb-4 rounded-lg px-3 py-2 text-caption"
            style={{ background: "var(--surface-2)", color: "var(--danger)" }}
            role="alert"
          >
            {error}
          </p>
        )}

        {tab === "general" && (
          <General
            settings={settings}
            conflicts={conflicts}
            launchAtLogin={launchAtLogin}
            onUpdate={update}
            onToggleAutostart={toggleAutostart}
          />
        )}
        {tab === "shelf" && <Shelf settings={settings} plan={plan} onUpdate={update} />}
        {tab === "devices" && <Devices settings={settings} onUpdate={update} />}
        {tab === "license" && <License />}
        {tab === "privacy" && <Placeholder title="Privacy" phase="Phase 7" />}
        {tab === "about" && <About />}
      </main>
    </div>
  );
}

function General({
  settings,
  conflicts,
  launchAtLogin,
  onUpdate,
  onToggleAutostart,
}: {
  settings: AppSettings;
  conflicts: HotkeyConflict[];
  launchAtLogin: boolean;
  onUpdate: (patch: Partial<AppSettings>) => void;
  onToggleAutostart: (enabled: boolean) => void;
}) {
  const conflictFor = (key: string): string | undefined =>
    conflicts.find((c) => c.settingKey === key)?.message ?? undefined;

  return (
    <section>
      <h3 className="mb-3 text-title">General</h3>

      <Group>
        <Row label="Launch at login">
          <Switch checked={launchAtLogin} label="Launch at login" onChange={onToggleAutostart} />
        </Row>
        <Row label="Capture area" problem={conflictFor("captureHotkey")}>
          <HotkeyRecorder
            value={settings.captureHotkey}
            onChange={(next) => next && onUpdate({ captureHotkey: next })}
          />
        </Row>
        <Row label="Show shelf" problem={conflictFor("shelfHotkey")}>
          <HotkeyRecorder
            value={settings.shelfHotkey}
            onChange={(next) => next && onUpdate({ shelfHotkey: next })}
          />
        </Row>
        <Row
          label="Capture full screen"
          hint="Optional — unset by default"
          problem={conflictFor("fullScreenHotkey")}
        >
          <HotkeyRecorder
            value={settings.fullScreenHotkey}
            clearable
            onChange={(fullScreenHotkey) => onUpdate({ fullScreenHotkey })}
          />
        </Row>
      </Group>

      <Group>
        <Row label="After capture: copy to clipboard">
          <Switch
            checked={settings.copyOnCapture}
            label="Copy to clipboard"
            onChange={(copyOnCapture) => onUpdate({ copyOnCapture })}
          />
        </Row>
        <Row label="After capture: show shelf">
          <Switch
            checked={settings.showShelfOnCapture}
            label="Show shelf"
            onChange={(showShelfOnCapture) => onUpdate({ showShelfOnCapture })}
          />
        </Row>
        <Row label="Theme">
          <Segmented
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            value={settings.theme}
            onChange={(theme) => onUpdate({ theme: theme as AppSettings["theme"] })}
          />
        </Row>
      </Group>
    </section>
  );
}

function Shelf({
  settings,
  plan,
  onUpdate,
}: {
  settings: AppSettings;
  plan: PlanStatus;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const isMac = navigator.userAgent.includes("Mac");

  return (
    <section>
      <h3 className="mb-3 text-title">Shelf</h3>

      <Group>
        <Row label="Position">
          <Segmented
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
            value={settings.shelfSide}
            onChange={(shelfSide) => onUpdate({ shelfSide: shelfSide as AppSettings["shelfSide"] })}
          />
        </Row>

        <Row label="Auto-hide after">
          <Segmented
            options={[
              { value: "4", label: "4s" },
              { value: "8", label: "8s" },
              { value: "15", label: "15s" },
              { value: "never", label: "Never" },
            ]}
            value={settings.autoHideSeconds === null ? "never" : String(settings.autoHideSeconds)}
            onChange={(value) =>
              onUpdate({ autoHideSeconds: value === "never" ? null : Number(value) })
            }
          />
        </Row>

        <Row label="Keep items for" hint={`Shelf holds up to ${plan.shelfCapacity} items`}>
          <Segmented
            // The options come from limits.json, so a plan change is a config change.
            options={plan.itemTtlOptions.map((value) => ({ value, label: value }))}
            value={settings.itemTtl}
            onChange={(itemTtl) => onUpdate({ itemTtl })}
          />
        </Row>

        <Row label="Remove after dragging out">
          <Switch
            checked={settings.removeAfterDrag}
            label="Remove after drag"
            onChange={(removeAfterDrag) => onUpdate({ removeAfterDrag })}
          />
        </Row>

        <Row
          label="Catch other screenshots"
          hint={`Add images from the clipboard and ${isMac ? "⌘⇧4" : "Win+Shift+S"} to the shelf`}
        >
          {/* PRD F1.7 is P1: shown so the setting is discoverable, disabled until built. */}
          <Switch checked={false} label="Catch other screenshots" disabled onChange={() => {}} />
        </Row>
      </Group>
    </section>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mb-5 px-3"
      style={{
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-panel)",
      }}
    >
      {children}
    </div>
  );
}

function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <section>
      <h3 className="mb-3 text-title">{title}</h3>
      <div
        className="rounded-xl p-5 text-body text-text-2"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      >
        {title} settings arrive in {phase}.
      </div>
    </section>
  );
}

function About() {
  return (
    <section>
      <h3 className="mb-3 text-title">About</h3>
      <div
        className="flex items-center gap-3 rounded-xl p-5"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      >
        <span
          aria-hidden
          className="inline-block size-8 shrink-0"
          style={{ background: "var(--accent)", borderRadius: 8 }}
        />
        <div>
          <b className="text-body">Hopshot 0.1.0</b>
          <p className="text-caption text-text-2">
            Screenshots that clean up after themselves.
          </p>
        </div>
      </div>
    </section>
  );
}

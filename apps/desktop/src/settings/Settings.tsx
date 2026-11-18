import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../shelf/icons";
import { Devices } from "./Devices";
import { License } from "./License";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { Group, Row, Segmented, Switch } from "./controls";
import { Privacy } from "./Privacy";
import type { AppSettings, CatchStatus, HotkeyConflict, PlanStatus, Tab } from "./types";

/**
 * Settings (DESIGN S7, 720x520, sidebar + content), matching `design/mockups.html`.
 *
 * General, Shelf, Devices, License, Privacy and About are all live.
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
        {tab === "privacy" && <Privacy />}
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
  const [catchStatus, setCatchStatus] = useState<CatchStatus | null>(null);

  // PRD F1.7: the watcher restarts when the setting is saved, so read its state after.
  useEffect(() => {
    void invoke<CatchStatus>("catch_status")
      .then(setCatchStatus)
      .catch(() => setCatchStatus(null));
  }, [settings.catchOtherScreenshots]);

  const folder = catchStatus?.folder ?? (isMac ? "your Desktop" : "Pictures\\Screenshots");
  const catchHint = isMac
    ? `Adds ⌘⇧4 screenshots from ${folder}. They appear once macOS saves them; turn off Show Floating Thumbnail in ⌘⇧5 → Options to make that instant.`
    : `Adds Win+Shift+S screenshots saved to ${folder}. Turn on auto-save in Snipping Tool if they don't appear.`;

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
          hint={catchHint}
          problem={settings.catchOtherScreenshots ? (catchStatus?.problem ?? undefined) : undefined}
        >
          {/* PRD F1.7: copies OS screenshots onto the shelf; the original file is untouched. */}
          <Switch
            checked={settings.catchOtherScreenshots}
            label="Catch other screenshots"
            onChange={(catchOtherScreenshots) => onUpdate({ catchOtherScreenshots })}
          />
        </Row>
      </Group>
    </section>
  );
}

/** What the update block is currently showing. */
type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "installing" }
  | { kind: "failed"; message: string };

function About() {
  /*
   * Read from the binary rather than hard-coded. There were four copies of this string and
   * this one was already stale; scripts/check-version.mjs guards the other three, and
   * getVersion() means it can never need guarding.
   */
  const [version, setVersion] = useState("");
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<UpdateState>({ kind: "idle" });

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined);
    void invoke<boolean>("update_supported").then(setSupported).catch(() => setSupported(false));

    // The background check (ARCHITECTURE §9) announces what it found, so opening Settings
    // after it has run already shows the update without a second round trip.
    const subscription = listen<{ version: string }>("update:available", (event) =>
      setState({ kind: "available", version: event.payload.version }),
    );
    return () => {
      void subscription.then((off) => off());
    };
  }, []);

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const found = await invoke<{ version: string } | null>("update_check");
      setState(found ? { kind: "available", version: found.version } : { kind: "current" });
    } catch (reason) {
      // Being offline is the usual reason and is not worth alarming language.
      setState({ kind: "failed", message: String(reason) });
    }
  };

  const install = async () => {
    setState({ kind: "installing" });
    try {
      // On success Hopshot restarts, so nothing after this runs.
      await invoke("update_install");
    } catch (reason) {
      setState({ kind: "failed", message: String(reason) });
    }
  };

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
          <b className="text-body">Hopshot {version}</b>
          <p className="text-caption text-text-2">
            Screenshots that clean up after themselves.
          </p>
        </div>
      </div>

      {/* Hidden in the Microsoft Store build, where the Store updates the app (ARCHITECTURE §9). */}
      {supported && (
        <div className="mt-4 flex flex-col items-start gap-2">
          {state.kind === "available" ? (
            <>
              <b className="text-body-strong">Hopshot {state.version} is available</b>
              <span className="text-small text-text-2">
                Installing closes Hopshot and reopens it. Your shelf is kept.
              </span>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void install()}
              >
                Install and restart
              </button>
            </>
          ) : state.kind === "installing" ? (
            <span className="text-small text-text-2">Downloading… Hopshot will restart.</span>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={state.kind === "checking"}
                onClick={() => void check()}
              >
                {state.kind === "checking" ? "Checking…" : "Check for updates"}
              </button>
              {state.kind === "current" && (
                <span className="text-small text-text-2">You&apos;re up to date.</span>
              )}
              {state.kind === "failed" && (
                <span className="text-small text-text-2">
                  Couldn&apos;t check just now. {state.message}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

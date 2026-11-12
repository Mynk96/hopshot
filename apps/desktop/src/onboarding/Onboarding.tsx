import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { limits } from "shared";
import { toKeycaps } from "../settings/HotkeyRecorder";
import type { AppSettings } from "../settings/types";
import { Icon } from "../shelf/icons";
import { BrandMark } from "../shelf/Shelf";

/**
 * First-launch onboarding (DESIGN S8, 560×600; PRD US-12).
 *
 * Hopshot has no Dock icon and no window of its own, so this is the only thing a fresh
 * install shows. Rust opens it while `settings.onboarded` is false; Finish or the close
 * button sets it.
 *
 * Pay-first (docs/designs/pay-first-10.md): a Pay step sits before Try it, because capture
 * is locked until a purchase. There is no stats checkbox; usage counts are always on and
 * disclosed (ARCHITECTURE §7.10).
 */

type Step = "welcome" | "permission" | "pay" | "try" | "done";
type Access = "granted" | "denied" | "unknown";

const isMac = navigator.userAgent.includes("Mac");
/**
 * The macOS permission step only exists on macOS (Windows has no such gate). Pay comes before
 * Try it because capture is locked until a purchase (docs/designs/pay-first-10.md).
 */
const STEPS: Step[] = isMac
  ? ["welcome", "permission", "pay", "try", "done"]
  : ["welcome", "pay", "try", "done"];
/** How often the permission row re-checks while the user is in System Settings. */
const POLL_MS = 1000;

export default function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const [hotkey, setHotkey] = useState("CmdOrCtrl+Shift+2");
  const [shelfHotkey, setShelfHotkey] = useState("CmdOrCtrl+Shift+1");
  const [access, setAccess] = useState<Access>("unknown");
  const [captured, setCaptured] = useState(false);
  /** Whether this computer holds a licence; null until the first read. */
  const [licensed, setLicensed] = useState<boolean | null>(null);
  const [theme, setTheme] = useState<AppSettings["theme"] | null>(null);

  // index.html ships data-theme="dark" (the shelf and overlay need it before first paint).
  // Like Settings, this window follows the Theme setting, and "system" defers to the OS.
  useEffect(() => {
    const root = document.documentElement;
    if (!theme || theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  const checkAccess = useCallback(async () => {
    try {
      setAccess(await invoke<Access>("permissions_status"));
    } catch (error) {
      console.error("could not read the screen permission", error);
    }
  }, []);

  useEffect(() => {
    void checkAccess();
    invoke<{ settings: AppSettings }>("get_settings")
      .then((current) => {
        setHotkey(current.settings.captureHotkey);
        setShelfHotkey(current.settings.shelfHotkey);
        setTheme(current.settings.theme);
      })
      .catch((error: unknown) => console.error("could not read the settings", error));
  }, [checkAccess]);

  // While the permission step is open, follow the user's progress in System Settings.
  useEffect(() => {
    if (step !== "permission") return;
    const timer = setInterval(() => void checkAccess(), POLL_MS);
    return () => clearInterval(timer);
  }, [step, checkAccess]);

  // Licence state: read now, and again when a purchase or restore lands (the app polls the
  // checkout claim and emits license:changed when it is done).
  useEffect(() => {
    const read = () =>
      void invoke<{ capturePaused: boolean }>("plan_state")
        .then((state) => setLicensed(!state.capturePaused))
        .catch(() => undefined);
    read();
    const subscriptions = [listen("license:changed", read), listen("plan:changed", read)];
    return () => {
      for (const pending of subscriptions) void pending.then((off) => off());
    };
  }, []);

  // The "Try it" step completes itself when a capture lands on the shelf.
  useEffect(() => {
    const subscription = listen("shelf:highlight", () => setCaptured(true));
    return () => {
      void subscription.then((off) => off());
    };
  }, []);

  /*
   * Advance from `from`, and only from it. In WebKit (the macOS webview) one Return press
   * on a footer button could activate it and then the button that replaced it, skipping a
   * step; naming the origin step makes a second activation a no-op.
   */
  const advanceFrom = (from: Step) => {
    setStep((current) => {
      if (current !== from) return current;
      let after = STEPS[STEPS.indexOf(from) + 1];
      // Skip what is already done: permission granted (or relaunched after "Quit & Reopen"),
      // and payment when this computer is already licensed.
      while (
        (after === "permission" && access === "granted") ||
        (after === "pay" && licensed === true)
      ) {
        after = STEPS[STEPS.indexOf(after) + 1];
      }
      return after ?? current;
    });
  };
  const next = () => advanceFrom(step);

  const finish = () => {
    void invoke("finish_onboarding").catch((error: unknown) =>
      console.error("could not finish onboarding", error),
    );
  };

  return (
    <main className="flex h-dvh flex-col bg-surface-solid px-10 pt-12 pb-8 text-text">
      <div className="flex flex-1 flex-col">
        {step === "welcome" && <Welcome />}
        {step === "permission" && (
          <Permission
            access={access}
            onOpen={() => void invoke("permissions_open_settings").catch(() => undefined)}
          />
        )}
        {step === "pay" && <Pay licensed={licensed === true} />}
        {step === "try" && <TryIt keys={toKeycaps(hotkey)} captured={captured} />}
        {step === "done" && (
          <Done shelfKeys={toKeycaps(shelfHotkey)} licensed={licensed === true} />
        )}
      </div>

      <footer className="flex items-center justify-between">
        <Dots current={STEPS.indexOf(step)} total={STEPS.length} />
        {/* Keyed by step so no button element (or its focus) carries over to the next step. */}
        <div key={step} className="flex items-center gap-2">
          {step === "permission" && access !== "granted" && (
            <button type="button" className="btn btn-ghost" onClick={next}>
              Skip for now
            </button>
          )}
          {step === "pay" && licensed !== true && (
            // Capture is locked without a licence, so there is nothing to try: go to the end.
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setStep((current) => (current === "pay" ? "done" : current))}
            >
              Not now
            </button>
          )}
          {step === "try" && !captured && (
            <button type="button" className="btn btn-ghost" onClick={next}>
              Skip
            </button>
          )}
          {step === "done" ? (
            <button type="button" className="btn btn-primary" onClick={finish}>
              Finish
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                (step === "permission" && access !== "granted") ||
                (step === "pay" && licensed !== true) ||
                (step === "try" && !captured)
              }
              onClick={next}
            >
              {step === "welcome" ? "Get started" : "Continue"}
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}

function Welcome() {
  return (
    <>
      <BrandMark size={36} />
      <h1 className="mt-4 text-display">Screenshots that clean up after themselves.</h1>
      <ul className="mt-8 flex flex-col gap-4">
        <Bullet
          icon="image"
          title="Drag anywhere"
          text="Every capture lands on a floating shelf. Drag it into any app or website."
        />
        <Bullet
          icon="smartphone"
          title="Open on your phone"
          text="Scan a code and it's on your phone, end-to-end encrypted."
        />
        <Bullet
          icon="lock"
          title="Gone in 24h"
          text="Nothing piles up on your desktop or our servers."
        />
      </ul>
    </>
  );
}

function Bullet({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="grid shrink-0 place-items-center"
        style={{
          width: 32,
          height: 32,
          borderRadius: "var(--radius-card)",
          background: "var(--surface-2)",
          color: "var(--text-2)",
        }}
      >
        <Icon name={icon} size={16} />
      </span>
      <span className="flex flex-col">
        <b className="text-body-strong">{title}</b>
        <span className="text-body text-text-2">{text}</span>
      </span>
    </li>
  );
}

function Permission({ access, onOpen }: { access: Access; onOpen: () => void }) {
  const granted = access === "granted";
  return (
    <>
      <h1 className="text-heading">Let Hopshot see your screen</h1>
      <p className="mt-3 text-body text-text-2">
        Hopshot needs Screen Recording permission to capture your screen. Turn it on for Hopshot in
        System Settings, then come back here.
      </p>
      <button type="button" className="btn btn-secondary mt-6 self-start" onClick={onOpen}>
        Open System Settings
      </button>
      <p
        className="mt-5 flex items-center gap-2 text-body-strong"
        role="status"
        style={{ color: granted ? "var(--success)" : "var(--text-2)" }}
      >
        {granted ? <Icon name="check" size={14} /> : <span aria-hidden>◌</span>}
        {granted ? "Granted" : "Waiting…"}
      </p>
      <p className="mt-auto text-small text-text-3">
        If macOS asks to quit and reopen Hopshot, do it; this window comes back. macOS may ask you
        to confirm this again from time to time.
      </p>
    </>
  );
}

function TryIt({ keys, captured }: { keys: string[]; captured: boolean }) {
  return (
    <>
      <h1 className="text-heading">Take your first screenshot</h1>
      <p className="mt-8 flex gap-2" aria-label={`Press ${keys.join(" ")}`}>
        {keys.map((key) => (
          <kbd
            key={key}
            className="text-title motion-safe:animate-pulse"
            style={{
              fontFamily: "var(--mono)",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "6px 12px",
            }}
          >
            {key}
          </kbd>
        ))}
      </p>
      <p className="mt-4 text-body text-text-2" role="status">
        {captured
          ? "Got it. Now drag it from the shelf into any browser tab."
          : "Press the shortcut, then select anything on your screen."}
      </p>
    </>
  );
}

function Pay({ licensed }: { licensed: boolean }) {
  const [started, setStarted] = useState(false);
  const price = limits.pricing.display;
  return (
    <>
      <h1 className="text-heading">Unlock Hopshot for {price}</h1>
      <p className="mt-3 text-body text-text-2">
        One payment, everything included: capture, the shelf, drag anywhere, and your phone. No
        subscription. 14-day refund, no questions.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={licensed}
          onClick={() => {
            setStarted(true);
            void invoke("license_buy", { plan: "bundle" }).catch(() => setStarted(false));
          }}
        >
          Buy · {price} once
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={licensed}
          onClick={() => void invoke("open_settings", { tab: "license" }).catch(() => undefined)}
        >
          Already bought? Restore
        </button>
      </div>
      {(started || licensed) && (
        <p
          className="mt-5 flex items-center gap-2 text-body-strong"
          role="status"
          style={{ color: licensed ? "var(--success)" : "var(--text-2)" }}
        >
          {licensed ? <Icon name="check" size={14} /> : <span aria-hidden>◌</span>}
          {licensed ? "Unlocked" : "Finish paying in your browser…"}
        </p>
      )}
    </>
  );
}

function Done({ shelfKeys, licensed }: { shelfKeys: string[]; licensed: boolean }) {
  return (
    <>
      <h1 className="text-heading">{licensed ? "You're all set" : "Almost there"}</h1>
      <p className="mt-3 text-body text-text-2">
        {licensed
          ? "Every capture lands on the shelf. Drag it into any app, copy it, or send it to your phone."
          : `Hopshot stays locked until you unlock it for ${limits.pricing.display}, from the shelf or Settings → License. One payment, everything included. 14-day refund, no questions.`}
      </p>
      <p className="mt-3 text-body text-text-2">
        Hopshot lives in your menu bar. Show the shelf any time with {shelfKeys.join(" ")}.
      </p>
      <EmailSignup />
    </>
  );
}

type Signup = { state: "idle" | "sending" | "sent" } | { state: "error"; message: string };

/**
 * Optional: join the maker's mailing list (ARCHITECTURE §7.10). Double opt-in, so nothing
 * happens until the emailed link is followed. Its own <form>, so Return in the field submits
 * this, not the footer's Finish.
 */
function EmailSignup() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Signup>({ state: "idle" });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus({ state: "sending" });
    try {
      await invoke("subscribe", { email });
      setStatus({ state: "sent" });
    } catch (error) {
      setStatus({ state: "error", message: String(error) });
    }
  };

  if (status.state === "sent") {
    return (
      <p className="mt-8 text-body-strong" role="status" style={{ color: "var(--success)" }}>
        Check your inbox to confirm.
      </p>
    );
  }

  return (
    <form className="mt-8 flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      <label htmlFor="signup-email" className="text-body-strong">
        Hear about new tools from the maker of Hopshot
      </label>
      <div className="flex gap-2">
        <input
          id="signup-email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="flex-1 text-body"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 10px",
            color: "var(--text)",
          }}
        />
        <button type="submit" className="btn btn-secondary" disabled={status.state === "sending"}>
          Keep me posted
        </button>
      </div>
      <span
        className="text-small text-text-3"
        role={status.state === "error" ? "alert" : undefined}
      >
        {status.state === "error"
          ? "Couldn't sign you up just now. Check your connection and try again."
          : "Optional. A few emails a year, one-click unsubscribe."}
      </span>
    </form>
  );
}

function Dots({ current, total }: { current: number; total: number }) {
  return (
    <span className="flex gap-1.5" aria-label={`Step ${current + 1} of ${total}`}>
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: index === current ? "var(--accent)" : "var(--surface-3)",
          }}
        />
      ))}
    </span>
  );
}

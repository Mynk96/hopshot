import { useEffect, useState } from "react";
import { isIos, isStandalone } from "../lib/vault.ts";

/**
 * "Add to Home Screen" (PRD F4.2 — "installable PWA").
 *
 * The point is that the user never has to find Chrome's ⋮ menu. Android fires
 * `beforeinstallprompt` once the app is installable; we keep that event and replay it on a
 * tap, which is the only way `prompt()` is allowed to run. iOS has no such event at all, so
 * it gets the manual Share-sheet steps instead.
 *
 * **`beforeinstallprompt` only fires when a service worker with a fetch handler is
 * registered.** That is why `register-sw.ts` had to stop being an inline script: the CSP
 * blocked it, no worker registered, and the event never arrived — so there was nothing to
 * offer even though the manifest was perfectly valid.
 */

/** Not in lib.dom yet; Chromium-only. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Remembering a dismissal is the difference between a prompt and a nag. */
const DISMISSED_KEY = "hopshot:installDismissed";

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === "1",
  );
  const [showIosSteps, setShowIosSteps] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Chrome shows its own mini-infobar unless this is prevented; we want the prompt to
      // appear where it makes sense in our own UI instead.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Already running from the Home Screen, or the user said no once.
  if (installed || dismissed) return null;

  // iOS never fires the event, so offer the steps whenever we are in Safari rather than
  // waiting for something that cannot arrive.
  const iosNeedsSteps = isIos() && !isStandalone();
  if (!deferred && !iosNeedsSteps) return null;

  const install = async () => {
    if (!deferred) {
      setShowIosSteps(true);
      return;
    }
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;

    // The event is single-use; Chrome will fire a fresh one if it is still installable.
    setDeferred(null);
    if (outcome === "dismissed") remember();
  };

  const remember = () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };

  if (showIosSteps) {
    return (
      <div
        className="raised m-3 flex flex-col gap-3 p-4"
        role="region"
        aria-label="Add to Home Screen"
      >
        <b className="text-body-strong">Add Hopshot to your Home Screen</b>
        <ol className="flex flex-col gap-2 text-body text-text-2">
          <li>
            1. Tap <strong>Share</strong> at the bottom of Safari.
          </li>
          <li>
            2. Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </li>
          <li>3. Open Hopshot from your Home Screen.</li>
        </ol>
        <button type="button" className="btn btn-secondary btn-compact self-start" onClick={remember}>
          Got it
        </button>
      </div>
    );
  }

  return (
    <div
      className="raised m-3 flex items-center gap-3 p-3"
      role="region"
      aria-label="Add to Home Screen"
    >
      <span
        aria-hidden
        className="grid shrink-0 place-items-center"
        style={{
          width: 36,
          height: 36,
          borderRadius: 9,
          background: "var(--accent)",
          color: "var(--on-accent)",
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 5v14M5 12l7 7 7-7" />
        </svg>
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <b className="text-body-strong">Add to Home Screen</b>
        <span className="text-caption text-text-2">
          Open Hopshot like an app — no browser, no link.
        </span>
      </span>

      <button type="button" className="btn btn-primary btn-compact" onClick={() => void install()}>
        Add
      </button>
      <button type="button" className="icon-btn" aria-label="Not now" onClick={remember}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

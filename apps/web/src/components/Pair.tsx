import { useEffect, useState } from "react";
import InstallPrompt from "./InstallPrompt.tsx";
import {
  isIos,
  isStandalone,
  loadCredentials,
  pair,
  parsePairFragment,
  setDeviceName,
  VaultError,
} from "../lib/vault.ts";

/**
 * `/pair` — redeem a pairing QR (ARCHITECTURE §8, PRD F4.1/F4.2/F4.8).
 *
 * The fragment carries `#{code}.{vaultKey}`. Browsers never send a fragment to the server,
 * so the vault key reaches this script and nothing else; it is imported as a non-extractable
 * CryptoKey and the raw value is never stored or logged (CLAUDE.md privacy invariant).
 *
 * **The iOS case is the whole reason this screen is more than a spinner.** A home-screen web
 * app on iOS gets storage separate from Safari, so pairing in Safari and then installing
 * produces an app that is not paired. We therefore do not redeem the single-use code in
 * Safari at all when we can tell the user is on iOS and not yet installed — redeeming it
 * there would burn the invite and leave the installed app with nothing to use.
 */

type Phase =
  | { name: "checking" }
  | { name: "install-first"; code: string; vaultKey: string }
  | { name: "pairing" }
  | { name: "paired" }
  | { name: "already-paired" }
  | { name: "bad-link" }
  | { name: "failed"; message: string };

/** A reasonable default the user can change later in the app's menu. */
function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  return "My phone";
}

export default function Pair() {
  const [phase, setPhase] = useState<Phase>({ name: "checking" });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const parsed = parsePairFragment(window.location.hash);

      if (!parsed) {
        // Either a hand-typed URL or a half-scanned code. If this browser is already paired
        // there is nothing wrong — send them on.
        const existing = await loadCredentials();
        if (cancelled) return;
        // Written out rather than a ternary on `name`: a conditional there widens the union
        // and stops TypeScript seeing it as the discriminant.
        if (existing) setPhase({ name: "already-paired" });
        else setPhase({ name: "bad-link" });
        return;
      }

      /*
       * iOS, in a browser tab rather than the installed app: stop here and explain. The code
       * is single-use, so redeeming it now would make the installed app unpairable (F4.8).
       */
      if (isIos() && !isStandalone()) {
        if (cancelled) return;
        setPhase({ name: "install-first", ...parsed });
        return;
      }

      setPhase({ name: "pairing" });
      try {
        await pair(parsed.code, parsed.vaultKey, guessDeviceName());
        await setDeviceName(guessDeviceName());
        if (cancelled) return;

        // Drop the fragment before navigating, so the key is not left in history.
        history.replaceState(null, "", window.location.pathname);
        // Deliberately no auto-redirect: the install offer lives on this screen, and
        // bouncing to /app a second later would snatch it away mid-tap.
        setPhase({ name: "paired" });
      } catch (error) {
        if (cancelled) return;
        setPhase({
          name: "failed",
          message:
            error instanceof VaultError
              ? error.message
              : "Pairing didn't work. Make a new code on your computer.",
        });
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      {phase.name === "checking" && <p className="text-body text-text-2">Checking the link…</p>}

      {phase.name === "pairing" && (
        <Centered title="Pairing…" body="Setting up this phone." />
      )}

      {phase.name === "paired" && (
        <>
          <Centered
            icon="check"
            title="Paired"
            body="Screenshots from your computer will show up here."
            action={{ label: "Open Hopshot", href: "/app" }}
          />
          {/* The moment right after success is when someone will actually accept an
              install, so offer it here rather than only on the feed. */}
          <InstallPrompt />
        </>
      )}

      {phase.name === "already-paired" && (
        <Centered
          icon="check"
          title="This phone is already paired"
          body="Open Hopshot to see your screenshots."
          action={{ label: "Open Hopshot", href: "/app" }}
        />
      )}

      {phase.name === "bad-link" && (
        <Centered
          title="This link is incomplete"
          body="Ask for the QR code again on your computer, and scan the whole code."
        />
      )}

      {phase.name === "failed" && <Centered title="Pairing didn't work" body={phase.message} />}

      {phase.name === "install-first" && <InstallFirst />}
    </main>
  );
}

/**
 * PRD F4.8 — the iOS install quirk, explained in the one place it bites.
 *
 * The pairing code is deliberately *not* redeemed before this screen, so the code in the QR
 * is still good when the user scans it again from inside the installed app.
 */
function InstallFirst() {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-heading">Add Hopshot to your Home Screen first</h1>
        <p className="text-body text-text-2">
          On iPhone, an app on your Home Screen has its own private storage, so pairing has to
          happen inside it. This takes about twenty seconds.
        </p>
      </header>

      <ol className="flex flex-col gap-3">
        <Step n={1}>
          Tap the <strong>Share</strong> button at the bottom of Safari.
        </Step>
        <Step n={2}>
          Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
        </Step>
        <Step n={3}>
          Open <strong>Hopshot</strong> from your Home Screen.
        </Step>
        <Step n={4}>
          Tap <strong>Scan to finish</strong> and scan the same code again.
        </Step>
      </ol>

      <p
        className="text-small text-text-2"
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          padding: "10px 12px",
        }}
      >
        Your code is still valid — scanning it here hasn't used it up. It expires ten minutes
        after your computer created it.
      </p>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="grid shrink-0 place-items-center text-caption"
        style={{
          width: 22,
          height: 22,
          borderRadius: "var(--radius-chip)",
          background: "var(--accent)",
          color: "var(--on-accent)",
          fontWeight: 600,
        }}
      >
        {n}
      </span>
      <span className="text-body">{children}</span>
    </li>
  );
}

function Centered({
  icon,
  title,
  body,
  action,
}: {
  icon?: "check";
  title: string;
  body: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {icon === "check" && (
        <span
          aria-hidden
          className="grid place-items-center"
          style={{
            width: 48,
            height: 48,
            borderRadius: "var(--radius-chip)",
            background: "color-mix(in srgb, var(--success) 18%, transparent)",
            color: "var(--success)",
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      )}
      <h1 className="text-heading">{title}</h1>
      <p className="text-body text-text-2">{body}</p>
      {action && (
        <a className="btn btn-primary mt-1" href={action.href}>
          {action.label}
        </a>
      )}
    </div>
  );
}

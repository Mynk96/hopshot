import { useEffect, useRef, useState } from "react";
import { pair, parsePairFragment, setDeviceName, VaultError } from "../lib/vault.ts";

/**
 * The in-app QR scanner (PRD F4.8).
 *
 * This exists for one reason: on iOS a Home Screen web app gets storage separate from
 * Safari, so a user who paired in Safari and then installed arrives with nothing. The only
 * way to pair *inside* the installed app is to read the code again from here.
 *
 * `qr-scanner` is loaded lazily — it pulls in a WASM-ish decoder and a worker, and the vast
 * majority of sessions never open this screen.
 */

type Phase = "starting" | "scanning" | "pairing" | "denied" | "failed";

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  return "My phone";
}

export default function Scanner({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  onPaired: () => void | Promise<void>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // The real instance type, so start/stop/destroy are all checked. `import type` of a
    // default export needs this shape rather than a structural stand-in.
    let scanner: InstanceType<typeof import("qr-scanner").default> | null = null;
    let done = false;

    void (async () => {
      const element = video.current;
      if (!element) return;

      let QrScanner: typeof import("qr-scanner").default;
      try {
        QrScanner = (await import("qr-scanner")).default;
      } catch {
        setPhase("failed");
        setMessage("The scanner couldn't load.");
        return;
      }

      const onResult = async (result: { data: string }) => {
        if (done) return;

        // The QR encodes the whole pairing URL, so the fragment parser is reused rather
        // than a second format being invented here.
        const hash = result.data.includes("#") ? result.data.slice(result.data.indexOf("#")) : "";
        const parsed = parsePairFragment(hash);
        if (!parsed) return; // Not one of ours — keep scanning.

        done = true;
        scanner?.stop();
        setPhase("pairing");

        try {
          await pair(parsed.code, parsed.vaultKey, guessDeviceName());
          await setDeviceName(guessDeviceName());
          await onPaired();
        } catch (error) {
          setPhase("failed");
          setMessage(
            error instanceof VaultError
              ? error.message
              : "That code didn't work. Make a new one on your computer.",
          );
        }
      };

      try {
        scanner = new QrScanner(element, (result) => void onResult(result), {
          // The rear camera is the one pointed at the screen.
          preferredCamera: "environment",
          highlightScanRegion: true,
          highlightCodeOutline: true,
          maxScansPerSecond: 5,
        });
        await scanner.start();
        if (!done) setPhase("scanning");
      } catch (error) {
        // Overwhelmingly a denied camera permission; the browser gives no reliable code.
        console.warn("the camera could not be started", error);
        setPhase("denied");
      }
    })();

    return () => {
      done = true;
      scanner?.stop();
      scanner?.destroy();
    };
  }, [onPaired]);

  return (
    <div
      role="dialog"
      aria-label="Scan the pairing code"
      className="fixed inset-0 z-40 flex flex-col"
      style={{ background: "#000" }}
    >
      <header
        className="flex items-center gap-2 px-3"
        style={{
          paddingTop: "calc(8px + env(safe-area-inset-top))",
          paddingBottom: 8,
          color: "#fff",
        }}
      >
        <b className="flex-1 text-title">Scan the code</b>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="icon-btn"
          style={{ color: "#fff" }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {/* `playsInline` is required or iOS takes the video full-screen and hides the UI. */}
        <video
          ref={video}
          playsInline
          muted
          className="size-full"
          style={{ objectFit: "cover" }}
        />

        {phase !== "scanning" && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
            style={{ background: "rgba(0,0,0,.72)", color: "#fff" }}
          >
            {phase === "starting" && <p className="text-body">Starting the camera…</p>}
            {phase === "pairing" && <p className="text-body">Pairing…</p>}

            {phase === "denied" && (
              <>
                <b className="text-title">Hopshot needs your camera</b>
                <p className="text-body" style={{ opacity: 0.8 }}>
                  Allow camera access to scan the pairing code. On iPhone it is in Settings →
                  Hopshot.
                </p>
              </>
            )}

            {phase === "failed" && (
              <>
                <b className="text-title">That didn&apos;t work</b>
                <p className="text-body" style={{ opacity: 0.8 }}>
                  {message}
                </p>
              </>
            )}

            {(phase === "denied" || phase === "failed") && (
              <button type="button" className="btn btn-secondary mt-1" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        )}
      </div>

      <p
        className="px-6 text-center text-small"
        style={{
          color: "#fff",
          opacity: 0.7,
          paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
        }}
      >
        Point this at the QR code on your computer.
      </p>
    </div>
  );
}

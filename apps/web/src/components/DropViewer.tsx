import { open, fromBase64Url, type Meta } from "@hopshot/crypto";
import { useEffect, useRef, useState } from "react";

/**
 * Drop viewer (`/d/:id`) — DESIGN S6, ARCHITECTURE §8.
 *
 * ```text
 * #key from location.hash ─▶ GET /drops/{id}/info (countdown) ─▶ GET /drops/{id}
 *                         ─▶ HOP1 open ─▶ object URL ─▶ <img>
 * ```
 *
 * **The key never leaves this page.** It lives in the URL fragment, which browsers do not
 * transmit; it is read into memory, used to decrypt, and never written to a request, a log,
 * analytics or storage (CLAUDE.md privacy invariants).
 */

const API_BASE = import.meta.env.PUBLIC_HOPSHOT_API ?? "https://api.hopshot.xyz/v1";

type State =
  | { phase: "decrypting" }
  | { phase: "bad-link" }
  | { phase: "gone" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; src: string; file: File; expiresAt: number; meta: Meta | null };

export function DropViewer({ id }: { id: string }) {
  const [state, setState] = useState<State>({ phase: "decrypting" });
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // The fragment is the key. Reading it is the only thing this page does with it
      // besides decrypting — it is never logged or sent (ARCHITECTURE §6).
      const key = window.location.hash.replace(/^#/, "");
      if (!key) {
        setState({ phase: "bad-link" });
        return;
      }

      let keyBytes: Uint8Array;
      try {
        keyBytes = fromBase64Url(key);
        if (keyBytes.length !== 32) throw new Error("wrong length");
      } catch {
        setState({ phase: "bad-link" });
        return;
      }

      try {
        // Info first, so the countdown can start before the blob arrives.
        const info = await fetch(`${API_BASE}/drops/${id}/info`, { cache: "no-store" });
        if (info.status === 404 || info.status === 410) {
          if (!cancelled) setState({ phase: "gone" });
          return;
        }
        if (!info.ok) throw new Error(`info ${info.status}`);
        const { expiresAt } = (await info.json()) as { expiresAt: number; size: number };

        const blob = await fetch(`${API_BASE}/drops/${id}`, { cache: "no-store" });
        if (blob.status === 404 || blob.status === 410) {
          if (!cancelled) setState({ phase: "gone" });
          return;
        }
        if (!blob.ok) throw new Error(`drop ${blob.status}`);

        const envelope = new Uint8Array(await blob.arrayBuffer());
        const plaintext = await open(keyBytes, "drop", id, envelope);
        if (cancelled) return;

        // Metadata is a separate envelope and optional; without it the file is still fine.
        const meta = await readMeta(blob, keyBytes, id);
        const name = meta?.name ?? "Screenshot.png";
        const file = new File([plaintext as BlobPart], name, {
          type: meta?.mime ?? "image/png",
        });

        objectUrl.current = URL.createObjectURL(file);
        setState({ phase: "ready", src: objectUrl.current, file, expiresAt, meta });
      } catch (error) {
        if (cancelled) return;
        // A failed tag check means a wrong or truncated key, which reads as a bad link.
        const message = String(error);
        setState(
          /authentication/i.test(message)
            ? { phase: "bad-link" }
            : { phase: "failed", message: "This drop couldn't be opened." },
        );
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, [id]);

  if (state.phase === "decrypting") return <Centered>Decrypting…</Centered>;

  if (state.phase === "bad-link") {
    return (
      <Centered>
        This link is incomplete — ask the sender to copy it again.
      </Centered>
    );
  }

  if (state.phase === "gone") {
    return <Centered>This drop has expired. Drops disappear after 24 hours.</Centered>;
  }

  if (state.phase === "failed") return <Centered>{state.message}</Centered>;

  return <Ready id={id} state={state} />;
}

function Ready({
  id,
  state,
}: {
  id: string;
  state: Extract<State, { phase: "ready" }>;
}) {
  const [note, setNote] = useState<string | null>(null);
  const left = useCountdown(state.expiresAt);

  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote(null), 1800);
  };

  // navigator.share with files is the "Save to Photos" path on iOS and Android.
  const canShare =
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [state.file] });

  const share = async () => {
    try {
      await navigator.share({ files: [state.file], title: state.file.name });
    } catch (error) {
      // Dismissing the sheet rejects; that is not a failure worth reporting.
      if ((error as Error)?.name !== "AbortError") flash("Sharing didn't work — try Download.");
    }
  };

  const download = () => {
    const link = document.createElement("a");
    link.href = state.src;
    link.download = state.file.name;
    link.click();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [state.file.type]: state.file })]);
      flash("Copied");
    } catch {
      flash("This browser won't let a page copy images.");
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center gap-4 p-4">
      <img
        src={state.src}
        alt={state.file.name}
        className="max-h-[70dvh] w-auto max-w-full rounded-xl"
        style={{ boxShadow: "var(--shadow)" }}
      />

      <div className="text-center">
        <p className="text-body">{state.file.name}</p>
        <p className="text-caption text-text-2">{left ? `Expires in ${left}` : "Expired"}</p>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        {canShare && (
          <Button primary onClick={() => void share()}>
            Save to Photos
          </Button>
        )}
        <Button onClick={download}>Download</Button>
        {typeof ClipboardItem !== "undefined" && <Button onClick={() => void copy()}>Copy</Button>}
      </div>

      {note && <p className="text-caption text-text-2">{note}</p>}

      <Footer id={id} onReported={() => flash("Thanks — we'll take a look.")} />
    </main>
  );
}

function Footer({ id, onReported }: { id: string; onReported: () => void }) {
  const report = async () => {
    // The drop id is not secret; the key is, and it is not in this body.
    await fetch(`${API_BASE}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dropId: id }),
    }).catch(() => undefined);
    onReported();
  };

  return (
    <footer className="mt-auto pt-6 text-center text-caption text-text-2">
      <p>
        Sent with <b>Hopshot</b> — screenshots that clean up after themselves.{" "}
        <a href="/" className="underline" style={{ color: "var(--accent-text)" }}>
          For Mac &amp; Windows →
        </a>
      </p>
      <button type="button" onClick={() => void report()} className="mt-2 underline">
        Report
      </button>
    </footer>
  );
}

function Button({
  children,
  primary,
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-4 py-2 text-body"
      style={{
        background: primary ? "var(--accent)" : "var(--surface-2)",
        color: primary ? "var(--on-accent)" : "var(--text)",
      }}
    >
      {children}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center p-6 text-center">
      <p className="text-body text-text-2">{children}</p>
    </main>
  );
}

/** Live countdown, ticking each second so "Expires in 23h 12m" stays honest. */
function useCountdown(expiresAt: number): string | null {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return null;

  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) return `${hours}h ${minutes % 60}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.floor(remaining / 1000)}s`;
}

/** The `X-Hopshot-Meta` header, if the sender included one (ARCHITECTURE §6). */
async function readMeta(
  response: Response,
  key: Uint8Array,
  id: string,
): Promise<Meta | null> {
  const header = response.headers.get("X-Hopshot-Meta");
  if (!header) return null;

  try {
    const { openMeta } = await import("@hopshot/crypto");
    return await openMeta(key, id, header);
  } catch {
    // Unreadable metadata must not stop the image being shown.
    return null;
  }
}

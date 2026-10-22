import { useCallback, useEffect, useRef, useState } from "react";
import { startLive, type LiveStatus } from "../lib/live.ts";
import {
  deleteItem,
  deviceName,
  fetchImage,
  forget,
  isIos,
  isStandalone,
  listItems,
  loadCredentials,
  setDeviceName,
  uploadImage,
  type Credentials,
  type FeedItem,
} from "../lib/vault.ts";
import InstallPrompt from "./InstallPrompt.tsx";
import Scanner from "./Scanner.tsx";

/**
 * `/app` — the phone app (DESIGN S5, PRD F4.2/F4.4/F4.5).
 *
 * Feed of synced screenshots, an item view, and an upload button that sends a photo to the
 * computer. Everything is decrypted in the page: images exist only as `blob:` URLs, which
 * the service worker is forbidden to cache, so nothing plaintext is written to the device.
 */

type View = { name: "feed" } | { name: "item"; item: FeedItem };

export default function PhoneApp() {
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [view, setView] = useState<View>({ name: "feed" });
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [menuOpen, setMenuOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const picker = useRef<HTMLInputElement>(null);

  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 1800);
  }, []);

  /** Newest first, de-duplicated by id — live and polled items can overlap. */
  const merge = useCallback((incoming: FeedItem[]) => {
    setItems((current) => {
      const byId = new Map(current.map((item) => [item.summary.id, item]));
      for (const item of incoming) byId.set(item.summary.id, item);
      return [...byId.values()].sort((a, b) => b.summary.createdAt - a.summary.createdAt);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const found = await loadCredentials();
      if (cancelled) return;

      setCredentials(found);
      setReady(true);

      if (found) {
        try {
          const feed = await listItems(found);
          if (!cancelled) setItems(feed);
        } catch {
          // Offline on open is normal; the live layer retries and reports status.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Live sync (PRD F4.3).
  useEffect(() => {
    if (!credentials) return;

    const stop = startLive(credentials, {
      onItems: merge,
      onItemDeleted: (id) => {
        setItems((current) => current.filter((item) => item.summary.id !== id));
        setView((current) =>
          current.name === "item" && current.item.summary.id === id ? { name: "feed" } : current,
        );
      },
      onRevoked: () => {
        void forget();
        setCredentials(null);
        flash("This phone was unpaired.");
      },
      onStatus: setStatus,
    });

    return stop;
  }, [credentials, merge, flash]);

  const send = useCallback(
    async (file: File) => {
      if (!credentials) return;

      setUploading(true);
      try {
        await uploadImage(credentials, file);
        flash("Sent to your computer");
        // The socket echoes our own upload back, which is what adds it to the feed.
      } catch (error) {
        flash(error instanceof Error ? error.message : "That didn't send.");
      } finally {
        setUploading(false);
      }
    },
    [credentials, flash],
  );

  /**
   * An image shared from another Android app (PRD F4.6). The service worker stashed it and
   * redirected here with `?shared=1`.
   */
  useEffect(() => {
    if (!credentials) return;
    if (new URLSearchParams(window.location.search).get("shared") !== "1") return;

    void (async () => {
      // Clear the flag first, so a refresh does not try to re-upload.
      history.replaceState(null, "", "/app");
      try {
        const response = await fetch("/__shared-image");
        if (!response.ok) return;

        const name = decodeURIComponent(response.headers.get("X-Shared-Name") ?? "Shared image");
        const blob = await response.blob();
        await send(new File([blob], name, { type: blob.type }));
      } catch (error) {
        console.warn("could not take the shared image", error);
      }
    })();
    // `send` is memoised on [credentials, flash], so it only changes when `credentials`
    // does - the same trigger this effect already has. Re-running is harmless regardless:
    // the `?shared=1` flag is cleared before the upload starts.
  }, [credentials, send]);

  const remove = async (item: FeedItem) => {
    if (!credentials) return;
    try {
      await deleteItem(credentials, item.summary.id);
      setItems((current) => current.filter((i) => i.summary.id !== item.summary.id));
      setView({ name: "feed" });
      flash("Deleted");
    } catch {
      flash("That couldn't be deleted.");
    }
  };

  if (!ready) {
    return <p className="p-6 text-body text-text-2">Loading…</p>;
  }

  // Not paired. On iOS this is also the "Scan to finish" step after installing (F4.8).
  if (!credentials) {
    return (
      <>
        <NotPaired onScan={() => setScanning(true)} />
        {scanning && (
          <Scanner
            onClose={() => setScanning(false)}
            onPaired={async () => {
              setScanning(false);
              const found = await loadCredentials();
              setCredentials(found);
              if (found) setItems(await listItems(found).catch(() => []));
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        status={status}
        onMenu={() => setMenuOpen((open) => !open)}
        title={view.name === "item" ? view.item.meta.name : "Hopshot"}
        onBack={view.name === "item" ? () => setView({ name: "feed" }) : undefined}
      />

      {menuOpen && (
        <Menu
          onClose={() => setMenuOpen(false)}
          onRename={async () => {
            const current = await deviceName();
            const next = window.prompt("Name this phone", current);
            if (next?.trim()) {
              await setDeviceName(next.trim());
              flash("Renamed");
            }
            setMenuOpen(false);
          }}
          onUnpair={async () => {
            if (!window.confirm("Unpair this phone? Your screenshots stay on your computer.")) {
              return;
            }
            await forget();
            setCredentials(null);
            setMenuOpen(false);
          }}
        />
      )}

      {/* PRD F4.2: offer the install rather than expecting the user to find Chrome's menu.
          Renders nothing when already installed or previously dismissed. */}
      {view.name === "feed" && <InstallPrompt />}

      {view.name === "feed" ? (
        <Feed items={items} onOpen={(item) => setView({ name: "item", item })} />
      ) : (
        <ItemView
          credentials={credentials}
          item={view.item}
          onDelete={() => void remove(view.item)}
          onToast={flash}
        />
      )}

      {view.name === "feed" && (
        <>
          {/* PRD F4.5 — the photo picker. `capture` is deliberately unset so the user can
              choose an existing screenshot as well as take a new photo. */}
          <input
            ref={picker}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void send(file);
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={uploading}
            onClick={() => picker.current?.click()}
            style={{
              position: "fixed",
              // Clear of the iPhone home indicator.
              bottom: "calc(16px + env(safe-area-inset-bottom))",
              left: "50%",
              transform: "translateX(-50%)",
              height: 44,
              borderRadius: "var(--radius-chip)",
              boxShadow: "var(--shadow-raised)",
              zIndex: 20,
            }}
          >
            {uploading ? "Sending…" : "+ Send to computer"}
          </button>
        </>
      )}

      {toast && (
        <div
          role="status"
          className="toast-in"
          style={{
            position: "fixed",
            top: "calc(12px + env(safe-area-inset-top))",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--surface-raised)",
            boxShadow: "var(--shadow-raised)",
            borderRadius: "var(--radius-chip)",
            padding: "7px 14px",
            fontSize: 13,
            zIndex: 30,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/** DESIGN S5 top bar: title, a sync dot, and the menu. */
function TopBar({
  status,
  title,
  onMenu,
  onBack,
}: {
  status: LiveStatus;
  title: string;
  onMenu: () => void;
  onBack?: () => void;
}) {
  const colour =
    status === "live"
      ? "var(--success)"
      : status === "offline"
        ? "var(--danger)"
        : "var(--warning)";

  return (
    <header
      className="sticky top-0 z-10 flex items-center gap-2 px-3"
      style={{
        // One height, including the notch inset — the bar has to cover the status area or
        // the feed scrolls under translucent iOS chrome.
        height: "calc(52px + env(safe-area-inset-top))",
        paddingTop: "env(safe-area-inset-top)",
        background: "var(--surface-solid)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {onBack ? (
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
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
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      ) : (
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: colour,
            marginLeft: 4,
          }}
        />
      )}

      <b className="min-w-0 flex-1 truncate text-title">{title}</b>

      <span className="sr-only" role="status">
        {status === "live" ? "Syncing live" : status === "offline" ? "Offline" : "Reconnecting"}
      </span>

      <button type="button" className="icon-btn" aria-label="Menu" onClick={onMenu}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    </header>
  );
}

function Menu({
  onClose,
  onRename,
  onUnpair,
}: {
  onClose: () => void;
  onRename: () => void;
  onUnpair: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-20"
        onClick={onClose}
        aria-hidden
        style={{ background: "rgba(0,0,0,.3)" }}
      />
      <div
        role="menu"
        className="raised fixed z-30 flex flex-col p-1"
        style={{ right: 10, top: "calc(56px + env(safe-area-inset-top))", minWidth: 200 }}
      >
        <button type="button" className="menu-row" onClick={onRename}>
          Device name
        </button>
        <a className="menu-row" href="/faq">
          Help
        </a>
        <hr style={{ borderColor: "var(--raised-border)", margin: "4px 0" }} />
        <button type="button" className="menu-row menu-row-danger" onClick={onUnpair}>
          Unpair this phone
        </button>
      </div>
    </>
  );
}

/** DESIGN S5: a 2-column grid of 16:10 cards, newest first. */
function Feed({ items, onOpen }: { items: FeedItem[]; onOpen: (item: FeedItem) => void }) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <b className="text-title">Nothing here yet</b>
        <p className="text-body text-text-2">
          Take a screenshot on your computer — it shows up here.
        </p>
      </div>
    );
  }

  return (
    <ul
      className="grid flex-1 grid-cols-2 gap-2 p-2"
      style={{ paddingBottom: "calc(76px + env(safe-area-inset-bottom))" }}
    >
      {items.map((item) => (
        <li key={item.summary.id}>
          <button
            type="button"
            className="relative block w-full overflow-hidden"
            style={{
              aspectRatio: "16 / 10",
              borderRadius: "var(--radius-card)",
              background: "var(--card-letterbox)",
              boxShadow: "0 0 0 1px var(--border)",
            }}
            onClick={() => onOpen(item)}
          >
            <Thumb item={item} />
            <span
              className="absolute text-caption"
              style={{
                top: 6,
                right: 6,
                background: "var(--scrim)",
                color: "var(--on-scrim)",
                borderRadius: "var(--radius-chip)",
                padding: "1px 6px",
              }}
            >
              {timeLeft(item.summary.expiresAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A card's image.
 *
 * Decrypted on demand and held as a `blob:` URL, revoked when the card unmounts — an
 * un-revoked object URL keeps the plaintext alive in memory for the life of the document.
 */
function Thumb({ item }: { item: FeedItem }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;

    void (async () => {
      const credentials = await loadCredentials();
      if (!credentials || revoked) return;

      try {
        const blob = await fetchImage(credentials, item);
        if (revoked) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      } catch {
        // A thumbnail that will not load is not worth an error state on a grid card.
      }
    })();

    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [item]);

  if (!url) return <span className="absolute inset-0 animate-pulse" />;

  return (
    <img
      src={url}
      alt=""
      className="absolute inset-0 size-full"
      style={{ objectFit: "contain" }}
    />
  );
}

/** DESIGN S5 item view: full-bleed image, actions along the bottom. */
function ItemView({
  credentials,
  item,
  onDelete,
  onToast,
}: {
  credentials: Credentials;
  item: FeedItem;
  onDelete: () => void;
  onToast: (text: string) => void;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;

    void (async () => {
      try {
        const got = await fetchImage(credentials, item);
        if (revoked) return;
        created = URL.createObjectURL(got);
        setBlob(got);
        setUrl(created);
      } catch {
        onToast("That one couldn't be opened.");
      }
    })();

    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [credentials, item, onToast]);

  const file = () => new File([blob!], item.meta.name, { type: item.meta.mime });

  const share = async () => {
    if (!blob) return;
    // `canShare` with files has to be checked: iOS Safari has `share` but refuses files in
    // some versions, and an unguarded call throws rather than degrading.
    if (navigator.canShare?.({ files: [file()] })) {
      try {
        await navigator.share({ files: [file()] });
      } catch {
        // A cancelled share sheet is not a failure.
      }
      return;
    }
    onToast("Sharing isn't available here.");
  };

  const save = () => {
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = item.meta.name;
    link.click();
  };

  const copy = async () => {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      onToast("Copied");
    } catch {
      onToast("Copying isn't available here.");
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 items-center justify-center" style={{ background: "#000" }}>
        {url ? (
          <img src={url} alt={item.meta.name} style={{ maxWidth: "100%", maxHeight: "100%" }} />
        ) : (
          <p className="text-body text-text-2">Decrypting…</p>
        )}
      </div>

      <div
        className="flex items-center justify-around gap-1 px-2"
        style={{
          paddingTop: 8,
          paddingBottom: "calc(8px + env(safe-area-inset-bottom))",
          background: "var(--surface-solid)",
          borderTop: "1px solid var(--border)",
        }}
      >
        <Action label="Share" onClick={() => void share()} disabled={!blob} />
        <Action label="Save" onClick={save} disabled={!url} />
        <Action label="Copy" onClick={() => void copy()} disabled={!blob} />
        <Action label="Delete" danger onClick={onDelete} />
      </div>
    </div>
  );
}

function Action({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn ${danger ? "btn-danger-ghost" : "btn-ghost"}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * PRD F4.8 — the screen an installed-but-unpaired iOS app lands on.
 *
 * This is the "Scan to finish" step the /pair instructions point at: the user installed from
 * Safari, so this storage is empty even though Safari's was not.
 */
function NotPaired({ onScan }: { onScan: () => void }) {
  const installedOnIos = isIos() && isStandalone();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6">
      <h1 className="text-heading">
        {installedOnIos ? "Almost there" : "This phone isn't paired yet"}
      </h1>
      <p className="text-body text-text-2">
        {installedOnIos
          ? "Scan the code on your computer once more to finish. Apps added to the Home Screen start with their own private storage, so the pairing from Safari didn't carry over."
          : "On your computer, open Hopshot → Settings → Devices → Pair a phone, then scan the code."}
      </p>
      <button type="button" className="btn btn-primary self-start" onClick={onScan}>
        Scan to finish
      </button>
    </main>
  );
}

/** "23h" / "45m" — the chip is coarse on purpose (DESIGN §1.4: calm about time). */
function timeLeft(expiresAt: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

import type { LiveEvent } from "shared";
import { listItems, liveTicket, liveUrl, type Credentials, type FeedItem } from "./vault.ts";

/**
 * The phone's live vault connection (ARCHITECTURE §7.4, PRD F4.3).
 *
 * Mint a ticket, open a socket, read events; on any failure back off and retry, and fall
 * back to polling `GET /items?since=` every 15 s. Same contract as the Rust client in
 * `apps/desktop/src-tauri/src/cloud/live.rs`.
 *
 * The phone has one problem the desktop does not: **a backgrounded tab loses its socket
 * silently.** iOS suspends timers and connections the moment the app leaves the foreground
 * or the screen locks, and the close event often never fires — so the socket looks open
 * while nothing arrives. Reconnecting on `visibilitychange` is what makes the feed correct
 * after a phone comes out of a pocket, and it is why the polling timer is not enough on its
 * own.
 *
 * Nothing here decrypts: events carry ids and sealed metadata, and `vault.ts` owns the key.
 */

/** ARCHITECTURE §7.4: "fall back to polling every 15 s if the socket drops". */
const POLL_MS = 15_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export type LiveHandlers = {
  /** New or caught-up items, oldest-first so the feed can prepend in order. */
  onItems: (items: FeedItem[]) => void;
  onItemDeleted: (id: string) => void;
  /** A device joined or was revoked — the devices list is stale. */
  onDevicesChanged?: () => void;
  /** This phone was unpaired. Terminal: there is nothing to reconnect to. */
  onRevoked: () => void;
  /** Connection state, for the sync dot in the top bar (DESIGN S5). */
  onStatus?: (status: LiveStatus) => void;
};

export type LiveStatus = "connecting" | "live" | "polling" | "offline";

/**
 * Start syncing. Returns a stop function; call it on unmount.
 *
 * Deliberately not a class: there is exactly one of these per page, and a closure keeps the
 * reconnect state unreachable from outside.
 */
export function startLive(credentials: Credentials, handlers: LiveHandlers): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let backoff = BACKOFF_START_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** High-water mark, so a reconnect only asks for what it missed. */
  let since = 0;

  const status = (next: LiveStatus) => handlers.onStatus?.(next);

  /** Fetch anything newer than `since` and hand it over, oldest-first. */
  const catchUp = async () => {
    if (stopped) return;

    try {
      const items = await listItems(credentials, since);
      if (stopped || items.length === 0) return;

      for (const item of items) since = Math.max(since, item.summary.createdAt);
      // The API returns newest-first; the feed wants to prepend in order.
      handlers.onItems([...items].reverse());
    } catch (error) {
      if ((error as { code?: string }).code === "unauthorized") {
        stop();
        handlers.onRevoked();
        return;
      }
      status("offline");
    }
  };

  const clearTimers = () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (pollTimer !== null) clearInterval(pollTimer);
    reconnectTimer = null;
    pollTimer = null;
  };

  /** Polling is the floor: it runs whenever the socket is not known to be healthy. */
  const startPolling = () => {
    if (pollTimer !== null || stopped) return;
    pollTimer = setInterval(() => void catchUp(), POLL_MS);
  };

  const stopPolling = () => {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;

    // Polling covers the gap while we wait, so a long backoff is never a long silence.
    startPolling();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff);

    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  const connect = async () => {
    if (stopped || socket !== null) return;
    status("connecting");

    // Reconcile first: whatever arrived while we were disconnected comes over HTTP.
    await catchUp();
    if (stopped) return;

    let ticket: string;
    try {
      ticket = await liveTicket(credentials);
    } catch (error) {
      if ((error as { code?: string }).code === "unauthorized") {
        stop();
        handlers.onRevoked();
        return;
      }
      status("polling");
      scheduleReconnect();
      return;
    }

    let next: WebSocket;
    try {
      next = new WebSocket(liveUrl(credentials, ticket));
    } catch {
      status("polling");
      scheduleReconnect();
      return;
    }
    socket = next;

    next.onopen = () => {
      if (stopped) {
        next.close();
        return;
      }
      // A socket that opened is the healthy path; the poll timer is redundant until it drops.
      backoff = BACKOFF_START_MS;
      stopPolling();
      status("live");
    };

    next.onmessage = (event) => {
      let parsed: LiveEvent;
      try {
        parsed = JSON.parse(String(event.data)) as LiveEvent;
      } catch {
        // Version skew is not a reason to drop the connection: the next event may be one
        // we understand.
        console.warn("unrecognised live event");
        return;
      }
      handle(parsed);
    };

    next.onclose = (event) => {
      socket = null;
      if (stopped) return;

      // 1008 is VaultHub::kick — this device was revoked (PRD F4.7). Terminal.
      if (event.code === 1008) {
        stop();
        handlers.onRevoked();
        return;
      }

      status("polling");
      scheduleReconnect();
    };

    next.onerror = () => {
      // `onclose` always follows, so the reconnect is scheduled there rather than twice.
      status("polling");
    };
  };

  const handle = (event: LiveEvent) => {
    switch (event.type) {
      case "item.created":
        /*
         * The summary is on the wire, but the metadata still has to be unsealed and that is
         * async. Going through `catchUp` reuses one code path for live and polled items, and
         * it is cheap: `since` means the request returns just this item.
         */
        void catchUp();
        break;
      case "item.deleted":
        handlers.onItemDeleted(event.id);
        break;
      case "device.joined":
      case "device.revoked":
        handlers.onDevicesChanged?.();
        break;
    }
  };

  /**
   * Mobile lifecycle. A suspended socket usually does not report its own death, so coming
   * back to the foreground forces a fresh connection rather than trusting the old one.
   */
  const onVisible = () => {
    if (stopped || document.visibilityState !== "visible") return;

    backoff = BACKOFF_START_MS;
    if (socket !== null) {
      // Cannot be trusted after a suspend; closing triggers the normal reconnect path.
      socket.close();
      socket = null;
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    void connect();
  };

  const onOnline = () => {
    if (stopped) return;
    backoff = BACKOFF_START_MS;
    void catchUp();
  };

  const onOffline = () => status("offline");

  function stop() {
    if (stopped) return;
    stopped = true;

    clearTimers();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);

    if (socket !== null) {
      // Null the handlers first: closing would otherwise fire onclose and schedule a
      // reconnect for a connection we are deliberately tearing down.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      socket = null;
    }
  }

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  void connect();

  return stop;
}

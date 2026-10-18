import { DurableObject } from "cloudflare:workers";
import type { LiveEvent } from "shared";

/**
 * One instance per vault: the WebSocket fan-out for live item and device events
 * (ARCHITECTURE §7.4).
 *
 * Uses the **hibernation API** (`acceptWebSocket`, not `server.accept()`). A paired phone
 * holds its socket open for hours while nothing happens; with hibernation the DO is evicted
 * from memory between events and the sockets survive, so an idle vault costs nothing. The
 * handlers are `webSocketMessage`/`webSocketClose` rather than `addEventListener`, because
 * after hibernation there is no closure left to have captured anything.
 *
 * Nothing here can read item contents: the Worker forwards already-public metadata, and the
 * blobs are HOP1 ciphertext the server has no key for (CLAUDE.md privacy invariant).
 */

/** Keepalive. Answered by the runtime without waking the DO. */
const PING = "ping";
const PONG = "pong";

export class VaultHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Handled in the runtime, so a heartbeat never bills a wake-up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/connect":
        return this.openSocket(url);
      case "/broadcast":
        return this.broadcast(request);
      case "/kick":
        return this.kick(url);
      default:
        return new Response("not found", { status: 404 });
    }
  }

  /**
   * Upgrade a connection. The Worker has already validated the single-use ticket, so by the
   * time we get here the caller is known to be a live device in this vault.
   */
  private openSocket(url: URL): Response {
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) return new Response("deviceId is required", { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();

    // Tagged with the device id so `kick` can find this socket after a revoke, and so the
    // tag survives hibernation — instance fields do not.
    this.ctx.acceptWebSocket(server, [deviceId]);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Fan an event out to every live socket. */
  private async broadcast(request: Request): Promise<Response> {
    const event = (await request.json()) as LiveEvent;
    const payload = JSON.stringify(event);

    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
        delivered++;
      } catch {
        // A socket that died between `getWebSockets()` and `send` is not an error worth
        // failing the originating request over — the client will refetch on reconnect.
      }
    }

    return Response.json({ delivered });
  }

  /**
   * Close a revoked device's sockets (PRD F4.7: "a revoked device loses access right away").
   *
   * Without this, a revoked phone would keep receiving events on its existing socket until
   * it happened to reconnect, because token checks only run on HTTP requests.
   */
  private kick(url: URL): Response {
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) return new Response("deviceId is required", { status: 400 });

    let closed = 0;
    for (const socket of this.ctx.getWebSockets(deviceId)) {
      // 1008 "policy violation" — the client treats this as "do not reconnect", unlike the
      // 1006/1011 it retries after.
      socket.close(1008, "revoked");
      closed++;
    }

    return Response.json({ closed });
  }

  /**
   * Clients have nothing to tell us: items are created over HTTP so they are durable and
   * rate-limited. The socket is one-way, and the only inbound message we expect is the
   * keepalive, which the runtime already answered.
   */
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message === PING) return;
    socket.close(1003, "unsupported");
  }

  override webSocketClose(
    _socket: WebSocket,
    code: number,
    _reason: string,
    wasClean: boolean,
  ): void {
    // Hibernation means we are not holding this socket anywhere; nothing to clean up. Logged
    // only when it closed badly, so normal churn stays quiet.
    if (!wasClean) console.log("live socket closed uncleanly", { code });
  }

  override webSocketError(_socket: WebSocket, error: unknown): void {
    console.warn("live socket error", error);
  }
}

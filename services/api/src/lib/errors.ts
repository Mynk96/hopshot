import type { Context } from "hono";

/**
 * The error shape from ARCHITECTURE §7:
 * `{ "error": { "code": "limit_reached", "message": "…" } }`.
 *
 * Messages are user-visible — the desktop app and the viewer show them directly — so they
 * follow the DESIGN §5 voice: short, plain, second person, no exclamation marks.
 */

export type ErrorCode =
  | "bad_request"
  | "not_found"
  | "gone"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "too_large"
  | "limit_reached"
  | "server_error";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  too_large: 413,
  limit_reached: 429,
  server_error: 500,
};

export function fail(c: Context, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, STATUS[code] as 400);
}

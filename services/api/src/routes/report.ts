import { Hono } from "hono";

import { fail } from "../lib/errors.ts";
import { isValidId } from "../lib/ids.ts";

/**
 * `POST /report` `{dropId, reason}` — abuse reports (ARCHITECTURE §7.6).
 *
 * Stores the report. Emailing the owner needs the email binding, which arrives with the
 * rest of the mail in Phase 4; until then the row is the record.
 *
 * Deliberately unauthenticated: anyone who can open a link must be able to report it. The
 * reason is truncated and never echoed back, so the endpoint cannot be used as storage.
 */
export const report = new Hono<{ Bindings: Env }>();

const MAX_REASON_CHARS = 500;

report.post("/", async (c) => {
  const body = await c.req.json<{ dropId?: unknown; reason?: unknown }>().catch(() => null);
  if (!body) return fail(c, "bad_request", "That report wasn't readable.");

  const dropId = typeof body.dropId === "string" ? body.dropId : "";
  if (!isValidId(dropId)) return fail(c, "bad_request", "That drop id isn't valid.");

  const reason =
    typeof body.reason === "string" ? body.reason.slice(0, MAX_REASON_CHARS) : null;

  await c.env.DB.prepare(
    "INSERT INTO reports (drop_id, reason, created_at) VALUES (?1, ?2, ?3)",
  )
    .bind(dropId, reason, Date.now())
    .run();

  // No detail in the response: whether the drop exists is not something a reporter needs,
  // and answering would turn this into an id oracle.
  return c.json({ ok: true }, 202);
});

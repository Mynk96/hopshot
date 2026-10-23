import { Hono } from "hono";

/**
 * `POST /trial/start` — kept only to retire the trial safely (PRD F8.1).
 *
 * Hopshot is pay-first: there is no trial, and nothing here touches the database.
 *
 * The route still exists because builds up to v0.1.0 call it at launch and cache the
 * `endsAt` they get back. Answering with a trial that has **already ended** makes those
 * builds pause capture and show their plans screen, which is the correct behaviour now.
 * Removing the route instead would 404, and a 404 leaves that cache empty — which older
 * builds read as "never reached the server", their most permissive state. A dead trial is
 * the safe answer; silence is not.
 *
 * Delete this once no v0.1.x install is still in use.
 */
export const trial = new Hono<{ Bindings: Env }>();

trial.post("/start", (c) => {
  const now = Date.now();

  return c.json({
    startedAt: now,
    // Equal to `startedAt`, so any client computing `endsAt - now` gets zero or less.
    endsAt: now,
    days: 0,
    active: false,
  });
});

import { Hono } from "hono";

/**
 * webhooks routes — see ARCHITECTURE §7. Implemented from Phase 3.2 onwards.
 * `Env` is the ambient binding type generated into worker-configuration.d.ts
 * by `pnpm -F api cf-typegen`.
 */
export const webhooks = new Hono<{ Bindings: Env }>();

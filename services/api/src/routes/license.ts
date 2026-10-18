import { Hono } from "hono";

/**
 * license routes — see ARCHITECTURE §7. Implemented from Phase 3.2 onwards.
 * `Env` is the ambient binding type generated into worker-configuration.d.ts
 * by `pnpm -F api cf-typegen`.
 */
export const license = new Hono<{ Bindings: Env }>();

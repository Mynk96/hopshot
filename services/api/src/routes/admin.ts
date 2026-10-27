import { Hono } from "hono";

/**
 * admin routes — see ARCHITECTURE §7.
 * `Env` is the ambient binding type generated into worker-configuration.d.ts
 * by `pnpm -F api cf-typegen`.
 *
 * Empty since the Sync renewal was removed (PRD §7: bought once, Sync forever) — the only
 * route here existed to run that job by hand.
 *
 * The ADMIN_TOKEN gate is kept rather than deleted. It is the pattern any future admin route
 * must use: fail closed, 404 rather than 401 so an unauthenticated prober learns nothing, and
 * no surface at all while the secret is unset.
 */
export const admin = new Hono<{ Bindings: Env }>();

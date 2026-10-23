import { Hono } from "hono";

import { sweep } from "./lib/cleanup.ts";
import { sendRenewalNotices } from "./lib/renewals.ts";
import { apiCors } from "./lib/cors.ts";

import { admin } from "./routes/admin.ts";
import { billing } from "./routes/billing.ts";
import { drops } from "./routes/drops.ts";
import { items } from "./routes/items.ts";
import { license } from "./routes/license.ts";
import { live } from "./routes/live.ts";
import { pair } from "./routes/pair.ts";
import { report } from "./routes/report.ts";
import { trial } from "./routes/trial.ts";
import { vaults } from "./routes/vaults.ts";
import { webhooks } from "./routes/webhooks.ts";

export { VaultHub } from "./do/VaultHub.ts";

// `Env` is ambient, generated from wrangler.toml into worker-configuration.d.ts by
// `pnpm -F api cf-typegen`. Re-run it whenever a binding changes.

const app = new Hono<{ Bindings: Env }>();

// ARCHITECTURE §7.6
app.get("/health", (c) => c.json({ ok: true }));

const v1 = new Hono<{ Bindings: Env }>();

// The viewer and the PWA are on a different origin (ARCHITECTURE §8), so every v1 route is
// reached cross-origin.
v1.use("*", apiCors);

v1.route("/drops", drops);

/*
 * Three routers share the `/vaults` prefix because ARCHITECTURE §7.3/§7.4 nest items and
 * live under a vault — `/vaults/{vaultId}/items/{itemId}`, `/vaults/{vaultId}/live`. Keeping
 * them in separate files matches §3's layout while the paths stay as the spec writes them.
 */
v1.route("/vaults", vaults);
v1.route("/vaults", items);
v1.route("/vaults", live);

v1.route("/pair", pair);
v1.route("/trial", trial);
v1.route("/license", license);
v1.route("/webhooks", webhooks);
v1.route("/billing", billing);
v1.route("/admin", admin);
v1.route("/report", report);

app.route("/v1", v1);
app.get("/v1/health", (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,

  /**
   * Cron triggers from wrangler.toml.
   *   every 15 min — delete expired drops/items plus their R2 objects (ARCHITECTURE §7.8)
   *   daily 09:00  — Sync renewal reminder emails (ARCHITECTURE §7.5), Phase 4
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    switch (event.cron) {
      case "*/15 * * * *":
        ctx.waitUntil(
          sweep(env)
            .then((swept) => {
              // Quiet runs are the normal case; only say something when work happened.
              if (Object.values(swept).some((n) => n > 0)) {
                console.log("retention sweep", swept);
              }
            })
            // Caught, not left to reject: an unhandled rejection inside waitUntil is reported
            // as a bare worker exception with no hint of which cron it came from, which is
            // exactly the information needed when a nightly job starts failing.
            .catch((error) => console.error("retention sweep failed", error)),
        );
        break;
      case "0 9 * * *":
        // PRD F8.8: ask whether to continue Sync. Nothing renews itself.
        ctx.waitUntil(
          sendRenewalNotices(env)
            .then((sent) => {
              if (sent > 0) console.log(`sent ${sent} Sync renewal notice(s)`);
            })
            .catch((error) => console.error("renewal notices failed", error)),
        );
        break;
      default:
        console.warn("unhandled cron trigger", event.cron);
        break;
    }
  },
} satisfies ExportedHandler<Env>;

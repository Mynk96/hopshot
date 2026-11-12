import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs tests inside workerd with the real R2/D1/Durable Object bindings from wrangler.toml
// (ARCHITECTURE §10).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Licensing needs these to exist. Fake values: no test reaches Stripe, and the webhook
      // tests sign with this exact secret so the real verifier is exercised end to end.
      miniflare: {
        bindings: {
          STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
          STRIPE_SECRET_KEY: "sk_test_not_used",
          STRIPE_PRICE_BUNDLE: "price_bundle_test",
          WEB_ORIGIN: "https://hopshot.xyz",
          ADMIN_TOKEN: "admin_test_token",
        },
      },
    }),
  ],
});

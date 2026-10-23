// @ts-check
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

/**
 * ARCHITECTURE §8: static marketing + legal pages, React islands for /d/[id], /pair and
 * /app.
 *
 * `output: "static"` with the Cloudflare adapter keeps every marketing page prerendered —
 * they are the SEO surface — while letting individual routes opt out with
 * `export const prerender = false`. `/d/[id]` has to: a drop id is a 128-bit random value,
 * so it cannot be in a build-time path list, and without this every real link 404s.
 */
export default defineConfig({
  site: "https://hopshot.xyz",
  output: "static",
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },

  security: {
    /**
     * ARCHITECTURE §8's CSP.
     *
     * Astro's own option rather than a hand-written meta tag: it hashes the inline
     * hydration script it emits for each island, which a static `script-src 'self'`
     * would block — taking /pair, /app and the drop viewer down with it.
     *
     * `connect-src` has to name the API explicitly, including the `wss:` origin: a
     * WebSocket is not covered by `default-src 'self'`, so the live feed would fail
     * silently without it (PRD F4.3).
     *
     * `img-src` allows `blob:` because that is what a *decrypted* image is — created in
     * the page and never written anywhere. `data:` covers the inline QR SVG.
     */
    csp: {
      directives: [
        "default-src 'self'",
        "connect-src 'self' https://api.hopshot.xyz wss://api.hopshot.xyz",
        "img-src 'self' blob: data:",
        // The app shell has no reason to embed anything or be embedded.
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        // Nothing here posts a form anywhere; the Android share target is a manifest
        // entry handled by the service worker, not an HTML form.
        "form-action 'none'",
        "worker-src 'self'",
        "manifest-src 'self'",
      ],
    },
  },
});

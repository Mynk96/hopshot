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
});

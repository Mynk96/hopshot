import { cors } from "hono/cors";

/**
 * CORS for the browser clients (ARCHITECTURE §8).
 *
 * The viewer and the PWA are served from a different origin than the API — hopshot.xyz vs
 * api.hopshot.xyz — so every call they make is cross-origin. Without this the browser
 * blocks the request before it is sent and the viewer shows a decrypt failure that has
 * nothing to do with decryption.
 *
 * `X-Hopshot-Meta` has to be *exposed*, not just allowed: a cross-origin response hides
 * every header outside the CORS-safelisted set, so the viewer would receive the metadata
 * envelope and be unable to read it.
 */

/** Origins allowed to call the API. */
const ALLOWED = [
  "https://hopshot.xyz",
  "https://www.hopshot.xyz",
  // The drop viewer and PWA (ARCHITECTURE §8).
  "https://app.hopshot.xyz",
  // Astro dev server, for working against a deployed API locally.
  "http://localhost:4321",
];

/**
 * Staging deployments.
 *
 * Both halves must name something only this account can create. `*.workers.dev` is
 * namespaced by the account subdomain, but `*.pages.dev` is NOT — a bare `[a-z0-9-]+
 * \.pages\.dev` would admit any Pages site anyone deploys, turning every visitor to an
 * attacker's page into an upload proxy against this quota, with the visitor's IP recorded
 * in `drops.ip_hash`. So the Pages host is pinned to this project, including its
 * `<branch>.` preview prefix.
 */
const STAGING =
  /^https:\/\/(?:[a-z0-9-]+\.mayank-harsani\.workers\.dev|(?:[a-z0-9-]+\.)?hopshot-web\.pages\.dev)$/;

export const apiCors = cors({
  origin: (origin) => {
    if (!origin) return undefined;
    if (ALLOWED.includes(origin)) return origin;
    return STAGING.test(origin) ? origin : undefined;
  },
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "X-Hopshot-Install",
    "X-Hopshot-License",
    "X-Hopshot-Meta",
  ],
  // Without this the viewer cannot read the metadata envelope off the response.
  exposeHeaders: ["X-Hopshot-Meta", "Content-Length"],
  maxAge: 86_400,
});

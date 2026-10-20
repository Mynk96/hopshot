/*
 * Hopshot service worker (ARCHITECTURE §8).
 *
 * Two jobs only:
 *
 *   1. Cache the app shell, so /app opens from the Home Screen without a network round trip.
 *   2. Receive Android's share target (PRD F4.6), which has to be a POST handled here —
 *      a manifest share_target POST never reaches a page.
 *
 * **What it must never cache**, because both would outlive the expiry the product promises
 * and leave plaintext on the device:
 *   - anything under the API origin (ciphertext, metadata, tokens)
 *   - decrypted images, which only ever exist as blob: URLs in the page
 *
 * Hand-written rather than generated. The deny-list above is the whole point of this file,
 * and a Workbox config that happened to cache the wrong route would break a privacy
 * invariant silently (CLAUDE.md invariant 1).
 */

// Bump to invalidate the shell. The old cache is deleted on activate.
const SHELL_CACHE = "hopshot-shell-v1";
/** Where a shared image waits between the SW and the page. */
const SHARE_CACHE = "hopshot-share";
/** Synthetic URL the page reads the shared file back from. */
const SHARE_KEY = "/__shared-image";

/**
 * Only the shell. `/app` itself is deliberately *not* precached as a navigation response:
 * it is served network-first below so a deploy is picked up, with the cache as the offline
 * fallback.
 */
const SHELL = ["/app", "/icons/icon-128.png", "/icons/icon-256.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, so one missing file cannot fail the whole install.
      await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("hopshot-shell-") && name !== SHELL_CACHE) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

/** Is this a request we are forbidden to cache? */
function isPrivate(url, request) {
  // The API: ciphertext, sealed metadata and bearer tokens.
  if (url.pathname.startsWith("/v1/")) return true;
  if (url.hostname.startsWith("api.")) return true;
  // Decrypted images live here; they must never reach disk.
  if (url.protocol === "blob:" || url.protocol === "data:") return true;
  // Anything carrying a credential.
  if (request.headers.has("Authorization")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Android share target (PRD F4.6).
  if (request.method === "POST" && url.pathname === "/app/share-target") {
    event.respondWith(receiveShare(request));
    return;
  }

  // The page collecting what the share target stashed.
  if (request.method === "GET" && url.pathname === SHARE_KEY) {
    event.respondWith(takeShare());
    return;
  }

  // Everything else: only GETs on our own origin are cacheable at all.
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (isPrivate(url, request)) return;

  // Navigations: network-first so a deploy is seen, cache as the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  // Build output is content-hashed, so cache-first is safe and is what makes a cold
  // Home-Screen launch instant.
  if (url.pathname.startsWith("/_astro/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    // Falling back to /app covers a deep link opened offline.
    return cached ?? (await cache.match("/app")) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

/**
 * Android handed us an image. Stash it and redirect into the app.
 *
 * A POST response cannot carry a File to a page, so the bytes go into a Cache under a
 * synthetic URL and `/app` picks them up. The Cache API stores Blobs natively, which keeps
 * this to a few lines instead of hand-rolled IndexedDB.
 */
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const file = form.get("image");

    if (file && typeof file !== "string") {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(
        SHARE_KEY,
        new Response(file, {
          headers: {
            "Content-Type": file.type || "image/png",
            // Carried across so the upload can name the item sensibly.
            "X-Shared-Name": encodeURIComponent(file.name || "Shared image"),
          },
        }),
      );
      return Response.redirect("/app?shared=1", 303);
    }
  } catch (error) {
    // Falling through to the app is friendlier than an error page from a share sheet.
    console.warn("share target failed", error);
  }
  return Response.redirect("/app", 303);
}

/** Hand the stashed file to the page and remove it — one consumer only. */
async function takeShare() {
  const cache = await caches.open(SHARE_CACHE);
  const response = await cache.match(SHARE_KEY);
  if (!response) return new Response(null, { status: 404 });

  await cache.delete(SHARE_KEY);
  return response;
}

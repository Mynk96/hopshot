/**
 * Register the service worker (ARCHITECTURE §8).
 *
 * A module rather than an inline `<script>`: Astro's `security.csp` hashes the inline
 * scripts *it* emits for islands, but not one written by hand, so an inline version is
 * blocked by `script-src`. The worker then never registers — and because Chrome requires a
 * service worker with a fetch handler before it will offer "Install app", that silently made
 * the PWA uninstallable, which is the one thing this file exists to enable.
 *
 * Bundled by Astro and loaded with a `src`, so plain `script-src 'self'` covers it.
 */

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;

  // After load, so registering never competes with the first paint.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      // An app that cannot cache its shell still works online, so this is not fatal — but
      // it does mean no install prompt, which is worth saying out loud.
      console.warn("the service worker did not register; the app will not be installable", error);
    });
  });
}

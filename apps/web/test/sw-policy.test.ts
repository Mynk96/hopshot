import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The service worker's cache policy (ARCHITECTURE §8: "never cache API responses or
 * decrypted images").
 *
 * This is the one file where a wrong line breaks a privacy invariant *silently* — a cached
 * ciphertext or blob would outlive the expiry the product promises, with nothing visibly
 * wrong. The worker runs in a scope Vitest cannot instantiate, so `isPrivate` is extracted
 * from the source and exercised directly: that still catches the realistic regression, which
 * is somebody widening the predicate.
 */

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

/** Pull `isPrivate` out of the worker source and make it callable here. */
function loadIsPrivate(): (url: URL, request: { headers: Headers }) => boolean {
  const start = source.indexOf("function isPrivate(");
  expect(start, "isPrivate must exist in sw.js").toBeGreaterThan(-1);

  // Balance braces from the function's opening brace to its close.
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  const body = source.slice(start, end);
  return new Function(`${body}; return isPrivate;`)() as ReturnType<typeof loadIsPrivate>;
}

const isPrivate = loadIsPrivate();
const plain = { headers: new Headers() };

describe("the service worker refuses to cache anything private", () => {
  it("never caches the API", () => {
    // Ciphertext, sealed metadata and bearer tokens all live here.
    expect(isPrivate(new URL("https://api.hopshot.xyz/v1/drops/abc"), plain)).toBe(true);
    expect(
      isPrivate(new URL("https://app.hopshot.xyz/v1/vaults/v1/items"), plain),
    ).toBe(true);
  });

  it("never caches a decrypted image", () => {
    // A decrypted screenshot only ever exists as a blob: URL; caching one would write
    // plaintext to the device and outlive the item's expiry.
    expect(isPrivate(new URL("blob:https://app.hopshot.xyz/abc-123"), plain)).toBe(true);
    expect(isPrivate(new URL("data:image/png;base64,iVBOR"), plain)).toBe(true);
  });

  it("never caches a request carrying a credential", () => {
    const authed = { headers: new Headers({ Authorization: "Bearer secret" }) };
    expect(isPrivate(new URL("https://app.hopshot.xyz/anything"), authed)).toBe(true);
  });

  it("does allow the shell", () => {
    for (const path of ["/app", "/_astro/index.abc123.js", "/icons/icon-256.png", "/manifest.webmanifest"]) {
      expect(isPrivate(new URL(`https://app.hopshot.xyz${path}`), plain), path).toBe(false);
    }
  });
});

describe("the worker's declared shell", () => {
  it("precaches only static shell files", () => {
    const declared = /const SHELL = \[([^\]]*)\]/.exec(source);
    expect(declared, "SHELL must be a literal array").not.toBeNull();

    const entries = [...declared![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      // Nothing under /v1/ and nothing with a query may be precached.
      expect(entry.startsWith("/v1/"), entry).toBe(false);
      expect(entry.includes("?"), entry).toBe(false);
    }
  });

  it("handles the Android share target as a POST", () => {
    // A manifest share_target POST never reaches a page, so the worker has to own it.
    expect(source).toContain('url.pathname === "/app/share-target"');
    expect(source).toContain('request.method === "POST"');
  });

  it("hands a shared file over exactly once", () => {
    // Left in the cache, a shared image would be re-uploaded on the next launch.
    expect(source).toContain("cache.delete(SHARE_KEY)");
  });
});

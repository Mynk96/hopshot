import { afterEach, describe, expect, it, vi } from "vitest";
import { newKey } from "@hopshot/crypto";
import { VaultError, isIos, isStandalone, pair, parsePairFragment } from "../src/lib/vault.ts";

/**
 * `src/lib/vault.ts` (ARCHITECTURE §8).
 *
 * These are the parts that run without a DOM. The IndexedDB round-trip and the claim that
 * the stored key cannot be exported are covered in Playwright instead (`e2e/pair.spec.ts`),
 * because a faked IndexedDB would not prove anything about how a real browser
 * structured-clones a `CryptoKey`.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parsePairFragment", () => {
  it("splits #code.key", () => {
    const key = newKey();
    expect(parsePairFragment(`#ABCDEFGHJKLMNPQR.${key}`)).toEqual({
      code: "ABCDEFGHJKLMNPQR",
      vaultKey: key,
    });
  });

  it("works without the leading hash", () => {
    const key = newKey();
    expect(parsePairFragment(`ABCDEFGHJKLMNPQR.${key}`)?.vaultKey).toBe(key);
  });

  /**
   * base64url has no `.`, so splitting on the *first* dot is unambiguous even though a key
   * is long and opaque.
   */
  it("splits on the first dot only", () => {
    const parsed = parsePairFragment("#CODE12345678.aaa.bbb");
    expect(parsed).toEqual({ code: "CODE12345678", vaultKey: "aaa.bbb" });
  });

  it("rejects anything malformed rather than guessing", () => {
    // DESIGN S6 has copy for an incomplete link; a half-scanned QR must not half-work.
    for (const bad of [
      "",
      "#",
      "#nodot",
      "#.keyonly",
      "#short.key", // code below the minimum length
      "#ABCDEFGHJKLMNPQR.", // no key
      "#ABCDEFGHJKLMNPQR", // no separator
    ]) {
      expect(parsePairFragment(bad), bad).toBeNull();
    }
  });
});

describe("pair", () => {
  /**
   * The invite code is single-use (ARCHITECTURE §7.2), so a key that cannot be imported must
   * fail *before* the request — otherwise a mistyped link burns the code and the user has to
   * generate a new QR for no reason.
   */
  it("validates the key before touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(pair("ABCDEFGHJKLMNPQR", "not-a-valid-key", "iPhone")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces the API's own error copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "limit_reached", message: "Sync pairs up to 3 phones." },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    // The message is user-visible (DESIGN §5), so it has to come through intact.
    await expect(pair("ABCDEFGHJKLMNPQR", newKey(), "iPhone")).rejects.toMatchObject({
      code: "limit_reached",
      message: "Sync pairs up to 3 phones.",
    });
  });

  it("falls back to readable copy when there is no JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );

    let error: unknown;
    try {
      await pair("ABCDEFGHJKLMNPQR", newKey(), "iPhone");
    } catch (reason) {
      error = reason;
    }

    expect(error).toBeInstanceOf(VaultError);
    const { message } = error as VaultError;
    // The raw gateway HTML must never be what the user reads (DESIGN §5).
    expect(message).not.toContain("<html>");
    expect(message.endsWith(".")).toBe(true);
  });

  it("sends the code, name and kind the API expects", async () => {
    const key = newKey();
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("{}", { status: 500 }), // fails after the body is captured
    );
    vi.stubGlobal("fetch", fetchSpy);

    await pair("ABCDEFGHJKLMNPQR", key, "Mayank's iPhone").catch(() => undefined);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(body).toEqual({
      code: "ABCDEFGHJKLMNPQR",
      deviceName: "Mayank's iPhone",
      kind: "phone",
    });
    // CLAUDE.md privacy invariant: the key is never part of a request.
    expect(String(init.body)).not.toContain(key);
    expect(fetchSpy.mock.calls[0]![0]).not.toContain(key);
  });
});

describe("platform detection", () => {
  it("reports false when there is no browser at all", () => {
    // Server-rendered pass: both must be safe to call.
    expect(isStandalone()).toBe(false);
    expect(isIos()).toBe(false);
  });

  it("detects an iPhone", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      maxTouchPoints: 5,
    });
    expect(isIos()).toBe(true);
  });

  /** iPadOS 13+ claims to be a Mac; touch points are what give it away. */
  it("detects an iPad posing as a Mac", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 5,
    });
    expect(isIos()).toBe(true);
  });

  it("does not mistake a real Mac for iOS", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 0,
    });
    expect(isIos()).toBe(false);
  });

  it("detects an installed home-screen app", () => {
    // PRD F4.8 branches on this to decide whether to show the re-scan instructions.
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query.includes("standalone") }),
    });
    vi.stubGlobal("navigator", { userAgent: "iPhone", maxTouchPoints: 5 });
    expect(isStandalone()).toBe(true);
  });

  it("detects iOS standalone via the legacy flag", () => {
    // iOS Safari predates the display-mode media query.
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { userAgent: "iPhone", maxTouchPoints: 5, standalone: true });
    expect(isStandalone()).toBe(true);
  });

  it("reports a normal Safari tab as not standalone", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { userAgent: "iPhone", maxTouchPoints: 5, standalone: false });
    expect(isStandalone()).toBe(false);
  });
});

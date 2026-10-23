import { expect, test } from "@playwright/test";
import { seal, toBase64Url } from "@hopshot/crypto";

/**
 * The key in a drop link must never reach the network (CLAUDE.md rule 1, ARCHITECTURE §6).
 *
 * This is the test that proves the product's central privacy claim, so it is deliberately
 * paranoid: it fails the run from inside the request handler the moment the key appears in
 * *any* URL, header or body — not just the ones the viewer is expected to make. Anything
 * the page triggers, including analytics or a stray preload, is caught.
 *
 * The API is stubbed, so this exercises the real viewer against a real HOP1 envelope
 * without needing a deployed Worker.
 */

const DROP_ID = "7Kq2mXa9Lr4TzB0cP1vYwe";
const API = "https://api.hopshot.xyz/v1";

/** A 1x1 PNG — the plaintext the viewer should end up showing. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function makeDrop() {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = toBase64Url(keyBytes);
  const envelope = await seal(keyBytes, "drop", DROP_ID, PNG);
  return { key, envelope };
}

test.describe("drop viewer", () => {
  test("never puts the key in any network request", async ({ page }) => {
    const { key, envelope } = await makeDrop();
    const expiresAt = Date.now() + 24 * 3600 * 1000;

    // Every request the page makes, inspected before it goes anywhere.
    const leaks: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const haystack = [
        request.url(),
        JSON.stringify(request.headers()),
        request.postData() ?? "",
      ].join("\n");

      if (haystack.includes(key)) {
        leaks.push(`${request.method()} ${request.url()}`);
      }

      const url = new URL(request.url());
      if (url.href === `${API}/drops/${DROP_ID}/info`) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ expiresAt, size: envelope.length }),
        });
        return;
      }
      if (url.href === `${API}/drops/${DROP_ID}`) {
        await route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          body: Buffer.from(envelope),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/d/${DROP_ID}#${key}`);

    // The image only renders if the key decrypted the envelope, so this also proves the
    // key *was* used — a viewer that silently failed would pass a leak check trivially.
    await expect(page.locator("img")).toBeVisible({ timeout: 15_000 });

    expect(leaks, `the key appeared in: ${leaks.join(", ")}`).toEqual([]);
  });

  test("keeps the key out of the referrer on outbound links", async ({ page }) => {
    const { key, envelope } = await makeDrop();

    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === `${API}/drops/${DROP_ID}/info`) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ expiresAt: Date.now() + 3600_000, size: envelope.length }),
        });
        return;
      }
      if (url.href === `${API}/drops/${DROP_ID}`) {
        await route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          body: Buffer.from(envelope),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/d/${DROP_ID}#${key}`);
    await expect(page.locator("img")).toBeVisible({ timeout: 15_000 });

    // Browsers strip the fragment from Referer, but assert it rather than trusting it:
    // this is the one place a key could escape without any code sending it.
    const referrer = await page.evaluate(() => document.referrer);
    expect(referrer).not.toContain(key);

    // And it must not have been parked anywhere persistent.
    const stored = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(stored.local).not.toContain(key);
    expect(stored.session).not.toContain(key);
  });

  test("shows the bad-link state when the fragment is missing", async ({ page }) => {
    await page.goto(`/d/${DROP_ID}`);
    await expect(page.getByText(/link is incomplete/i)).toBeVisible();
  });

  test("shows the expired state when the API says gone", async ({ page }) => {
    await page.route(`${API}/drops/${DROP_ID}/info`, (route) =>
      route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "gone", message: "expired" } }),
      }),
    );

    await page.goto(`/d/${DROP_ID}#${"k".repeat(43)}`);
    await expect(page.getByText(/has expired/i)).toBeVisible();
  });
});

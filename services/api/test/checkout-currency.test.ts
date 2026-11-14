import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, send } from "./helpers.ts";

beforeEach(applyMigrations);

/**
 * The Stripe account is Indian: an India-issued card can only be charged in INR, so a buyer
 * in India gets the INR price and everyone else the USD one.
 */
describe("POST /v1/license/buy/bundle — checkout currency", () => {
  const vars = env as unknown as Record<string, string | undefined>;
  let bodies: URLSearchParams[] = [];

  function stubStripe() {
    vars.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
    bodies = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://api.stripe.com/v1/checkout/sessions")) {
        throw new Error(`unexpected outbound request to ${url}`);
      }
      const body = new URLSearchParams(String(init?.body));
      bodies.push(body);
      return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete vars.STRIPE_SECRET_KEY;
  });

  function buy(country?: string) {
    return send("/v1/license/buy/bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hopshot-Install": crypto.randomUUID() },
      body: "{}",
      ...(country ? { cf: { country } } : {}),
    } as RequestInit);
  }

  it("charges the INR price when the buyer is in India", async () => {
    stubStripe();
    const response = await buy("IN");
    expect(response.status).toBe(201);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.get("line_items[0][price]")).toBe(vars.STRIPE_PRICE_BUNDLE_INR);
  });

  it("charges the USD price everywhere else", async () => {
    stubStripe();
    expect((await buy("US")).status).toBe(201);
    expect(bodies[0]!.get("line_items[0][price]")).toBe(vars.STRIPE_PRICE_BUNDLE);
  });

  it("charges the USD price when the country is unknown", async () => {
    stubStripe();
    expect((await buy()).status).toBe(201);
    expect(bodies[0]!.get("line_items[0][price]")).toBe(vars.STRIPE_PRICE_BUNDLE);
  });
});

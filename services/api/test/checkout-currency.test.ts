import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, send } from "./helpers.ts";

beforeEach(applyMigrations);

/**
 * The Stripe account is Indian: an India-issued card can only be charged in INR, so a buyer
 * in India gets the price's INR option and everyone else the default (USD).
 */
describe("POST /v1/license/buy/bundle — checkout currency", () => {
  const vars = env as unknown as Record<string, string | undefined>;
  let bodies: URLSearchParams[] = [];

  function stubStripe(refuseInr = false) {
    vars.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
    bodies = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://api.stripe.com/v1/checkout/sessions")) {
        throw new Error(`unexpected outbound request to ${url}`);
      }
      const body = new URLSearchParams(String(init?.body));
      bodies.push(body);
      if (refuseInr && body.get("currency") === "inr") {
        return Response.json({ error: { message: "currency not available" } }, { status: 400 });
      }
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

  it("asks for INR when the buyer is in India", async () => {
    stubStripe();
    const response = await buy("IN");
    expect(response.status).toBe(201);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.get("currency")).toBe("inr");
  });

  it("leaves the price's default currency for everyone else", async () => {
    stubStripe();
    expect((await buy("US")).status).toBe(201);
    expect(bodies[0]!.get("currency")).toBeNull();
  });

  it("still opens a checkout when Stripe refuses INR", async () => {
    stubStripe(true);
    const response = await buy("IN");
    expect(response.status).toBe(201);
    expect(bodies.map((b) => b.get("currency"))).toEqual(["inr", null]);
  });
});

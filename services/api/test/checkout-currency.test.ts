import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inrPaise } from "../src/lib/stripe.ts";
import { applyMigrations, send } from "./helpers.ts";

beforeEach(applyMigrations);

/**
 * $10 USD is the one price. The Stripe account is Indian and may charge an India-issued card
 * only in INR, so a buyer in India pays that $10 converted at today's rate; everyone else pays
 * the USD price itself.
 */
describe("POST /v1/license/buy/bundle — checkout currency", () => {
  const vars = env as unknown as Record<string, string | undefined>;
  let checkouts: URLSearchParams[] = [];

  function stub({ rate = 94.25, fxDown = false } = {}) {
    vars.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
    checkouts = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.frankfurter.dev/")) {
        if (fxDown) return new Response("down", { status: 503 });
        return Response.json({ base: "USD", rates: { INR: rate } });
      }
      if (url.startsWith("https://api.stripe.com/v1/prices/")) {
        return Response.json({ unit_amount: 1000, currency: "usd", product: "prod_hopshot" });
      }
      if (url.startsWith("https://api.stripe.com/v1/checkout/sessions")) {
        checkouts.push(new URLSearchParams(String(init?.body)));
        return Response.json({
          id: "cs_test_1",
          url: "https://checkout.stripe.com/c/pay/cs_test_1",
        });
      }
      throw new Error(`unexpected outbound request to ${url}`);
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

  it("rounds the converted amount to whole rupees", () => {
    expect(inrPaise(1000, 94.25)).toBe(94_300); // $10.00 → ₹943
    expect(inrPaise(1000, 83.04)).toBe(83_000); // $10.00 → ₹830
  });

  it("charges a buyer in India the $10 price converted to INR", async () => {
    stub({ rate: 94.25 });
    expect((await buy("IN")).status).toBe(201);
    const body = checkouts[0]!;
    expect(body.get("line_items[0][price]")).toBeNull();
    expect(body.get("line_items[0][price_data][currency]")).toBe("inr");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("94300");
    expect(body.get("line_items[0][price_data][product]")).toBe("prod_hopshot");
  });

  it("falls back to the fixed INR price when the rate is unavailable", async () => {
    stub({ fxDown: true });
    expect((await buy("IN")).status).toBe(201);
    expect(checkouts[0]!.get("line_items[0][price]")).toBe(vars.STRIPE_PRICE_BUNDLE_INR);
  });

  it("charges the USD price everywhere else", async () => {
    stub();
    expect((await buy("US")).status).toBe(201);
    expect(checkouts[0]!.get("line_items[0][price]")).toBe(vars.STRIPE_PRICE_BUNDLE);
    expect(checkouts[0]!.get("line_items[0][price_data][currency]")).toBeNull();
  });

  it("charges the USD price when the country is unknown", async () => {
    stub();
    expect((await buy()).status).toBe(201);
    expect(checkouts[0]!.get("line_items[0][price]")).toBe(vars.STRIPE_PRICE_BUNDLE);
  });
});

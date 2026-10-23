import { describe, expect, it } from "vitest";

import { formatMoney, renderReceipt } from "../src/emails/receipt.ts";

/**
 * The purchase email (PRD F8.3).
 *
 * The receipt is the only record most customers keep of what they paid, so what is asserted
 * here is that the numbers survive the render — not how the thing looks.
 */

const PURCHASE = {
  email: "buyer@example.com",
  plan: "lifetime" as const,
  licenseId: "a1b2c3d4e5f6a7b8c9d0e1",
  amountTotal: 1200,
  currency: "usd",
  paidAt: Date.UTC(2026, 9, 23, 14, 11),
  name: "A Buyer",
};

describe("formatMoney", () => {
  it("renders the usual two-decimal currencies", () => {
    expect(formatMoney(1200, "usd")).toBe("$12.00");
    expect(formatMoney(2400, "EUR")).toContain("24.00");
  });

  /** A hardcoded `/ 100` would print ¥18 for a ¥1,800 payment. */
  it("respects currencies that have no minor unit", () => {
    expect(formatMoney(1800, "jpy")).toBe("¥1,800");
  });

  it("respects three-decimal currencies", () => {
    expect(formatMoney(3500, "kwd")).toContain("3.500");
  });

  it("prints an unknown-but-wellformed code as Intl does, rather than throwing", () => {
    // Intl separates the code with a non-breaking space, hence the loose match.
    expect(formatMoney(1200, "zzz")).toMatch(/^ZZZ\s12\.00$/);
  });

  it("falls back rather than throwing on a malformed code", () => {
    expect(formatMoney(1200, "us")).toBe("12.00 US");
  });
});

describe("the receipt", () => {
  it("states what was bought, when, for how much and against which order", () => {
    const { subject, html, text } = renderReceipt(PURCHASE);

    expect(subject).toBe("Your Hopshot Lifetime receipt");

    for (const part of [html, text]) {
      expect(part).toContain("Hopshot Lifetime");
      expect(part).toContain("23 October 2026");
      expect(part).toContain("$12.00");
      expect(part).toContain("a1b2c3d4e5f6a7b8c9d0e1");
      expect(part).toContain("buyer@example.com");
      expect(part).toContain("A Buyer");
    }
  });

  /** Gmail's preview line is the first thing anyone sees of this email. */
  it("puts the amount and order in the preheader", () => {
    const { html } = renderReceipt(PURCHASE);
    expect(html).toContain("$12.00 · Hopshot Lifetime · order a1b2c3d4e5f6a7b8c9d0e1");
  });

  it("tells a bundle buyer when the included Sync year ends, and that it does not renew", () => {
    const { html, text } = renderReceipt({
      ...PURCHASE,
      plan: "bundle",
      syncEndsAt: Date.UTC(2027, 9, 23, 14, 11),
    });

    for (const part of [html, text]) {
      expect(part).toContain("Hopshot Lifetime + Sync");
      expect(part).toContain("23 October 2027");
      expect(part).toContain("Nothing renews by itself");
    }
  });

  it("says nothing about Sync renewal on a lifetime receipt", () => {
    expect(renderReceipt(PURCHASE).text).not.toContain("Sync");
  });

  /**
   * Stripe can complete a session without an amount (rare, but it is optional in the API).
   * A receipt claiming "$0.00" would be worse than one that simply omits the line.
   */
  it("omits the total rather than inventing one when Stripe sent no amount", () => {
    const { html, text } = renderReceipt({
      ...PURCHASE,
      amountTotal: null,
      currency: null,
    });

    expect(text).not.toContain("Paid:");
    expect(html).not.toContain("$");
    // The rest of the receipt still stands.
    expect(text).toContain("a1b2c3d4e5f6a7b8c9d0e1");
  });

  it("falls back to the send time when the payment carried no date", () => {
    const { text } = renderReceipt({ ...PURCHASE, paidAt: null }, Date.UTC(2026, 0, 2));
    expect(text).toContain("2 January 2026");
  });

  /** A name comes from Stripe's checkout form, which is a text field like any other. */
  it("escapes customer-supplied text in the HTML part", () => {
    const { html } = renderReceipt({ ...PURCHASE, name: '<script>alert("x")</script>' });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  /**
   * A `"` inside `style="…"` closes the attribute, and everything after it is parsed as
   * attributes of the tag — which is how a font stack quietly destroys a layout in every
   * client at once. Easier to assert than to spot.
   */
  it("quotes font stacks so they survive being inlined in a style attribute", () => {
    const { html } = renderReceipt(PURCHASE);

    expect(html).toContain("'Segoe UI'");
    expect(html).not.toContain('"Segoe UI"');
    expect(html).not.toContain('"SF Mono"');
  });

  it("sends a plain-text part that is actually plain", () => {
    const { text } = renderReceipt(PURCHASE);
    expect(text).not.toContain("<");
  });
});

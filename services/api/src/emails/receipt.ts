/**
 * The purchase email (PRD F8.3, ARCHITECTURE §7.5).
 *
 * It has two jobs and they pull in opposite directions: it is the record of what somebody
 * paid — the thing they forward to an accountant or search for two years later — and it is
 * the only message a Hopshot customer gets after buying. So the receipt is a real receipt
 * (what, when, how much, which order), and everything else on the page is the one question
 * they will actually have: *what do I do on my next computer?*
 *
 * Both renderings are produced together and say the same things in the same order. A client
 * that refuses HTML must not get a worse receipt, only a plainer one.
 */

import { escapeHtml, heading, link, page, paragraph, receipt } from "./layout.ts";

export type Purchase = {
  email: string;
  plan: "lifetime" | "bundle";
  /** `licenses.id` — what support asks for, so it is the order reference. */
  licenseId: string;
  /** Stripe's `amount_total`, in the currency's minor unit. Absent if Stripe omitted it. */
  amountTotal?: number | null;
  currency?: string | null;
  /** When the payment completed (ms). Falls back to now, which is within seconds of it. */
  paidAt?: number | null;
  name?: string | null;
  /**
   * When the bundle's included year of Sync runs out (ms), or null for Lifetime.
   *
   * Passed in rather than worked out here: the term belongs to the licensing rules, and a
   * template that computed it would be a second place for "a year" to be defined. Keeping
   * every template a pure function of its input is also what makes previewing one cheap.
   */
  syncEndsAt?: number | null;
};

export type Rendered = { subject: string; html: string; text: string };

const SITE = "https://hopshot.xyz";

function productName(plan: Purchase["plan"]): string {
  return plan === "bundle" ? "Hopshot Lifetime + Sync" : "Hopshot Lifetime";
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Minor units → "$12.00", "¥1,800", "KD 3.500".
 *
 * The number of decimals is asked of `Intl` rather than assumed to be two: yen has none and
 * dinars have three, so a hardcoded `/ 100` would print a Japanese customer a hundredth of
 * what they actually paid. A malformed code falls back to the two-decimal convention rather
 * than throwing — a receipt with a slightly odd amount beats no receipt at all.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const format = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minorUnits / 10 ** digits);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${code}`;
  }
}

export function renderReceipt(purchase: Purchase, now = Date.now()): Rendered {
  const what = productName(purchase.plan);
  const paidAt = purchase.paidAt ?? now;
  const date = formatDate(paidAt);

  const total =
    typeof purchase.amountTotal === "number" && purchase.currency
      ? formatMoney(purchase.amountTotal, purchase.currency)
      : null;

  const rows: { label: string; value: string; mono?: boolean; strong?: boolean }[] = [
    { label: "Item", value: what },
    { label: "Date", value: date },
    { label: "Order", value: purchase.licenseId, mono: true },
  ];
  if (purchase.name) rows.push({ label: "Billed to", value: purchase.name });
  rows.push({ label: purchase.name ? "Email" : "Billed to", value: purchase.email });
  // Last, where the eye looks for a total — and omitted entirely rather than guessed at if
  // Stripe sent no amount.
  if (total) rows.push({ label: "Paid", value: total, strong: true });

  // The bundle's Sync year is stated with its end date because PRD F8.8 renews only on an
  // explicit yes — a customer who is told when it ends is never surprised by it ending.
  const syncLine =
    purchase.plan === "bundle" && purchase.syncEndsAt
      ? `Your included year of Sync runs until ${formatDate(purchase.syncEndsAt)}. Nothing renews by itself — we'll email you before then, and it only continues if you say yes.`
      : null;

  const subject = `Your ${what} receipt`;
  const preheader = total
    ? `${total} · ${what} · order ${purchase.licenseId}`
    : `${what} · order ${purchase.licenseId}`;

  const body = [
    heading("You're all set"),
    paragraph(
      "Hopshot is unlocked on the computer you bought it from — there's no licence key to enter.",
    ),
    receipt(rows),
    ...(syncLine ? [paragraph(escapeHtml(syncLine))] : []),
    paragraph(
      '<strong style="font-weight:600">Reinstalling, or moving to another computer?</strong> Open Settings → License → <em>Already bought? Restore</em>, enter this email address, and we\'ll send you a six-digit code.',
    ),
    paragraph(
      `Keep this email — it's your receipt. If anything looks wrong, just reply. ${link(`${SITE}/faq`, "Questions")} · ${link(`${SITE}/download`, "Download")}`,
      "muted",
    ),
  ].join("\n");

  const html = page({
    preheader,
    body,
    footer: `Hopshot · ${link(SITE, "hopshot.xyz")} · Changed your mind within 14 days? Reply and we'll refund you, no questions.`,
  });

  const text = [
    `You're all set — thanks for buying ${what}.`,
    "",
    "Hopshot is unlocked on the computer you bought it from — there's no licence key to enter.",
    "",
    "RECEIPT",
    ...rows.map(({ label, value }) => `  ${label}: ${value}`),
    "",
    ...(syncLine ? [syncLine, ""] : []),
    "Reinstalling, or moving to another computer? Open Settings → License →",
    '"Already bought? Restore", enter this email address, and we\'ll send you a',
    "six-digit code.",
    "",
    "Keep this email — it's your receipt. If anything looks wrong, just reply.",
    "Changed your mind within 14 days? Reply and we'll refund you, no questions.",
    "",
    "Hopshot",
    SITE,
  ].join("\n");

  return { subject, html, text };
}

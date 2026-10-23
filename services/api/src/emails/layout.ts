/**
 * The shell every Hopshot email is poured into (ARCHITECTURE §7.5).
 *
 * Email HTML is not web HTML: no flexbox, no external stylesheet, and several clients drop
 * `<style>` entirely. So every rule that matters is inline on the element, tables do the
 * layout, and the one `<style>` block carries nothing but the dark-mode variant — losing it
 * costs the theme, never the legibility.
 *
 * Colours are DESIGN.md §2.1. The light values are the base because an email is read on a
 * white canvas more often than not, and `--accent` (#FF6B2C) fails contrast on white, so
 * text uses `--accent-text` and the accent itself is only ever a background.
 *
 * Nothing is interpolated unescaped: names, addresses and amounts come from Stripe, which
 * is not a trusted source of markup.
 */

/*
 * DESIGN.md §2.2, with single quotes around the multi-word families: these stacks end up
 * inside `style="…"`, and a double quote there closes the attribute and spills the rest of
 * the declaration into the tag as junk attributes.
 */
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace`;

const INK = "#18181B";
const INK_2 = "#52525B";
const INK_3 = "#71717A";
const ACCENT_TEXT = "#C2410C";
const ACCENT = "#FF6B2C";
const ON_ACCENT = "#1B0F08";
const LINE = "#E4E4E7";
const CARD = "#FFFFFF";
const PAGE = "#F4F4F5";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 20/26/650 — DESIGN.md `heading`, scaled up a little for a 560 px email column. */
export function heading(text: string): string {
  return `<h1 class="ink" style="margin:0 0 12px;font:650 24px/30px ${FONT};color:${INK};letter-spacing:-0.01em">${escapeHtml(text)}</h1>`;
}

/** Body copy. `html` is trusted — callers pass escaped text or a link built here. */
export function paragraph(html: string, tone: "normal" | "muted" = "normal"): string {
  const color = tone === "muted" ? INK_3 : INK_2;
  const cls = tone === "muted" ? "ink-3" : "ink-2";
  const size = tone === "muted" ? "13px/20px" : "15px/23px";
  return `<p class="${cls}" style="margin:0 0 14px;font:400 ${size} ${FONT};color:${color}">${html}</p>`;
}

export function link(href: string, text: string): string {
  return `<a class="accent" href="${escapeHtml(href)}" style="color:${ACCENT_TEXT};text-decoration:underline">${escapeHtml(text)}</a>`;
}

/**
 * The receipt table.
 *
 * A table and not a list of paragraphs because a receipt is read by scanning down the right
 * edge for the amount, and only a table keeps the values aligned once a client reflows the
 * column on a phone.
 */
export function receipt(
  rows: { label: string; value: string; mono?: boolean; strong?: boolean }[],
): string {
  const cells = rows
    .map(({ label, value, mono, strong }, index) => {
      // The hairline goes above every row but the first, so the total sits visibly apart.
      const divider = index === 0 ? "" : `border-top:1px solid ${LINE};`;
      const valueFont = mono
        ? `400 13px/20px ${MONO}`
        : `${strong ? 650 : 400} ${strong ? "16px/22px" : "14px/20px"} ${FONT}`;
      return `
            <tr>
              <td class="hair ink-3" style="${divider}padding:10px 0;font:400 13px/20px ${FONT};color:${INK_3};white-space:nowrap">${escapeHtml(label)}</td>
              <td class="hair ink" style="${divider}padding:10px 0;font:${valueFont};color:${INK};text-align:right">${escapeHtml(value)}</td>
            </tr>`;
    })
    .join("");

  return `
      <table class="card hair" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CARD};border:1px solid ${LINE};border-radius:14px;border-collapse:separate;margin:0 0 20px">
        <tr>
          <td style="padding:6px 18px 10px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${cells}
            </table>
          </td>
        </tr>
      </table>`;
}

/** A single accent button. Padding on the `<a>`, because Outlook ignores height on one. */
export function button(href: string, text: string): string {
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px">
        <tr>
          <td style="background:${ACCENT};border-radius:8px">
            <a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 18px;font:600 14px/18px ${FONT};color:${ON_ACCENT};text-decoration:none">${escapeHtml(text)}</a>
          </td>
        </tr>
      </table>`;
}

export function divider(): string {
  return `<div class="hair" style="height:1px;background:${LINE};margin:4px 0 20px;font-size:0;line-height:0">&nbsp;</div>`;
}

/**
 * @param preheader The line Gmail shows next to the subject. Without one it inlines the
 *   first words of the body, which is how a careful email ends up previewing as "Hopshot".
 */
export function page(options: { preheader: string; body: string; footer: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  @media (prefers-color-scheme: dark) {
    .page { background: #141417 !important; }
    .card { background: #26262C !important; }
    .hair { border-color: rgba(255,255,255,0.14) !important; background-color: unset; }
    .ink { color: #F4F4F5 !important; }
    .ink-2 { color: #A1A1AA !important; }
    .ink-3 { color: #8A8A93 !important; }
    .accent { color: #FF9A6B !important; }
  }
  @media (max-width: 600px) {
    .shell { padding: 20px 16px !important; }
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${PAGE};-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(options.preheader)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE}">
    <tr>
      <td align="center" style="padding:32px 12px 40px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:560px;max-width:100%">
          <tr>
            <td class="shell" style="padding:4px 4px 24px">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px">
                <tr>
                  <td style="padding-right:8px">
                    <div style="width:10px;height:10px;border-radius:999px;background:${ACCENT};font-size:0;line-height:0">&nbsp;</div>
                  </td>
                  <td class="ink" style="font:650 15px/18px ${FONT};color:${INK};letter-spacing:-0.01em">Hopshot</td>
                </tr>
              </table>
${options.body}
${divider()}
              <p class="ink-3" style="margin:0;font:400 12px/19px ${FONT};color:${INK_3}">${options.footer}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

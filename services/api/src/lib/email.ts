/**
 * Transactional email via Resend (ARCHITECTURE §7.5).
 *
 * Two messages at launch: the purchase receipt and the restore code. Both are sent at most
 * once per subject per kind, recorded in `emails_sent`, so a redelivered webhook cannot mail
 * somebody twice.
 *
 * Addresses are never logged. A failure is logged and swallowed by the caller: a licence must
 * not fail to exist because an email bounced.
 */

const API = "https://api.resend.com/emails";

function config(env: Env): { key: string; from: string } | null {
  const vars = env as { RESEND_API_KEY?: string; EMAIL_FROM?: string };
  if (!vars.RESEND_API_KEY || !vars.EMAIL_FROM) return null;
  return { key: vars.RESEND_API_KEY, from: vars.EMAIL_FROM };
}

async function send(
  env: Env,
  to: string,
  subject: string,
  text: string,
): Promise<boolean> {
  const settings = config(env);
  if (!settings) {
    console.warn("email not configured; skipping send");
    return false;
  }

  const response = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: settings.from, to, subject, text }),
  });

  if (!response.ok) {
    // The status is useful; the body can contain the recipient, so it is not logged.
    console.warn(`resend -> ${response.status}`);
    return false;
  }
  return true;
}

/**
 * Send at most once for a given (subject, kind, period).
 *
 * `period_key` is empty for one-off mail and a date for anything recurring, which is what
 * lets a yearly notice repeat next year without a second table.
 */
async function once(
  env: Env,
  subjectId: string,
  kind: string,
  periodKey: string,
  deliver: () => Promise<boolean>,
): Promise<void> {
  const claimed = await env.DB.prepare(
    `INSERT INTO emails_sent (subject_id, kind, period_key, sent_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(subject_id, kind, period_key) DO NOTHING`,
  )
    .bind(subjectId, kind, periodKey, Date.now())
    .run();

  // Already sent. Recorded before delivering so two concurrent webhooks cannot both send.
  if ((claimed.meta.changes ?? 0) === 0) return;

  if (!(await deliver())) {
    // Let a genuine failure be retried rather than permanently marked as sent.
    await env.DB.prepare(
      "DELETE FROM emails_sent WHERE subject_id = ?1 AND kind = ?2 AND period_key = ?3",
    )
      .bind(subjectId, kind, periodKey)
      .run();
  }
}

/** PRD F8.3: the receipt doubles as the record of what they bought. */
export async function sendReceipt(
  env: Env,
  email: string,
  plan: "lifetime" | "bundle",
  licenseId: string,
): Promise<void> {
  const what = plan === "bundle" ? "Hopshot Lifetime + Sync" : "Hopshot Lifetime";

  await once(env, licenseId, "receipt", "", () =>
    send(
      env,
      email,
      `Your ${what} purchase`,
      [
        `Thanks for buying ${what}.`,
        "",
        "Hopshot is already unlocked on the computer you bought it from — there is no licence key to enter.",
        "",
        "If you reinstall or move to another computer, open Settings → License → Already bought? Restore and we'll email you a code.",
        "",
        "Hopshot",
        "https://hopshot.xyz",
      ].join("\n"),
    ),
  );
}

/**
 * "Sync renews in 10 days — confirm?" (PRD F8.8).
 *
 * Deduplicated per licence per year through `once`, keyed on the renewal year, so the daily
 * cron can run every day inside the notice window and still send exactly one email — and
 * next year's notice is a separate row rather than being suppressed by this one.
 *
 * The copy has to be unambiguous that nothing is charged unless they act, because that is
 * the actual behaviour and the opposite of what most renewal emails mean.
 */
export async function sendRenewalNotice(
  env: Env,
  email: string,
  licenseId: string,
  periodKey: string,
  confirmUrl: string,
  renewalAt: number,
): Promise<void> {
  const on = new Date(renewalAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  await once(env, licenseId, "sync_renewal", periodKey, () =>
    send(
      env,
      email,
      "Your year of Hopshot Sync ends soon",
      [
        `Your included year of Sync ends on ${on}.`,
        "",
        "Nothing will be charged. If you want to keep syncing to your phone and using up to",
        "three computers, confirm here and it continues at $24/year:",
        "",
        confirmUrl,
        "",
        "If you do nothing, Sync simply stops and the rest of Hopshot keeps working — your",
        "shelf, capture, drag-out and share links are all yours for good.",
        "",
        "Hopshot",
      ].join("\n"),
    ),
  );
}

/**
 * A six-digit restore code.
 *
 * Not deduplicated by `once`: asking again is how someone recovers from a lost email, and
 * each request issues a fresh code that supersedes the last.
 */
export async function sendRestoreCode(
  env: Env,
  email: string,
  code: string,
): Promise<boolean> {
  return send(
    env,
    email,
    "Your Hopshot restore code",
    [
      `Your restore code is ${code}`,
      "",
      "Enter it in Hopshot under Settings → License. It expires in 15 minutes.",
      "",
      "If you didn't ask for this, you can ignore it.",
      "",
      "Hopshot",
    ].join("\n"),
  );
}

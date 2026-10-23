import { sendRenewalNotice } from "./email.ts";
import { createRenewalToken, periodKeyFor, renewalsDue } from "./license.ts";

/**
 * The daily 09:00 UTC cron (PRD F8.8, ARCHITECTURE §7.8).
 *
 * Finds bundles whose included year of Sync is about to end and asks whether to continue.
 * **Nothing renews itself** — this sends a question, and Sync only continues if the customer
 * follows the link and completes Checkout.
 *
 * Safe to run every day inside the notice window: `sendRenewalNotice` deduplicates per
 * licence per renewal year through `emails_sent`, so a customer gets exactly one email and
 * next year's notice is a separate row rather than being suppressed by this one.
 */

/** Returns how many notices went out. */
export async function sendRenewalNotices(env: Env, now = Date.now()): Promise<number> {
  const due = await renewalsDue(env, now);
  if (due.length === 0) return 0;

  let sent = 0;

  for (const renewal of due) {
    const periodKey = periodKeyFor(renewal.renewalAt);

    try {
      /*
       * A token is minted per attempt, but the *email* is deduplicated — so a second run on
       * the same day creates an unused token and sends nothing. That is the cheaper mistake:
       * an unused token expires on its own, whereas skipping the mint would mean a retry
       * after a mail failure had no link to send.
       */
      const token = await createRenewalToken(env, renewal.licenseId, periodKey, now);
      // The confirm link has to point at the *API*, not the web app: /license/renew is the
      // route that burns the token and redirects into Checkout.
      const apiOrigin =
        (env as { API_ORIGIN?: string }).API_ORIGIN ?? "https://api.hopshot.xyz";
      const confirmUrl = `${apiOrigin}/v1/license/renew/${token}`;

      await sendRenewalNotice(
        env,
        renewal.email,
        renewal.licenseId,
        periodKey,
        confirmUrl,
        renewal.renewalAt,
      );
      sent++;
    } catch (error) {
      // One bad address must not stop the rest of the run.
      console.warn(`could not send a renewal notice for ${renewal.licenseId}`, error);
    }
  }

  return sent;
}

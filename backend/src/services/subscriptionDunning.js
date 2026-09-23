'use strict';

const pgDb = require('../pgDb');
// Called through the module rather than destructured so the send path can
// be observed in tests without a real mailbox being involved.
const notifier = require('./notifierPg');

// Chasing a fleet whose card was declined.
//
// The shape of this is deliberately unsurprising: three more attempts spread
// over twelve days, an email after each one naming the amount, the card and
// the date access stops, and then — only then — the account is paused. A fleet
// should never discover it has been cut off; it should have been told three
// times, with the date in every message.
//
// Two rules this is built around.
//
// Retry on a schedule, never on a loop. A daily run that re-presents a
// declined card every morning gets the merchant account flagged, so the next
// attempt is written to the database and nothing may charge before it.
//
// Say the same date every time. The deadline in the email is read from
// `billing_grace_until`, which is the column the suspension actually reads, so
// the warning and the action cannot drift apart.

// Days after the period started on which we try again. Three attempts, then
// we stop asking.
const RETRY_DAY_OFFSETS = [3, 7, 12];

// How long a fleet keeps the platform while its payment is outstanding. Two
// days after the last attempt, so the final email is not also the cut-off.
const GRACE_DAYS = 14;

const MAX_ATTEMPTS = RETRY_DAY_OFFSETS.length + 1;

function asDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function parseDate(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * When to try the card next, and when access stops if we never succeed.
 *
 * `failureCount` is the number of attempts that have now failed, including the
 * one that just did. A null retry date means we have asked enough times.
 */
function scheduleAfterFailure({ failureCount, periodStart, when = new Date() }) {
  const start = parseDate(periodStart, when);
  const offset = RETRY_DAY_OFFSETS[failureCount - 1];

  const graceUntil = asDate(addDays(start, GRACE_DAYS));

  let retryAt = null;
  if (offset !== undefined) {
    const scheduled = addDays(start, offset);
    // A first failure that happens late — a period charged by hand a week in,
    // say — must still wait before the card is presented again, not be retried
    // by a run that starts in three hours.
    const candidate = asDate(scheduled > when ? scheduled : addDays(when, 1));
    // Pushing it back can carry it past the deadline, and an attempt booked
    // for a day the account is already paused is not an attempt. Better to
    // say plainly that there are none left, so the fleet is told so.
    if (candidate <= graceUntil) retryAt = candidate;
  }

  return {
    retryAt,
    graceUntil,
    attemptsLeft: retryAt ? Math.max(0, MAX_ATTEMPTS - failureCount) : 0,
  };
}

/** Everyone at a fleet who should hear that its payment failed. */
async function billingContacts(organizationId, db = pgDb) {
  const { rows } = await db.query(
    `SELECT id, full_name, email FROM users
      WHERE organization_id = $1
        AND role IN ('fleet_owner_admin', 'fleet_owner_billing')
        AND status = 'active' AND deleted_at IS NULL`, [organizationId]);
  return rows;
}

function money(amount) {
  return `R${Number(amount || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function humanDate(value) {
  if (!value) return 'shortly';
  return new Date(value).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The email a fleet gets after a declined charge.
 *
 * It says the amount, which card, why it failed if the bank told us, what
 * happens next and by when. A message that says only "payment failed" makes
 * the fleet phone us to find out all four.
 */
function noticeBody({ org, invoice, reason, attemptsLeft, graceUntil, suspended }) {
  const card = org.billing_card_last4
    ? `${org.billing_card_brand || 'card'} ending ${org.billing_card_last4}`
    : 'the card on file';

  if (suspended) {
    return [
      `Hi ${org.name},`,
      '',
      `We were not able to collect ${money(invoice?.amount)} for your Pillion subscription, after four attempts on ${card}.`,
      '',
      'Your account is now paused. Tracking carries on in the background and nothing has been deleted — your bikes, agreements and history are all exactly where you left them — but nobody at your fleet can sign in until the payment goes through.',
      '',
      'To restore it, sign in as the billing contact and update your card on the Subscription page. The outstanding amount is charged immediately and access comes back at once.',
      '',
      reason ? `What the bank said: ${reason}` : null,
    ].filter((l) => l !== null).join('\n');
  }

  const closing = attemptsLeft > 0
    ? `We will try ${card} again automatically. If it has not gone through by ${humanDate(graceUntil)}, the account is paused until it does.`
    : `That was our last automatic attempt. If the payment has not gone through by ${humanDate(graceUntil)}, the account is paused until it does.`;

  return [
    `Hi ${org.name},`,
    '',
    `We could not collect ${money(invoice?.amount)} for your Pillion subscription${invoice?.description ? ` — ${invoice.description}` : ''}.`,
    '',
    reason ? `The bank declined it: ${reason}` : 'The charge was declined.',
    '',
    closing,
    '',
    'You can fix this now by updating your card on the Subscription page, which charges the outstanding amount straight away.',
  ].join('\n');
}

/**
 * Tell a fleet its payment failed.
 *
 * `noticeKey` stops the same message going out twice when a run is repeated —
 * a fleet that has already been told its card failed on attempt two does not
 * need to hear it again because somebody re-ran the scheduler.
 */
async function sendNotice({ org, invoice, reason, attemptsLeft, graceUntil, suspended = false, db = pgDb }) {
  const noticeKey = suspended ? 'suspended' : `failure_${org.billing_failure_count}`;
  if (org.billing_last_notice === noticeKey) return { skipped: 'already sent', noticeKey };

  const contacts = await billingContacts(org.id, db);
  if (!contacts.length) {
    // Nobody to tell is worth knowing about: the fleet will be suspended
    // without ever having been warned, and that is our problem, not theirs.
    console.warn(`[subscription-dunning] organisation ${org.id} has no active billing contact to notify`);
    return { skipped: 'no billing contact', noticeKey };
  }

  const title = suspended
    ? 'Your Pillion account has been paused'
    : attemptsLeft > 0
      ? 'We could not take your Pillion payment'
      : `Final notice — Pillion access pauses on ${humanDate(graceUntil)}`;

  const message = noticeBody({ org, invoice, reason, attemptsLeft, graceUntil, suspended });

  let sent = 0;
  for (const contact of contacts) {
    try {
      await notifier.sendNotification({
        userId: contact.id,
        channel: 'email',
        type: suspended ? 'subscription_suspended' : 'subscription_payment_failed',
        title,
        message,
        entityType: 'organizations',
        entityId: org.id,
        throwOnError: false,
      });
      sent += 1;
    } catch (e) {
      // One contact's bad address must not cost the others their warning.
      console.error(`[subscription-dunning] could not notify user ${contact.id}:`, e.message);
    }
  }

  await db.query(`UPDATE organizations SET billing_last_notice = $2, updated_at = NOW() WHERE id = $1`,
    [org.id, noticeKey]);

  return { sent, noticeKey };
}

/**
 * Record a failed charge: schedule the next attempt, mark the subscription
 * past due and warn the fleet.
 *
 * Access is deliberately not touched here. A card declined this morning is
 * usually a limit or an expiry, not a fleet that has stopped paying, and
 * cutting off a working fleet's tracking over it would do far more damage than
 * waiting the fortnight out.
 */
async function recordFailure({ organizationId, invoice, reason, when = new Date(), db = pgDb }) {
  // The count is incremented here rather than by the caller, so the number
  // the schedule is built from is the one now in the database. Reading it
  // first and incrementing afterwards would schedule every failure as though
  // it were the previous one.
  const { rows } = await db.query(
    `UPDATE organizations
        SET billing_failure_count = billing_failure_count + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, billing_failure_count, billing_card_last4, billing_card_brand,
                billing_grace_until, billing_last_notice`, [organizationId]);
  const org = rows[0];
  if (!org) return { skipped: 'no such organisation' };

  const schedule = scheduleAfterFailure({
    failureCount: org.billing_failure_count,
    periodStart: invoice?.period_start,
    when,
  });

  // The deadline is set once, by the first failure. Later attempts must not
  // push it out, or a fleet could be chased indefinitely without ever
  // reaching the date it was promised.
  const graceUntil = org.billing_grace_until ? asDate(new Date(org.billing_grace_until)) : schedule.graceUntil;

  await db.query(
    `UPDATE organizations
        SET subscription_status = 'past_due',
            billing_retry_at = $2,
            billing_grace_until = $3,
            updated_at = NOW()
      WHERE id = $1`, [organizationId, schedule.retryAt, graceUntil]);

  const notice = await sendNotice({
    org: { ...org, billing_grace_until: graceUntil },
    invoice,
    reason,
    attemptsLeft: schedule.attemptsLeft,
    graceUntil,
    db,
  });

  return { ...schedule, graceUntil, notice };
}

/**
 * Record a payment that went through: clear the chase and give access back.
 *
 * This is the half that was missing in both directions. A fleet that pays is
 * marked active on the column the paywall actually reads, so a paid-up
 * customer can no longer be locked out the day its trial happens to expire.
 */
async function recordSuccess({ organizationId, nextBillingDate = null, db = pgDb }) {
  const { rows } = await db.query(
    `UPDATE organizations
        SET subscription_status = 'active',
            status = CASE WHEN status IN ('trialing', 'past_due', 'suspended', 'cancelled') THEN 'active' ELSE status END,
            billing_failure_count = 0,
            billing_retry_at = NULL,
            billing_grace_until = NULL,
            billing_last_notice = NULL,
            next_billing_date = COALESCE($2, next_billing_date),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, subscription_status, next_billing_date`,
    [organizationId, nextBillingDate]);
  return rows[0] || null;
}

/**
 * Pause the fleets whose grace period has run out.
 *
 * Suspension writes `status`, which is what the paywall reads; the data is
 * untouched and the tracker keeps reporting, so restoring an account is one
 * successful charge rather than a restore.
 */
async function suspendExpired({ when = new Date(), db = pgDb } = {}) {
  const today = asDate(when);
  const { rows } = await db.query(
    `SELECT id, name, billing_failure_count, billing_card_last4, billing_card_brand,
            billing_grace_until, billing_last_notice
       FROM organizations
      WHERE subscription_status = 'past_due'
        AND billing_grace_until IS NOT NULL
        AND billing_grace_until < $1
        AND status <> 'suspended'
      ORDER BY id`, [today]);

  const suspended = [];
  for (const org of rows) {
    try {
      await db.query(`UPDATE organizations SET status = 'suspended', billing_retry_at = NULL, updated_at = NOW() WHERE id = $1`, [org.id]);
      const { rows: invoiceRows } = await db.query(
        `SELECT amount, description, failure_reason FROM subscription_invoices
          WHERE organization_id = $1 AND status = 'failed'
          ORDER BY created_at DESC LIMIT 1`, [org.id]);
      await sendNotice({
        org,
        invoice: invoiceRows[0] || null,
        reason: invoiceRows[0]?.failure_reason || null,
        attemptsLeft: 0,
        graceUntil: org.billing_grace_until,
        suspended: true,
        db,
      });
      suspended.push(org.id);
    } catch (e) {
      // One fleet failing to suspend must not leave the rest unprocessed.
      console.error(`[subscription-dunning] could not suspend organisation ${org.id}:`, e.message);
    }
  }
  return suspended;
}

module.exports = {
  RETRY_DAY_OFFSETS, GRACE_DAYS, MAX_ATTEMPTS,
  scheduleAfterFailure, recordFailure, recordSuccess, suspendExpired,
  billingContacts, noticeBody, sendNotice,
};

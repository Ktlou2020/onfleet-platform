'use strict';

const pgDb = require('../pgDb');
const { brand } = require('../brand');
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

// Payment terms for a client who pays by EFT, and how long after they lapse
// before access stops. Longer than the card windows on purpose: a transfer
// takes days to clear and is matched to an invoice by a person reading a bank
// statement, so the gap between "paid" and "we know it is paid" is real and
// nobody should be locked out inside it.
const EFT_TERMS_DAYS = Number(process.env.EFT_TERMS_DAYS || 14);
const EFT_FINAL_DAYS = Number(process.env.EFT_FINAL_DAYS || 10);

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
      `We were not able to collect ${money(invoice?.amount)} for your ${brand.name} subscription, after four attempts on ${card}.`,
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
    `We could not collect ${money(invoice?.amount)} for your ${brand.name} subscription${invoice?.description ? ` — ${invoice.description}` : ''}.`,
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

  // Named the brand literally, so an OnFleet fleet owner was emailed about
  // their Pillion subscription being paused.
  const title = suspended
    ? `Your ${brand.name} account has been paused`
    : attemptsLeft > 0
      ? `We could not take your ${brand.name} payment`
      : `Final notice — ${brand.name} access pauses on ${humanDate(graceUntil)}`;

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
// Where to pay. Held in app_settings rather than an env var because the
// person who needs to change it is in finance, not in a deploy pipeline, and
// an invoice that names the wrong account is worse than one that names none.
const BANK_KEYS = ['eft_bank_name', 'eft_account_name', 'eft_account_number', 'eft_branch_code'];

async function bankDetails(db = pgDb) {
  const { rows } = await db.query(
    'SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ANY($1)', [BANK_KEYS]);
  const map = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  const complete = BANK_KEYS.every((k) => String(map[k] || '').trim());
  return { ...map, complete };
}

function eftInvoiceBody({ org, invoice, dueBy, bank }) {
  const lines = [
    `Hi ${org.name},`,
    '',
    `Your ${brand.name} invoice for ${invoice.description || 'this period'} is ${money(invoice.amount)}.`,
    '',
    `Payment is due by ${humanDate(dueBy)}.`,
    '',
  ];

  if (bank.complete) {
    lines.push(
      'Bank details:',
      `  Account name:   ${bank.eft_account_name}`,
      `  Bank:           ${bank.eft_bank_name}`,
      `  Account number: ${bank.eft_account_number}`,
      `  Branch code:    ${bank.eft_branch_code}`,
      '',
      // Without this the payment lands as an unidentifiable line on a bank
      // statement and somebody spends an afternoon working out whose it is.
      `Please use ${invoice.reference} as the payment reference so we can match it to your account.`,
    );
  } else {
    // Said plainly rather than sending an invoice with a blank account
    // number, which looks like a phishing attempt and gets ignored.
    lines.push('Reply to this email for our banking details.');
  }

  lines.push('', 'Once the payment reflects we will mark the invoice as settled. Nothing changes on your account in the meantime.');
  return lines.join('\n');
}

/**
 * An invoice has been raised for an EFT client. Set the terms window and tell
 * them where to pay.
 *
 * Deliberately does not touch subscription_status. An unpaid invoice on the
 * day it is issued is not a client in arrears, and marking them past_due here
 * is precisely the bug this whole change exists to fix — it is what locked an
 * EFT client out of a platform they had done nothing wrong on.
 */
async function awaitEftSettlement({ organizationId, invoice, when = new Date(), db = pgDb }) {
  const dueBy = asDate(addDays(parseDate(invoice?.period_start, when), EFT_TERMS_DAYS));

  const { rows } = await db.query(
    `UPDATE organizations
        SET billing_grace_until = $2, billing_last_notice = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING id, name`, [organizationId, dueBy]);
  const org = rows[0];
  if (!org) return dueBy;

  const bank = await bankDetails(db);
  const contacts = await billingContacts(organizationId, db);
  for (const contact of contacts) {
    try {
      await notifier.sendNotification({
        userId: contact.id,
        channel: 'email',
        type: 'subscription_invoice_eft',
        title: `Your ${brand.name} invoice — ${money(invoice.amount)} due ${humanDate(dueBy)}`,
        message: eftInvoiceBody({ org, invoice, dueBy, bank }),
        entityType: 'organizations',
        entityId: organizationId,
        throwOnError: false,
      });
    } catch (e) {
      console.error(`[subscription-dunning] could not send EFT invoice to user ${contact.id}:`, e.message);
    }
  }
  if (!bank.complete) {
    console.warn('[subscription-dunning] EFT invoice sent without banking details — set them in app_settings');
  }
  return dueBy;
}

/**
 * EFT clients whose payment terms have run out without the money arriving.
 *
 * Only now do they become past_due, and only now does a second clock start.
 * Runs daily alongside the charge run.
 */
async function chaseEftInvoices({ when = new Date(), db = pgDb } = {}) {
  const today = asDate(when);
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.billing_grace_until, o.billing_failure_count,
            o.billing_card_last4, o.billing_card_brand, o.billing_last_notice,
            i.id AS invoice_id, i.amount, i.description, i.reference, i.period_start
       FROM organizations o
       JOIN LATERAL (
         SELECT * FROM subscription_invoices
          WHERE organization_id = o.id AND status = 'pending'
          ORDER BY period_start ASC LIMIT 1
       ) i ON TRUE
      WHERE o.billing_method = 'eft'
        AND o.subscription_status <> 'cancelled'
        AND o.status <> 'suspended'
        AND o.billing_grace_until IS NOT NULL
        AND o.billing_grace_until < $1
        AND o.subscription_status <> 'past_due'
      ORDER BY o.id`, [today]);

  const chased = [];
  for (const row of rows) {
    const finalDate = asDate(addDays(when, EFT_FINAL_DAYS));
    try {
      await db.query(
        `UPDATE organizations
            SET subscription_status = 'past_due', billing_grace_until = $2,
                billing_last_notice = NULL, updated_at = NOW()
          WHERE id = $1`, [row.id, finalDate]);

      const bank = await bankDetails(db);
      const contacts = await billingContacts(row.id, db);
      for (const contact of contacts) {
        await notifier.sendNotification({
          userId: contact.id,
          channel: 'email',
          type: 'subscription_payment_overdue',
          title: `Overdue — ${brand.name} access pauses on ${humanDate(finalDate)}`,
          message: [
            `Hi ${row.name},`,
            '',
            `We have not yet received ${money(row.amount)} for ${row.description || 'your subscription'}, which was due on ${humanDate(row.billing_grace_until)}.`,
            '',
            `If it has not reached us by ${humanDate(finalDate)}, the account is paused until it does.`,
            '',
            bank.complete
              ? `Reference ${row.reference}, paid to ${bank.eft_account_name} at ${bank.eft_bank_name}, account ${bank.eft_account_number}, branch ${bank.eft_branch_code}.`
              : `Reference ${row.reference}. Reply to this email for our banking details.`,
            '',
            'If you have already paid, reply with the proof of payment and we will hold the account while we match it.',
          ].join('\n'),
          entityType: 'organizations',
          entityId: row.id,
          throwOnError: false,
        });
      }
      chased.push(row.id);
    } catch (e) {
      console.error(`[subscription-dunning] could not chase organisation ${row.id}:`, e.message);
    }
  }
  return chased;
}

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
        -- Somebody has said in as many words that this account is not to be
        -- cut off yet: proof of payment is in hand, or terms were agreed. A
        -- dated override rather than a flag, so it expires by itself instead
        -- of quietly exempting a client forever.
        AND (billing_hold_until IS NULL OR billing_hold_until < $1)
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
  awaitEftSettlement, chaseEftInvoices, bankDetails, eftInvoiceBody,
  EFT_TERMS_DAYS, EFT_FINAL_DAYS, BANK_KEYS,
};

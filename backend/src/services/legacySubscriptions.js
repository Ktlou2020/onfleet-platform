'use strict';

/**
 * Winding down the flat monthly subscriptions.
 *
 * Cancelling at Paystack stops the next charge and leaves the period already
 * paid for intact, so there is nothing to schedule — disabling now is
 * cancelling at period end. The work is in what happens around it.
 *
 * Two ways to get this wrong, and both cost somebody money.
 *
 * Charging twice. A fleet already moved onto per-bike with a card on file
 * would be invoiced by our own run for days the flat plan had already paid
 * for. So the cancel sets next_billing_date to the date the paid period runs
 * out, and our run picks them up the day after it, not before.
 *
 * Charging nothing. A fleet with no tier and no card is invisible to our
 * billing run; cancel their flat plan and they use the platform free until
 * somebody notices. That is a commercial decision, not a bug, so this
 * refuses to do it silently: readiness is reported per fleet, and cancelling
 * one that is not ready has to be asked for explicitly.
 */

const axios = require('axios');
const pgDb = require('../pgDb');
const notifier = require('./notifierPg');
const { brand } = require('../brand');

const PAYSTACK_API = 'https://api.paystack.co';

const fmtDate = (d) => (d
  ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })
  : 'the end of the current period');

/**
 * Paystack, behind a seam. Injectable so the tests can assert what we would
 * have done to a customer's subscription without doing it to one.
 */
const liveClient = {
  async fetch(code) {
    const { data } = await axios.get(`${PAYSTACK_API}/subscription/${encodeURIComponent(code)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    return data.data;
  },
  async disable(code, token) {
    await axios.post(`${PAYSTACK_API}/subscription/disable`, { code, token },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
  },
};

/**
 * Every fleet still on a flat plan, and whether cancelling it would leave
 * them paying nothing.
 *
 * `ready` means our billing run can actually charge them once the flat plan
 * stops: a tier to price, and either a card or an EFT arrangement. It is the
 * column to read before cancelling anything.
 */
async function list({ db = pgDb } = {}) {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.plan_key, o.status, o.subscription_status,
            o.paystack_subscription_code, o.subscription_tier, o.billing_method,
            o.legacy_subscription_ends_at, o.legacy_subscription_cancelled_at,
            (o.billing_authorization_encrypted IS NOT NULL) AS has_card,
            (SELECT COUNT(*) FROM bikes b
              WHERE b.organization_id = o.id AND b.status NOT IN ('sold','written_off')) AS bikes
       FROM organizations o
      WHERE o.paystack_subscription_code IS NOT NULL
      ORDER BY o.name`);

  return rows.map((r) => {
    const canBeCharged = !!r.subscription_tier
      && (r.has_card || r.billing_method === 'eft');
    return {
      id: r.id,
      name: r.name,
      plan_key: r.plan_key,
      status: r.status,
      subscription_code: r.paystack_subscription_code,
      subscription_tier: r.subscription_tier,
      billing_method: r.billing_method,
      has_card: r.has_card,
      bikes: Number(r.bikes),
      ready: canBeCharged,
      // Said in words, because "ready: false" does not tell anybody what to
      // go and do about it.
      blocker: canBeCharged ? null
        : !r.subscription_tier ? 'No per-bike plan set — they would be on Basic and billed nothing'
          : 'No card on file and not set to EFT — nothing could be charged',
      ends_at: r.legacy_subscription_ends_at,
      cancelled_at: r.legacy_subscription_cancelled_at,
    };
  });
}

function noticeBody({ org, endsAt }) {
  return [
    `Hi ${org.name},`,
    '',
    `We have cancelled your old flat monthly ${brand.name} plan. Nothing changes before ${fmtDate(endsAt)} — you have paid up to then and your account carries on exactly as it is.`,
    '',
    `From ${fmtDate(endsAt)} your account moves to per-bike pricing, which is what everyone is on now. You pay for the bikes you actually have, so the amount follows your fleet rather than a band.`,
    '',
    'You can see your plan, your price at your own bike count, and your invoices under Subscription in the portal.',
    '',
    'Nothing has been deleted and nobody loses access. If anything looks wrong, reply to this email.',
  ].join('\n');
}

/**
 * Cancel one fleet's flat plan.
 *
 * `force` is required to cancel a fleet our billing run could not then
 * charge. Not a safety rail against mistakes so much as against drift: it is
 * the difference between deciding to give somebody a free month and not
 * noticing you had.
 */
async function cancelOne(organizationId, {
  actorId = null, force = false, client = liveClient, db = pgDb, notify = true,
} = {}) {
  const all = await list({ db });
  const org = all.find((o) => o.id === Number(organizationId));
  if (!org) return { ok: false, status: 404, error: 'That fleet has no flat subscription' };
  if (org.cancelled_at) {
    return { ok: false, status: 409, error: 'That plan has already been cancelled', ends_at: org.ends_at };
  }
  if (!org.ready && !force) {
    return { ok: false, status: 409, code: 'NOT_READY', error: org.blocker };
  }

  let endsAt = null;
  try {
    const sub = await client.fetch(org.subscription_code);
    if (!sub?.email_token) throw new Error('Paystack returned no email_token for that subscription');
    endsAt = sub.next_payment_date ? String(sub.next_payment_date).slice(0, 10) : null;
    await client.disable(org.subscription_code, sub.email_token);
  } catch (e) {
    const detail = e.response?.data?.message || e.message;
    return { ok: false, status: 502, error: `Paystack would not cancel it: ${detail}` };
  }

  // next_billing_date is the handover. Our run charges from the day the paid
  // period ends, so nobody is billed twice for the overlap. The subscription
  // code is cleared because it no longer refers to anything live, and leaving
  // it would keep the fleet on this list forever.
  await db.query(
    `UPDATE organizations
        SET paystack_subscription_code = NULL,
            legacy_subscription_ends_at = $2,
            legacy_subscription_cancelled_at = NOW(),
            next_billing_date = COALESCE($2::date, next_billing_date),
            updated_at = NOW()
      WHERE id = $1`, [org.id, endsAt]);

  if (notify) {
    try {
      const dunning = require('./subscriptionDunning');
      const contacts = await dunning.billingContacts(org.id, db);
      for (const contact of contacts) {
        await notifier.sendNotification({
          userId: contact.id,
          channel: 'email',
          type: 'subscription_plan_changed',
          title: `Your ${brand.name} plan is moving to per-bike pricing`,
          message: noticeBody({ org, endsAt }),
          entityType: 'organizations',
          entityId: org.id,
          throwOnError: false,
        });
      }
    } catch (e) {
      // The cancellation is done and must not be reported as failed because
      // an email did not go out.
      console.error(`[legacy-subscriptions] could not notify organisation ${org.id}:`, e.message);
    }
  }

  console.log(`[legacy-subscriptions] cancelled ${org.name} (${org.plan_key}), paid to ${endsAt || 'unknown'}`);
  return { ok: true, organization_id: org.id, name: org.name, ends_at: endsAt, forced: !org.ready, actorId };
}

/**
 * Cancel several, each on its own. One fleet's failure — a subscription
 * Paystack has already lost, a network blip — must not stop the rest, and
 * every outcome comes back so the operator can see what still needs doing.
 */
async function cancelMany(ids, options = {}) {
  const results = [];
  for (const id of ids) {
    try {
      results.push({ id, ...(await cancelOne(id, options)) });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return {
    cancelled: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = { list, cancelOne, cancelMany, noticeBody, liveClient };

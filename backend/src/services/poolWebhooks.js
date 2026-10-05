'use strict';

/**
 * Pushing pool finance to the funder who paid for the bikes.
 *
 * Three events, and the split between them is deliberate:
 *
 *   pool.payment_received    a delta — cash arrived, here is the receipt
 *   pool.composition_changed a delta — bikes moved into or out of the tranche
 *   pool.daily_summary       a position — the whole summary block, once a day
 *
 * Deltas do not carry the pool's position and the position does not carry
 * deltas. Putting a freshly computed summary on every payment would look
 * generous and would mean two events arriving a second apart disagreeing with
 * each other about the same pool, which is worse than making the receiver ask.
 *
 * WHY PAYMENTS ARE SWEPT RATHER THAN HOOKED
 *
 * A payment becomes successful through at least five paths — the Paystack
 * webhook, the charge queue, subscription billing, a manual admin record, and
 * a back-office correction. Hooking each one means the sixth path somebody
 * adds next year silently stops telling the funder about money.
 *
 * So this sweeps instead: every successful payment on a pool bike inside a
 * lookback window, every minute. The unique (endpoint_id, event_id) index on
 * webhook_deliveries makes re-queueing the same payment a no-op, so the sweep
 * can be as repetitive as it likes. It also means a payment inserted as
 * pending and marked successful an hour later is caught when it succeeds,
 * which a watermark on the payment id would have missed entirely.
 *
 * An endpoint never receives anything that happened before it was created.
 * Otherwise registering a URL would fire a week of history at it, and a
 * funder's first impression of the feed would be a burst of payments they had
 * already reconciled by hand.
 */

const pgDb = require('../pgDb');
const poolFinance = require('./poolFinance');
const dispatcher = require('./webhookDispatcher');

const POOL_EVENTS = {
  PAYMENT: 'pool.payment_received',
  COMPOSITION: 'pool.composition_changed',
  SUMMARY: 'pool.daily_summary',
};
const ALL_POOL_EVENTS = Object.values(POOL_EVENTS);

// How far back the payment sweep looks. Generous on purpose: the cost of a
// wide window is a few rows the dedup index throws away, and the cost of a
// narrow one is a late-settling payment the funder never hears about.
const LOOKBACK_DAYS = Number(process.env.POOL_WEBHOOK_LOOKBACK_DAYS || 7);

/**
 * Funder endpoints subscribed to this pool and this event type.
 *
 * The two feeds never cross, but the two directions are held apart by
 * different things and it is worth being precise about which:
 *
 *   A funder never receives an alarm — and so never receives a rider's name
 *   or phone number — because the alert dispatcher selects
 *   `scope = 'platform'`. That clause is the only thing standing there;
 *   removing it delivers theft alerts to the funder's URL.
 *
 *   A control room never receives money events because its endpoint has NULL
 *   pool_ids, which the check constraint guarantees for every non-funder
 *   scope, and `NULL @> ARRAY[n]` is not true. The `scope = 'funder'` below
 *   is belt-and-braces on top of that rather than the mechanism: a mutation
 *   removing it changes no behaviour while the constraint holds.
 */
async function endpointsFor(poolId, eventType) {
  const { rows } = await pgDb.query(
    `SELECT * FROM webhook_endpoints
      WHERE active = TRUE AND scope = 'funder' AND pool_ids @> ARRAY[$1]::integer[]`,
    [Number(poolId)]);
  // NULL event_types means every pool event, the same default the alert
  // dispatcher uses, so an event added later is not silently withheld.
  return rows.filter((e) => {
    if (!e.event_types) return true;
    return String(e.event_types).split(',').map((s) => s.trim()).filter(Boolean).includes(eventType);
  });
}

async function queueTo(endpoint, body) {
  const { rows } = await pgDb.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, event_id, payload)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint_id, event_id) DO NOTHING
     RETURNING id`,
    [endpoint.id, body.event_type, body.event_id, JSON.stringify(body)]);
  return rows.length > 0;
}

function poolBlock(pool) {
  return {
    id: pool.id,
    name: pool.name,
    reference: pool.reference,
    funder: pool.funder,
  };
}

/**
 * Every successful payment on a pooled bike inside the window, offered to
 * every funder endpoint that covers that pool and was created before the
 * money arrived. Already-delivered ones fall out on the dedup index.
 */
async function sweepPayments({ lookbackDays = LOOKBACK_DAYS } = {}) {
  const { rows: payments } = await pgDb.query(
    `SELECT p.id, p.amount, p.fee_amount, p.net_amount, p.method, p.reference,
            p.paystack_reference, p.paid_at, p.created_at,
            COALESCE(p.paid_at, p.created_at) AS received_at,
            b.id AS bike_id, b.registration, b.pool_id,
            a.agreement_no, ps.week_number, ps.due_date,
            pool.name AS pool_name, pool.reference AS pool_reference, pool.funder
       FROM payments p
       JOIN agreements a ON a.id = p.agreement_id
       JOIN bikes b ON b.id = a.bike_id
       JOIN bike_pools pool ON pool.id = b.pool_id
       LEFT JOIN payment_schedules ps ON ps.id = p.schedule_id
      WHERE p.status = 'success'
        AND COALESCE(p.paid_at, p.created_at) >= NOW() - ($1 || ' days')::interval
      ORDER BY COALESCE(p.paid_at, p.created_at) ASC, p.id ASC`,
    [String(lookbackDays)]);

  let queued = 0;
  for (const row of payments) {
    const targets = await endpointsFor(row.pool_id, POOL_EVENTS.PAYMENT);
    for (const endpoint of targets) {
      // Nothing that happened before the endpoint existed. Registering a URL
      // should not replay a week the funder has already reconciled.
      if (new Date(row.received_at) < new Date(endpoint.created_at)) continue;

      const body = {
        event_id: `pool-payment-${row.id}`,
        event_type: POOL_EVENTS.PAYMENT,
        occurred_at: row.received_at,
        sent_at: new Date().toISOString(),
        pool: {
          id: row.pool_id,
          name: row.pool_name,
          reference: row.pool_reference,
          funder: row.funder,
        },
        payment: {
          id: row.id,
          paid_at: row.received_at,
          amount_gross: poolFinance.money(row.amount),
          processing_fee: poolFinance.money(row.fee_amount),
          // net_amount is written only for Paystack; cash and EFT store 0,
          // which is not the same as nothing having arrived.
          amount_net: poolFinance.money(row.net_amount || row.amount),
          method: row.method,
          reference: row.reference,
          provider_reference: row.paystack_reference,
        },
        vehicle: { id: row.bike_id, registration: row.registration },
        agreement_no: row.agreement_no,
        week_number: row.week_number,
        week_due_date: row.due_date,
      };
      if (await queueTo(endpoint, body)) queued += 1;
    }
  }

  if (queued) setImmediate(() => dispatcher.flush().catch(() => {}));
  return queued;
}

/**
 * Bikes moved into or out of a tranche. Emitted from the admin routes that do
 * the moving rather than swept, because that is the only place it happens and
 * the actor is known there.
 *
 * The event_id carries a timestamp: unlike a payment, the same bike can
 * legitimately move in and out repeatedly, and each move is its own fact.
 */
async function emitCompositionChanged(poolId, { added = [], removed = [], at = new Date() } = {}) {
  if (!added.length && !removed.length) return 0;
  const pool = await poolFinance.getPool(poolId);
  if (!pool) return 0;

  const targets = await endpointsFor(poolId, POOL_EVENTS.COMPOSITION);
  if (!targets.length) return 0;

  const body = {
    event_id: `pool-composition-${poolId}-${at.getTime()}`,
    event_type: POOL_EVENTS.COMPOSITION,
    occurred_at: at.toISOString(),
    sent_at: new Date().toISOString(),
    pool: poolBlock(pool),
    added: added.map((b) => ({ id: b.id, registration: b.registration })),
    removed: removed.map((b) => ({ id: b.id, registration: b.registration })),
  };

  let queued = 0;
  for (const endpoint of targets) {
    if (await queueTo(endpoint, body)) queued += 1;
  }
  if (queued) setImmediate(() => dispatcher.flush().catch(() => {}));
  return queued;
}

/**
 * The whole position, once a day.
 *
 * This is what makes the absence of per-event pushes for theft, write-off and
 * default tolerable rather than a hole: capital_at_risk, arrears and the
 * collection rate all move here the next morning. A funder who needs to know
 * within the hour that a bike was stolen should be told by a person, not by
 * a webhook.
 *
 * Idempotent per pool per day, so a restarted container or a second cron fire
 * cannot send two.
 */
async function sendDailySummaries({ at = new Date() } = {}) {
  const day = at.toISOString().slice(0, 10);
  const pools = await poolFinance.list({});

  let queued = 0;
  for (const pool of pools) {
    const targets = await endpointsFor(pool.id, POOL_EVENTS.SUMMARY);
    if (!targets.length) continue;

    const body = {
      event_id: `pool-summary-${pool.id}-${day}`,
      event_type: POOL_EVENTS.SUMMARY,
      occurred_at: at.toISOString(),
      sent_at: new Date().toISOString(),
      as_at_date: day,
      pool: poolBlock(pool),
      summary: pool.summary,
    };
    for (const endpoint of targets) {
      if (new Date(endpoint.created_at) > at) continue;
      if (await queueTo(endpoint, body)) queued += 1;
    }
  }

  if (queued) setImmediate(() => dispatcher.flush().catch(() => {}));
  return queued;
}

module.exports = {
  sweepPayments, emitCompositionChanged, sendDailySummaries,
  endpointsFor, POOL_EVENTS, ALL_POOL_EVENTS, LOOKBACK_DAYS,
};

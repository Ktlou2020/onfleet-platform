'use strict';

const pgDb = require('../pgDb');

/**
 * The financial position of a bike pool.
 *
 * One place for this arithmetic, because it is about to be read by somebody
 * outside the company who is reconciling it against their own books. A number
 * that means one thing on the admin dashboard and a slightly different thing
 * in the funder's API is the kind of difference that is discovered during an
 * argument about money.
 *
 * Two rules the shape of this file follows:
 *
 * Every total is summed in JavaScript from the same per-bike rows the API
 * returns as the breakdown. It would be faster to let Postgres aggregate
 * separately, and then the header could disagree with the rows beneath it. A
 * funder who adds up the breakdown and gets a different answer than the
 * summary stops trusting the whole response, and they are right to.
 *
 * Collected and allocated are likewise kept apart. A payment is cash that
 * arrived; an allocation is that cash applied to a particular week of a
 * rider's schedule. They are usually the same total and sometimes are not —
 * a rider pays four weeks ahead, or a receipt has not been reconciled yet —
 * and a pool reporting money collected alongside a collection rate of zero
 * is confusing rather than wrong. unallocated_cash is the gap, named.
 *
 * Gross and net are always reported separately and never mixed. The rider
 * pays gross; Paystack takes a fee; net is what actually lands in the bank.
 * Reconciling against a bank statement needs net. Checking whether a rider
 * met their obligation needs gross. Collapsing them into "collected" makes
 * one of those two questions unanswerable.
 */

// Postgres returns numeric as a string, deliberately, so that money does not
// silently pass through a float. We do the conversion in exactly one place.
const money = (v) => Math.round(Number(v || 0) * 100) / 100;
const int = (v) => Number(v || 0);

// Arrears are bucketed by how long the money has been late. Past 90 days the
// collections team's own playbook stops escalating and starts writing off, so
// that is where the last bucket opens rather than at some rounder number.
const AGE_BUCKETS = [
  { key: 'days_1_30', from: 1, to: 30 },
  { key: 'days_31_60', from: 31, to: 60 },
  { key: 'days_61_90', from: 61, to: 90 },
  { key: 'days_90_plus', from: 91, to: null },
];

const bucketSql = AGE_BUCKETS.map(({ key, from, to }) => {
  const range = to === null
    ? `(CURRENT_DATE - ps.due_date) >= ${from}`
    : `(CURRENT_DATE - ps.due_date) BETWEEN ${from} AND ${to}`;
  return `COALESCE(SUM(GREATEST(ps.amount_due - ps.amount_paid, 0)) FILTER (
            WHERE ps.due_date < CURRENT_DATE
              AND ps.status NOT IN ('paid', 'waived')
              AND ${range}), 0) AS arrears_${key}`;
}).join(',\n         ');

// A cancelled agreement never ran, so it is not a commitment anybody is owed
// against. Money that was actually paid under one before it was cancelled did
// still arrive, and is counted in the payments lateral below — which is why
// collected can, rarely and correctly, exceed contracted on a single bike.
const LIVE_AGREEMENT = `a.status <> 'cancelled'`;

const BIKE_ROWS_SQL = `
  SELECT b.id, b.registration, b.vin, b.make, b.model, b.status, b.purchase_price,
         b.organization_id, o.name AS organization_name,
         ag.contracted, ag.weeks_contracted, ag.agreements_count,
         pay.collected_gross, pay.collected_net, pay.last_payment_at,
         sch.billed_to_date, sch.collected_billed, sch.weeks_paid, sch.allocated_total,
         ${AGE_BUCKETS.map((b2) => `sch.arrears_${b2.key}`).join(', ')},
         cur.agreement_no, cur.agreement_status, cur.start_date, cur.end_date
    FROM bikes b
    LEFT JOIN organizations o ON o.id = b.organization_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.total_amount), 0) AS contracted,
             COALESCE(SUM(a.total_weeks), 0)  AS weeks_contracted,
             COUNT(*)                         AS agreements_count
        FROM agreements a WHERE a.bike_id = b.id AND ${LIVE_AGREEMENT}
    ) ag ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(p.amount), 0) AS collected_gross,
             -- net_amount is only populated for Paystack; a cash or EFT
             -- payment has no fee and stores 0, which must not be read as
             -- "nothing arrived".
             COALESCE(SUM(COALESCE(NULLIF(p.net_amount, 0), p.amount)), 0) AS collected_net,
             MAX(p.paid_at) AS last_payment_at
        FROM payments p
        JOIN agreements a ON a.id = p.agreement_id
       WHERE a.bike_id = b.id AND p.status = 'success'
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(ps.amount_due) FILTER (
               WHERE ps.due_date <= CURRENT_DATE AND ps.status <> 'waived'), 0) AS billed_to_date,
             COALESCE(SUM(ps.amount_paid) FILTER (
               WHERE ps.due_date <= CURRENT_DATE AND ps.status <> 'waived'), 0) AS collected_billed,
             COUNT(*) FILTER (WHERE ps.status = 'paid') AS weeks_paid,
             -- Every week's allocation, not just the weeks already due. The
             -- difference between this and what the payments table says was
             -- received is cash that has not been applied to a week yet.
             COALESCE(SUM(ps.amount_paid), 0) AS allocated_total,
             ${bucketSql}
        FROM payment_schedules ps
        JOIN agreements a ON a.id = ps.agreement_id
       WHERE a.bike_id = b.id AND ${LIVE_AGREEMENT}
    ) sch ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.agreement_no, a.status AS agreement_status, a.start_date, a.end_date
        FROM agreements a
       WHERE a.bike_id = b.id AND a.status = 'active'
       ORDER BY a.id DESC LIMIT 1
    ) cur ON TRUE
   WHERE b.pool_id = $1
   ORDER BY b.registration ASC, b.id ASC`;

// A bike in one of these states is not going to finish paying itself off. The
// outstanding balance on it is capital the funder is unlikely to see back
// through collections, so it is reported on its own rather than buried in a
// total that looks like it is merely behind.
const WRITTEN_OFF_STATUSES = ['stolen', 'written_off'];

function bikeFinance(row) {
  const contracted = money(row.contracted);
  const collectedGross = money(row.collected_gross);
  const collectedNet = money(row.collected_net);
  const billed = money(row.billed_to_date);
  const collectedBilled = money(row.collected_billed);
  const arrears = {};
  let arrearsTotal = 0;
  for (const { key } of AGE_BUCKETS) {
    const amount = money(row[`arrears_${key}`]);
    arrears[key] = amount;
    arrearsTotal = money(arrearsTotal + amount);
  }

  return {
    bike_id: row.id,
    registration: row.registration,
    vin: row.vin,
    make: row.make,
    model: row.model,
    bike_status: row.status,
    owner: row.organization_id
      ? { type: 'fleet_owner', id: row.organization_id, name: row.organization_name }
      : { type: 'platform', id: null, name: null },
    cost_basis: money(row.purchase_price),
    // Null rather than an empty object when the bike is sitting in stock —
    // "no agreement" and "an agreement worth nothing" are different facts.
    current_agreement: row.agreement_no ? {
      agreement_no: row.agreement_no,
      status: row.agreement_status,
      start_date: row.start_date,
      end_date: row.end_date,
    } : null,
    agreements_to_date: int(row.agreements_count),
    contracted_total: contracted,
    collected_gross: collectedGross,
    collected_net: collectedNet,
    processing_fees: money(collectedGross - collectedNet),
    outstanding: money(contracted - collectedGross),
    billed_to_date: billed,
    collected_against_billed: collectedBilled,
    arrears_total: arrearsTotal,
    arrears_by_age: arrears,
    weeks_contracted: int(row.weeks_contracted),
    weeks_paid: int(row.weeks_paid),
    allocated_to_weeks: money(row.allocated_total),
    unallocated_cash: money(collectedGross - money(row.allocated_total)),
    last_payment_at: row.last_payment_at,
    capital_at_risk: WRITTEN_OFF_STATUSES.includes(row.status)
      ? money(contracted - collectedGross)
      : 0,
  };
}

function summarise(bikes, pool) {
  const sum = (field) => money(bikes.reduce((total, b) => total + b[field], 0));
  const contracted = sum('contracted_total');
  const collectedGross = sum('collected_gross');
  const billed = sum('billed_to_date');
  const collectedBilled = sum('collected_against_billed');

  const arrearsByAge = {};
  for (const { key } of AGE_BUCKETS) {
    arrearsByAge[key] = money(bikes.reduce((total, b) => total + b.arrears_by_age[key], 0));
  }

  const byStatus = {};
  for (const b of bikes) byStatus[b.bike_status] = (byStatus[b.bike_status] || 0) + 1;

  const capitalAdvanced = pool.capital_advanced == null ? null : money(pool.capital_advanced);

  return {
    bikes: bikes.length,
    bikes_by_status: byStatus,
    bikes_earning: bikes.filter((b) => b.current_agreement).length,
    capital_advanced: capitalAdvanced,
    cost_basis: sum('cost_basis'),
    contracted_total: contracted,
    collected_gross: collectedGross,
    collected_net: sum('collected_net'),
    processing_fees: sum('processing_fees'),
    outstanding: money(contracted - collectedGross),
    // Against the money the funder put in rather than against the contracts,
    // because that is the question they are actually asking: am I whole yet.
    recovered_against_capital: capitalAdvanced
      ? money(sum('collected_net') - capitalAdvanced)
      : null,
    capital_recovery_pct: capitalAdvanced
      ? Math.round((sum('collected_net') / capitalAdvanced) * 1000) / 10
      : null,
    paid_off_pct: contracted > 0 ? Math.round((collectedGross / contracted) * 1000) / 10 : null,
    billed_to_date: billed,
    collected_against_billed: collectedBilled,
    arrears_total: money(billed - collectedBilled > 0 ? billed - collectedBilled : 0),
    arrears_by_age: arrearsByAge,
    // Of everything that has fallen due, how much actually came in. The single
    // number that says whether this pool is performing.
    collection_rate_pct: billed > 0 ? Math.round((collectedBilled / billed) * 1000) / 10 : null,
    capital_at_risk: sum('capital_at_risk'),
    // Cash received that has not been applied to a week of the schedule.
    //
    // This exists because a pool can honestly report money collected and a
    // collection rate of zero at the same time, and without this field there
    // is no way to tell which number to believe. Payments are what arrived;
    // the schedule is what has been reconciled against a week. A rider paying
    // several weeks ahead puts this legitimately above zero. A large and
    // growing figure means receipts are not being allocated, and the
    // collection rate is understating how the pool is really doing.
    collected_allocated: sum('allocated_to_weeks'),
    unallocated_cash: sum('unallocated_cash'),
    weeks_contracted: bikes.reduce((t, b) => t + b.weeks_contracted, 0),
    weeks_paid: bikes.reduce((t, b) => t + b.weeks_paid, 0),
    last_payment_at: bikes.reduce(
      (latest, b) => (b.last_payment_at && (!latest || b.last_payment_at > latest) ? b.last_payment_at : latest),
      null),
  };
}

function poolShape(pool) {
  return {
    id: pool.id,
    name: pool.name,
    reference: pool.reference,
    funder: pool.funder,
    status: pool.status,
    advanced_on: pool.advanced_on,
    organization: pool.organization_id
      ? { id: pool.organization_id, name: pool.organization_name }
      : null,
    created_at: pool.created_at,
  };
}

async function getPool(poolId) {
  const { rows } = await pgDb.query(
    `SELECT p.*, o.name AS organization_name
       FROM bike_pools p
       LEFT JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = $1`, [poolId]);
  return rows[0] || null;
}

/** Every bike in the pool with its own position. The breakdown the totals are built from. */
async function bikePositions(poolId) {
  const { rows } = await pgDb.query(BIKE_ROWS_SQL, [poolId]);
  return rows.map(bikeFinance);
}

/** One pool, in full: the pool record, the summary, and the per-bike rows. */
async function position(poolId) {
  const pool = await getPool(poolId);
  if (!pool) return null;
  const bikes = await bikePositions(poolId);
  return { pool: poolShape(pool), summary: summarise(bikes, pool), bikes };
}

/**
 * Several pools with their summaries but without the per-bike detail.
 *
 * `poolIds` null means no restriction; an empty array means a key allowed to
 * see nothing, which must return nothing rather than everything. Postgres
 * gets the empty case right on its own — `= ANY('{}')` matches no rows — so
 * the early return below is for legibility and one saved query, not because
 * the query would be wrong without it. The distinction is worth stating
 * somewhere, because "restricted to nothing" and "no restriction" looking
 * alike under a truthiness check is how this kind of bug usually starts.
 */
async function list({ poolIds = null, orgId = null, status = null } = {}) {
  if (Array.isArray(poolIds) && poolIds.length === 0) return [];

  const params = [];
  const where = [];
  if (Array.isArray(poolIds)) { params.push(poolIds); where.push(`p.id = ANY($${params.length})`); }
  if (orgId != null) { params.push(orgId); where.push(`p.organization_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`p.status = $${params.length}`); }

  const { rows: pools } = await pgDb.query(
    `SELECT p.*, o.name AS organization_name
       FROM bike_pools p
       LEFT JOIN organizations o ON o.id = p.organization_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC, p.id DESC`, params);

  const out = [];
  for (const pool of pools) {
    const bikes = await bikePositions(pool.id);
    out.push({ ...poolShape(pool), summary: summarise(bikes, pool) });
  }
  return out;
}

/**
 * The transaction feed, for a funder reconciling against their bank.
 *
 * Deliberately payment-level and deliberately without a rider on it. A funder
 * matching a bank statement needs the date, the amount, the fee and a
 * reference; they do not need to know who was riding, and that is not ours to
 * hand out to answer a question about money.
 */
async function payments(poolId, { since = null, limit = 500 } = {}) {
  const params = [poolId, Math.min(Number(limit) || 500, 2000)];
  let sinceClause = '';
  if (since) {
    params.push(since.toISOString());
    sinceClause = `AND COALESCE(p.paid_at, p.created_at) >= $${params.length}`;
  }

  const { rows } = await pgDb.query(
    `SELECT p.id, p.amount, p.fee_amount, p.net_amount, p.method, p.reference,
            p.paystack_reference, p.status, p.paid_at, p.created_at,
            b.id AS bike_id, b.registration,
            a.agreement_no, ps.week_number, ps.due_date
       FROM payments p
       JOIN agreements a ON a.id = p.agreement_id
       JOIN bikes b ON b.id = a.bike_id
       LEFT JOIN payment_schedules ps ON ps.id = p.schedule_id
      WHERE b.pool_id = $1 AND p.status = 'success' ${sinceClause}
      ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC
      LIMIT $2`, params);

  return rows.map((r) => ({
    id: r.id,
    paid_at: r.paid_at || r.created_at,
    amount_gross: money(r.amount),
    processing_fee: money(r.fee_amount),
    amount_net: money(r.net_amount || r.amount),
    method: r.method,
    reference: r.reference,
    provider_reference: r.paystack_reference,
    vehicle: { id: r.bike_id, registration: r.registration },
    agreement_no: r.agreement_no,
    week_number: r.week_number,
    week_due_date: r.due_date,
  }));
}

module.exports = {
  list, position, payments, bikePositions,
  summarise, bikeFinance, poolShape, getPool,
  AGE_BUCKETS, WRITTEN_OFF_STATUSES, money,
};

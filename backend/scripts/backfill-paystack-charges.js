'use strict';

// Loads Paystack debit-order charges that never reached a rider's account into
// the review queue, where staff confirm or dismiss them. It credits nothing.
//
// The webhook dropped every subscription charge for platform riders until the
// queue existed. Staff typed most of them in by hand, without the Paystack
// reference, so a charge only counts as missing here when there is no payment
// for that rider within 14 days of it, with a gross or net amount within R30.
// Each recorded payment can account for at most one charge, so two weekly
// charges can't both hide behind a single manual entry.
//
// Fleet-organisation riders are skipped (their charges go through their own
// wallet path), as are charges from fleet organisations paying for their plan.
//
//   node scripts/backfill-paystack-charges.js                    # dry run from 2026-06-01
//   SINCE=2026-05-01 node scripts/backfill-paystack-charges.js   # a different start date
//   APPLY=yes node scripts/backfill-paystack-charges.js          # queue them

const axios = require('axios');
const pgDb = require('../src/pgDb');
const { queueCharge } = require('../src/services/paystackChargeQueue');

const APPLY = process.env.APPLY === 'yes';
const SINCE = process.env.SINCE || '2026-06-01';

async function successfulChargesSince(since) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const { data } = await axios.get('https://api.paystack.co/transaction', {
      params: { status: 'success', from: `${since}T00:00:00Z`, perPage: 100, page },
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      timeout: 30000,
    });
    const rows = data?.data || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all.sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));
}

(async () => {
  if (!process.env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not set');
  const charges = await successfulChargesSince(SINCE);
  const used = new Set();
  const missing = [];
  const skipped = { recorded: 0, matched: 0, fleet_rider: 0, organisation: 0, queued_already: 0 };

  for (const tx of charges) {
    const gross = tx.amount / 100;
    const email = tx.customer?.email || '';

    const { rows: byRef } = await pgDb.query('SELECT id FROM payments WHERE paystack_reference = $1 OR reference = $1 LIMIT 1', [tx.reference]);
    if (byRef[0]) { used.add(byRef[0].id); skipped.recorded++; continue; }

    const { rows: queued } = await pgDb.query('SELECT 1 FROM paystack_charges WHERE reference = $1', [tx.reference]);
    if (queued[0]) { skipped.queued_already++; continue; }

    const { rows: users } = await pgDb.query('SELECT id, full_name, organization_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    const user = users[0];
    if (user?.organization_id) { skipped.fleet_rider++; continue; }
    if (!user) {
      const { rows: orgs } = await pgDb.query('SELECT 1 FROM organizations WHERE LOWER(contact_email) = LOWER($1) LIMIT 1', [email]);
      if (orgs[0]) { skipped.organisation++; continue; }
    }

    if (user) {
      const { rows: candidates } = await pgDb.query(`
        SELECT p.id, p.amount, p.net_amount FROM payments p JOIN agreements a ON a.id = p.agreement_id
         WHERE a.user_id = $1 AND p.status = 'success'
           AND COALESCE(p.paid_at, p.created_at) BETWEEN $2::timestamptz - INTERVAL '14 days' AND $2::timestamptz + INTERVAL '14 days'
         ORDER BY ABS(EXTRACT(EPOCH FROM (COALESCE(p.paid_at, p.created_at) - $2::timestamptz)))`, [user.id, tx.paid_at]);
      const hit = candidates.find((c) => !used.has(c.id)
        && (Math.abs(Number(c.amount) - gross) <= 30 || Math.abs(Number(c.net_amount || 0) - gross) <= 30));
      if (hit) { used.add(hit.id); skipped.matched++; continue; }
    }

    missing.push({ tx, who: user ? user.full_name : `unknown customer <${email}>` });
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — successful Paystack charges since ${SINCE}: ${charges.length}`);
  console.log(`  already recorded by reference: ${skipped.recorded}`);
  console.log(`  matched to a payment entered another way: ${skipped.matched}`);
  console.log(`  fleet-organisation riders (own path): ${skipped.fleet_rider}`);
  console.log(`  fleet organisations paying for their plan: ${skipped.organisation}`);
  console.log(`  already in the queue: ${skipped.queued_already}`);
  const total = missing.reduce((sum, m) => sum + m.tx.amount / 100, 0);
  console.log(`  ${APPLY ? 'queueing' : 'would queue'}: ${missing.length}, R${total.toFixed(2)}\n`);

  let queuedCount = 0;
  for (const { tx, who } of missing) {
    console.log(`  ${String(tx.paid_at).slice(0, 10)}  R${(tx.amount / 100).toFixed(2).padStart(8)}  ${who}  ${tx.reference}`);
    if (APPLY && await queueCharge(tx, { source: 'backfill' })) queuedCount++;
  }
  if (APPLY) console.log(`\nqueued: ${queuedCount}`);
  await pgDb.pool.end();
})().catch((err) => {
  console.error('FAILED:', err.response?.data?.message || err.message);
  process.exit(1);
});

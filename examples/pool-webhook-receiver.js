'use strict';

/**
 * Reference receiver for OnFleet pool-finance webhooks.
 *
 * Hand this to whoever builds the receiving end on the funder's platform. It
 * is deliberately plain Node with no dependencies so it can be read in one
 * sitting and translated into whatever the other side actually uses.
 *
 * Run it:
 *   ONFLEET_WEBHOOK_SECRET=whsec_... node pool-webhook-receiver.js
 *
 * The four things that matter are marked (1) to (4) below. Three of them are
 * the kind of mistake that works in testing and fails in production.
 */

const http = require('http');
const crypto = require('crypto');

const SECRET = process.env.ONFLEET_WEBHOOK_SECRET;
const PORT = Number(process.env.PORT || 8080);

if (!SECRET) {
  console.error('ONFLEET_WEBHOOK_SECRET is not set. It is shown once, when the endpoint is registered.');
  process.exit(1);
}

// (4) Deliveries are AT-LEAST-ONCE. The payload is POSTed and the result
// recorded as two separate steps, so a restart between them re-sends on the
// next sweep. Keep event ids somewhere durable — a unique column in your own
// database is the right home. An in-memory Set is fine for a smoke test and
// wrong for production, because it empties on every deploy.
const seen = new Set();

function verify(rawBody, header) {
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // (1) Constant-time compare. A plain === leaks, through timing, how much of
  // a forged signature was correct, which is enough to construct a valid one
  // given enough attempts.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function handle(event) {
  switch (event.event_type) {
    case 'pool.payment_received': {
      const p = event.payment;
      console.log(
        `[payment] ${event.pool.reference}  ${event.vehicle.registration}  ` +
        `gross R${p.amount_gross}  fee R${p.processing_fee}  net R${p.amount_net}  (${p.method})`);
      // Reconcile against the bank with amount_net — that is what actually
      // lands. amount_gross is what the rider paid.
      break;
    }
    case 'pool.daily_summary': {
      const s = event.summary;
      console.log(
        `[summary] ${event.pool.reference} as at ${event.as_at_date}  ` +
        `collected R${s.collected_net} net  outstanding R${s.outstanding}  ` +
        `arrears R${s.arrears_total}  at risk R${s.capital_at_risk}`);
      if (s.unallocated_cash > 0) {
        console.log(`          note: R${s.unallocated_cash} received but not yet applied to a week — ` +
                    'the collection rate understates this pool until it is');
      }
      break;
    }
    case 'pool.composition_changed':
      console.log(
        `[composition] ${event.pool.reference}  ` +
        `+${event.added.map((b) => b.registration).join(', ') || 'none'}  ` +
        `-${event.removed.map((b) => b.registration).join(', ') || 'none'}`);
      break;
    default:
      // (3) An unknown event type still gets a 2xx. Replying with an error to
      // something you simply do not handle yet buys six retries over six
      // hours and a dead endpoint in our dashboard, for an event you were
      // always going to ignore.
      console.log(`[ignored] ${event.event_type}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return res.writeHead(405).end();

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // (2) Verify against the EXACT bytes received. Parsing to JSON and
    // re-serialising changes key order and number formatting, and the
    // signature will not match. Most frameworks hide the raw body behind a
    // body parser — in Express you need express.raw({type: 'application/json'})
    // on this route, not express.json().
    const raw = Buffer.concat(chunks);

    if (!verify(raw, req.headers['x-onfleet-signature'])) {
      console.warn('rejected: bad signature');
      return res.writeHead(401).end();
    }

    let event;
    try { event = JSON.parse(raw.toString('utf8')); }
    catch { return res.writeHead(400).end(); }

    const id = event.event_id || req.headers['x-onfleet-event-id'];
    if (seen.has(id)) {
      console.log(`[duplicate] ${id} — already processed, acknowledging again`);
      return res.writeHead(200).end();
    }
    seen.add(id);

    // Acknowledge first, work second. The sender gives up after 10 seconds
    // and will retry, so anything slow — writing to a ledger, recalculating a
    // position — belongs after the response, not before it.
    res.writeHead(200).end();
    setImmediate(() => {
      try { handle(event); }
      catch (e) { console.error(`handler failed for ${id}:`, e.message); }
    });
  });
});

server.listen(PORT, () => console.log(`listening for OnFleet pool events on :${PORT}`));

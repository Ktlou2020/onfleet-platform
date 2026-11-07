'use strict';
const orders = require('./orders');
const pricing = require('./pricing');

// Everything the rider app talks to: going online, trip offers, the steps of
// a trip, earnings, demand, safety. Registered onto the main app so it
// shares its auth and database.

const RETURN_REASONS = {
  no_answer: 'Customer did not answer',
  id_failed: 'Customer could not show a valid ID',
  underage: 'Customer is under 18',
  refused: 'Customer refused the order',
  unsafe: 'Drop-off was not safe',
  other: 'Could not complete the delivery',
};
const INCIDENT_TYPES = ['sos', 'accident', 'store_delay', 'customer_issue', 'vehicle', 'other'];

const ph = (list) => list.map(() => '?').join(',');
const toDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);

// Start of "today" in SAST, as a UTC Date.
function sastDayStart(now = new Date()) {
  const sast = new Date(now.getTime() + 2 * 3600e3);
  return new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate()) - 2 * 3600e3);
}

function registerRiderRoutes(app, { db, auth, requireAdult, audit, refund }) {
  const riderRow = (userId) => db.prepare('SELECT * FROM riders WHERE user_id = ?').get(userId);

  function riderSummary(r) {
    return {
      online: !!r.online,
      paused: !!r.paused,
      vehicle: r.vehicle,
      plate: r.plate,
      lat: r.lat,
      lng: r.lng,
      rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : null,
      ratingCount: r.rating_count,
    };
  }

  function myOrder(riderId, orderId) {
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND rider_id = ?').get(orderId, riderId);
    if (!o) throw new orders.OrderError('Job not found', 404);
    return o;
  }

  function setLocation(userId, lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    db.prepare("UPDATE riders SET lat = ?, lng = ?, located_at = datetime('now') WHERE user_id = ?").run(lat, lng, userId);
    const active = db.prepare(`SELECT id FROM orders WHERE rider_id = ? AND status IN (${ph(orders.RIDER_ACTIVE)})`).all(userId, ...orders.RIDER_ACTIVE);
    for (const { id } of active) orders.bus.emit('order', id);
  }

  function onlineMinutesToday(riderId, now = new Date()) {
    const start = sastDayStart(now);
    const shifts = db.prepare("SELECT started_at, ended_at FROM rider_shifts WHERE rider_id = ? AND (ended_at IS NULL OR ended_at >= datetime('now', '-2 days'))").all(riderId);
    let ms = 0;
    for (const s of shifts) {
      const a = Math.max(toDate(s.started_at).getTime(), start.getTime());
      const b = s.ended_at ? toDate(s.ended_at).getTime() : now.getTime();
      if (b > a) ms += b - a;
    }
    return Math.round(ms / 60000);
  }

  function todayTotals(riderId) {
    const t = db.prepare(`SELECT COUNT(*) AS trips, COALESCE(SUM(rider_payout_cents), 0) AS pay, COALESCE(SUM(tip_cents), 0) AS tips
      FROM orders WHERE rider_id = ? AND status IN ('delivered','returned')
      AND date(updated_at, '+2 hours') = date('now', '+2 hours')`).get(riderId);
    return { trips: t.trips, earningsCents: t.pay + t.tips, tipsCents: t.tips, onlineMinutes: onlineMinutesToday(riderId) };
  }

  // Everything the Drive screen needs in one payload, so the app (and the
  // live stream) only ever deals with one shape.
  function jobsPayload(riderId) {
    orders.sweep(db);
    const r = riderRow(riderId);
    const offer = db.prepare("SELECT id FROM orders WHERE offered_rider_id = ? AND offer_expires_at > datetime('now') ORDER BY id LIMIT 1").get(riderId);
    const current = db.prepare(`SELECT id FROM orders WHERE rider_id = ? AND status IN (${ph(orders.RIDER_ACTIVE)})`).all(riderId, ...orders.RIDER_ACTIVE);
    const board = db.prepare(`SELECT o.id, o.distance_km, o.tip_cents, o.status, s.name, s.lat, s.lng,
        (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = o.id) AS item_count
      FROM orders o JOIN stores s ON s.id = o.store_id
      WHERE o.rider_id IS NULL AND o.status IN (${ph(orders.WAITING_FOR_RIDER)})
        AND (o.offered_rider_id IS NULL OR o.offer_expires_at <= datetime('now'))
      ORDER BY o.id LIMIT 30`).all(...orders.WAITING_FOR_RIDER)
      .map((o) => {
        const pickupKm = r.lat != null ? pricing.roadKm(o, r) : null;
        const payout = orders.riderPayoutCents(pickupKm || 0, o.distance_km);
        return {
          id: o.id, storeName: o.name, pickupKm, dropoffKm: o.distance_km, itemCount: o.item_count,
          storeReady: o.status === 'ready', payoutCents: payout, tipCents: o.tip_cents, totalCents: payout + o.tip_cents,
        };
      })
      .filter((o) => o.pickupKm == null || o.pickupKm <= 15)
      .slice(0, 10);
    return {
      rider: riderSummary(r),
      offer: offer ? orders.offerView(db, offer.id) : null,
      current: current.map(({ id }) => orders.orderView(db, id, 'rider')),
      board,
      today: todayTotals(riderId),
    };
  }

  // ---- Going online --------------------------------------------------------
  app.post('/api/rider/status', auth('rider'), requireAdult, (req, res) => {
    const b = req.body || {};
    const before = riderRow(req.user.id);
    const online = b.online === undefined ? before.online : b.online ? 1 : 0;
    const paused = b.paused === undefined ? (online ? before.paused : 0) : b.paused ? 1 : 0;
    db.prepare('UPDATE riders SET online = ?, paused = ? WHERE user_id = ?').run(online, paused, req.user.id);
    if (online && !before.online) {
      db.prepare('UPDATE rider_shifts SET ended_at = datetime(\'now\') WHERE rider_id = ? AND ended_at IS NULL').run(req.user.id);
      db.prepare('INSERT INTO rider_shifts (rider_id) VALUES (?)').run(req.user.id);
    }
    if (!online && before.online) db.prepare("UPDATE rider_shifts SET ended_at = datetime('now') WHERE rider_id = ? AND ended_at IS NULL").run(req.user.id);
    setLocation(req.user.id, Number(b.lat), Number(b.lng));
    // Going offline or pausing hands back an offer that is still on screen.
    if (!online || paused) {
      const held = db.prepare('SELECT id FROM orders WHERE offered_rider_id = ?').all(req.user.id);
      for (const { id } of held) orders.declineOffer(db, id, req.user.id);
    }
    if (online && !paused) orders.dispatchWaiting(db);
    res.json(jobsPayload(req.user.id));
  });

  app.patch('/api/rider/profile', auth('rider'), (req, res) => {
    const b = req.body || {};
    const vehicles = ['motorbike', 'scooter', 'e-bike', 'bicycle', 'car'];
    if (b.vehicle !== undefined && !vehicles.includes(b.vehicle)) return res.status(400).json({ error: 'Choose a vehicle type' });
    db.prepare('UPDATE riders SET vehicle = COALESCE(?, vehicle), plate = COALESCE(?, plate) WHERE user_id = ?')
      .run(b.vehicle ?? null, b.plate === undefined ? null : String(b.plate).trim().toUpperCase().slice(0, 12), req.user.id);
    if (b.phone !== undefined) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(String(b.phone).trim().slice(0, 20) || null, req.user.id);
    res.json({ rider: riderSummary(riderRow(req.user.id)) });
  });

  app.post('/api/rider/location', auth('rider'), (req, res) => {
    setLocation(req.user.id, Number(req.body?.lat), Number(req.body?.lng));
    res.json({ ok: true });
  });

  app.get('/api/rider/jobs', auth('rider'), (req, res) => res.json(jobsPayload(req.user.id)));

  // Live stream for the Drive screen: a fresh payload whenever an offer
  // lands, an offer runs out, or the current trip changes.
  app.get('/api/rider/stream', auth('rider'), (req, res) => {
    const riderId = req.user.id;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let pending = null;
    const send = () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        try { res.write(`data: ${JSON.stringify(jobsPayload(riderId))}\n\n`); } catch { /* closed */ }
      }, 50);
    };
    const onRider = (id) => { if (id === riderId) send(); };
    const onOrder = (id) => {
      const mine = db.prepare('SELECT 1 FROM orders WHERE id = ? AND (rider_id = ? OR offered_rider_id = ?)').get(id, riderId, riderId);
      if (mine) send();
    };
    orders.bus.on('rider', onRider);
    orders.bus.on('order', onOrder);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    send();
    req.on('close', () => {
      clearInterval(ping);
      clearTimeout(pending);
      orders.bus.off('rider', onRider);
      orders.bus.off('order', onOrder);
    });
  });

  // ---- Offers ----------------------------------------------------------------
  app.post('/api/rider/offers/:id/accept', auth('rider'), requireAdult, (req, res) => {
    orders.acceptOffer(db, Number(req.params.id), req.user.id);
    res.json(jobsPayload(req.user.id));
  });

  app.post('/api/rider/offers/:id/decline', auth('rider'), (req, res) => {
    orders.declineOffer(db, Number(req.params.id), req.user.id);
    res.json(jobsPayload(req.user.id));
  });

  app.post('/api/rider/jobs/:id/claim', auth('rider'), requireAdult, (req, res) => {
    const busy = db.prepare(`SELECT 1 FROM orders WHERE rider_id = ? AND status IN (${ph(orders.RIDER_ACTIVE)})`).get(req.user.id, ...orders.RIDER_ACTIVE);
    if (busy) return res.status(409).json({ error: 'Finish your current delivery first' });
    orders.assignRider(db, Number(req.params.id), req.user.id);
    res.json(jobsPayload(req.user.id));
  });

  // ---- The trip, step by step ---------------------------------------------
  app.post('/api/rider/jobs/:id/arrived-store', auth('rider'), (req, res) => {
    const o = myOrder(req.user.id, req.params.id);
    if (!orders.WAITING_FOR_RIDER.includes(o.status)) return res.status(409).json({ error: 'You have already collected this order' });
    if (!o.arrived_store_at) {
      db.prepare("UPDATE orders SET arrived_store_at = datetime('now') WHERE id = ?").run(o.id);
      orders.logEvent(db, o.id, 'rider_at_store', null);
      orders.bus.emit('order', o.id);
    }
    res.json(jobsPayload(req.user.id));
  });

  app.post('/api/rider/jobs/:id/pickup', auth('rider'), (req, res) => {
    const o = myOrder(req.user.id, req.params.id);
    if (o.status !== 'ready') return res.status(409).json({ error: 'The store has not marked this order ready yet' });
    // Match the bag: the last four characters printed on its slip.
    const given = String(req.body?.bagCode || '').trim().toUpperCase();
    if (!given) return res.status(400).json({ error: "Enter the last 4 characters of the code on the bag's slip" });
    if (given !== o.code.slice(-4).toUpperCase() && given !== o.code.toUpperCase()) return res.status(400).json({ error: "That's not this order's bag — check the code on the slip" });
    if (!o.arrived_store_at) db.prepare("UPDATE orders SET arrived_store_at = datetime('now') WHERE id = ?").run(o.id);
    orders.transition(db, o.id, 'rider', 'picked_up');
    res.json(jobsPayload(req.user.id));
  });

  app.post('/api/rider/jobs/:id/arrived', auth('rider'), (req, res) => {
    const o = myOrder(req.user.id, req.params.id);
    if (o.status !== 'picked_up') return res.status(409).json({ error: 'Collect the order first' });
    if (!o.arrived_customer_at) {
      db.prepare("UPDATE orders SET arrived_customer_at = datetime('now') WHERE id = ?").run(o.id);
      orders.logEvent(db, o.id, 'rider_arrived', null);
      orders.bus.emit('order', o.id);
      orders.bus.emit('status', o.id, 'rider_arrived');
    }
    res.json(jobsPayload(req.user.id));
  });

  // Handover at the door: the rider must see an ID that matches an adult
  // and the customer must give the code from their app. No code, no ID, no
  // handover — the rider returns the order to the store.
  app.post('/api/rider/jobs/:id/deliver', auth('rider'), (req, res) => {
    const o = myOrder(req.user.id, req.params.id);
    if (!req.body?.idChecked) return res.status(400).json({ error: "Check the customer's ID before handing over" });
    if (String(req.body?.handoverCode || '') !== o.handover_code) return res.status(400).json({ error: "That code doesn't match — ask the customer to read it from their app" });
    db.prepare('UPDATE orders SET id_checked = 1 WHERE id = ?').run(o.id);
    orders.transition(db, o.id, 'rider', 'delivered', { note: 'ID checked at the door' });
    res.json({ ...jobsPayload(req.user.id), completed: orders.orderView(db, o.id, 'rider') });
  });

  // Can't hand over: take it back to the store. The rider is still paid for
  // the trip; the customer is refunded and the stock goes back on the shelf.
  app.post('/api/rider/jobs/:id/return', auth('rider'), (req, res) => {
    const o = myOrder(req.user.id, req.params.id);
    const reason = req.body?.reason;
    if (!RETURN_REASONS[reason]) return res.status(400).json({ error: 'Choose why you could not deliver' });
    if (reason === 'no_answer') {
      // Measured on the database clock, the same clock that stamped the arrival.
      const waited = o.arrived_customer_at
        ? db.prepare("SELECT (julianday('now') - julianday(arrived_customer_at)) * 1440 AS m FROM orders WHERE id = ?").get(o.id).m
        : 0;
      if (!o.arrived_customer_at) return res.status(409).json({ error: "Tap \"I've arrived\" first so the customer is told you're outside" });
      if (waited < orders.NO_ANSWER_WAIT_MINUTES) {
        return res.status(409).json({ error: `Please wait ${orders.NO_ANSWER_WAIT_MINUTES} minutes and try calling first`, waitSecondsLeft: Math.ceil((orders.NO_ANSWER_WAIT_MINUTES - waited) * 60) });
      }
    }
    const note = `${RETURN_REASONS[reason]}${req.body?.note ? ` — ${String(req.body.note).slice(0, 200)}` : ''}. Returned to store.`;
    orders.transition(db, o.id, 'rider', 'returned', { note, refund });
    db.prepare('INSERT INTO incidents (rider_id, order_id, type, note) VALUES (?, ?, ?, ?)').run(req.user.id, o.id, 'customer_issue', note);
    audit(req.user.id, 'order_returned', { orderId: o.id, reason });
    res.json({ ...jobsPayload(req.user.id), completed: orders.orderView(db, o.id, 'rider') });
  });

  // ---- Safety ----------------------------------------------------------------
  app.post('/api/rider/incidents', auth('rider'), (req, res) => {
    const b = req.body || {};
    if (!INCIDENT_TYPES.includes(b.type)) return res.status(400).json({ error: 'Choose what happened' });
    const orderId = b.orderId ? myOrder(req.user.id, b.orderId).id : null;
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    const r = riderRow(req.user.id);
    db.prepare('INSERT INTO incidents (rider_id, order_id, type, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)').run(
      req.user.id, orderId, b.type, String(b.note || '').slice(0, 500),
      Number.isFinite(lat) ? lat : r.lat, Number.isFinite(lng) ? lng : r.lng,
    );
    audit(req.user.id, 'incident', { type: b.type, orderId });
    res.status(201).json({ ok: true });
  });

  // ---- Earnings -------------------------------------------------------------
  app.get('/api/rider/earnings', auth('rider'), (req, res) => {
    const id = req.user.id;
    const days = db.prepare(`SELECT date(updated_at, '+2 hours') AS day, COUNT(*) AS trips,
        SUM(rider_payout_cents) AS pay, SUM(tip_cents) AS tips
      FROM orders WHERE rider_id = ? AND status IN ('delivered','returned')
        AND date(updated_at, '+2 hours') > date('now', '+2 hours', '-7 days')
      GROUP BY day ORDER BY day`).all(id);
    const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
    const week = [];
    // "Today" in SAST from the database clock, so the days line up with the
    // dates the trips were stamped with.
    const [y, m, dd] = db.prepare("SELECT date('now', '+2 hours') AS d").get().d.split('-').map(Number);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1, dd - i)).toISOString().slice(0, 10);
      const row = byDay[d];
      week.push({ day: d, trips: row?.trips || 0, payCents: row?.pay || 0, tipsCents: row?.tips || 0 });
    }
    const trips = db.prepare(`SELECT o.id, o.code, o.status, o.rider_payout_cents, o.tip_cents, o.distance_km, o.offer_pickup_km,
        o.rider_assigned_at, o.updated_at, o.rider_rating, s.name AS store_name
      FROM orders o JOIN stores s ON s.id = o.store_id
      WHERE o.rider_id = ? AND o.status IN ('delivered','returned') ORDER BY o.updated_at DESC LIMIT 30`).all(id)
      .map((t) => ({
        id: t.id, code: t.code, status: t.status, storeName: t.store_name, at: t.updated_at,
        payCents: t.rider_payout_cents, tipCents: t.tip_cents, totalCents: t.rider_payout_cents + t.tip_cents,
        km: Math.round(((t.offer_pickup_km || 0) + t.distance_km) * 10) / 10, rating: t.rider_rating,
        minutes: t.rider_assigned_at ? Math.round((toDate(t.updated_at) - toDate(t.rider_assigned_at)) / 60000) : null,
      }));
    const offers = db.prepare(`SELECT outcome, COUNT(*) AS n FROM offer_log WHERE rider_id = ? AND at > datetime('now', '-30 days') GROUP BY outcome`).all(id);
    const count = (k) => offers.find((o) => o.outcome === k)?.n || 0;
    const offered = count('accepted') + count('declined') + count('expired');
    const done = db.prepare(`SELECT SUM(status = 'delivered') AS delivered, SUM(status = 'returned') AS returned FROM orders
      WHERE rider_id = ? AND status IN ('delivered','returned') AND updated_at > datetime('now', '-30 days')`).get(id);
    const finished = (done.delivered || 0) + (done.returned || 0);
    const r = riderRow(id);
    res.json({
      today: todayTotals(id),
      week,
      weekTotalCents: week.reduce((n, d) => n + d.payCents + d.tipsCents, 0),
      trips,
      stats: {
        acceptanceRate: offered ? Math.round((count('accepted') / offered) * 100) : null,
        completionRate: finished ? Math.round(((done.delivered || 0) / finished) * 100) : null,
        rating: riderSummary(r).rating,
        ratingCount: r.rating_count,
        lifetimeTrips: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE rider_id = ? AND status = 'delivered'").get(id).n,
      },
      payRates: orders.RIDER_PAY,
    });
  });

  // ---- Where the work is --------------------------------------------------
  // Stores near the rider with how busy they have been in the last hour,
  // for the "busy areas" layer on the map.
  app.get('/api/rider/demand', auth('rider'), (req, res) => {
    const r = riderRow(req.user.id);
    const rows = db.prepare(`SELECT s.id, s.name, s.lat, s.lng,
        (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.id AND o.status NOT IN ('pending_payment','cancelled','rejected')
          AND o.created_at > datetime('now', '-60 minutes')) AS last_hour,
        (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.id AND o.rider_id IS NULL AND o.status IN (${ph(orders.WAITING_FOR_RIDER)})) AS waiting
      FROM stores s WHERE s.status = 'approved' AND s.is_open = 1`).all(...orders.WAITING_FOR_RIDER);
    const spots = rows
      .map((s) => ({ ...s, km: r.lat != null ? pricing.roadKm(s, r) : null }))
      .filter((s) => s.km == null || s.km <= 25)
      .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, km: s.km, lastHour: s.last_hour, waiting: s.waiting, level: s.waiting > 0 || s.last_hour >= 4 ? 'high' : s.last_hour >= 1 ? 'medium' : 'low' }))
      .sort((a, b) => b.waiting - a.waiting || b.lastHour - a.lastHour || (a.km ?? 0) - (b.km ?? 0));
    res.json({ spots });
  });
}

module.exports = { registerRiderRoutes, RETURN_REASONS, INCIDENT_TYPES };

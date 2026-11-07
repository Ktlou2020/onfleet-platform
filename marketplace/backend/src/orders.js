'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { haversineKm, roadKm } = require('./pricing');

// Live updates for the tracking screen and the rider app. One process, so an
// in-memory bus is enough; swap for Redis pub/sub when running more than one
// instance.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const ACTIVE = ['placed', 'accepted', 'preparing', 'ready', 'picked_up'];
const RIDER_ACTIVE = ['accepted', 'preparing', 'ready', 'picked_up'];
const WAITING_FOR_RIDER = ['accepted', 'preparing', 'ready'];
const DISPATCH_RADIUS_KM = 10;
const PAYMENT_TIMEOUT_MINUTES = 15;
const OFFER_SECONDS = 30;
const NO_ANSWER_WAIT_MINUTES = 5;

// What a rider earns for a trip, before tips: a base fee plus a rate for
// every kilometre ridden, to the store and on to the customer. Tips are on
// top and go to the rider in full.
const RIDER_PAY = { baseCents: 1800, perKmCents: 500, minimumCents: 2500 };
function riderPayoutCents(pickupKm, dropoffKm) {
  const km = Math.ceil((pickupKm || 0) + (dropoffKm || 0));
  return Math.max(RIDER_PAY.minimumCents, RIDER_PAY.baseCents + km * RIDER_PAY.perKmCents);
}

// Who may move an order from which status to which.
const TRANSITIONS = {
  merchant: {
    placed: ['accepted', 'rejected'],
    accepted: ['preparing', 'ready'],
    preparing: ['ready'],
  },
  rider: {
    ready: ['picked_up'],
    picked_up: ['delivered', 'returned'],
  },
  customer: {
    pending_payment: ['cancelled'],
    scheduled: ['cancelled'],
    placed: ['cancelled'],
  },
  admin: {
    pending_payment: ['cancelled'],
    scheduled: ['cancelled'],
    placed: ['cancelled'],
    accepted: ['cancelled'],
    preparing: ['cancelled'],
    ready: ['cancelled'],
    picked_up: ['cancelled'],
  },
  system: {
    pending_payment: ['placed', 'scheduled', 'cancelled'],
    scheduled: ['placed', 'cancelled'],
  },
};

const ENDED_WITHOUT_DELIVERY = ['cancelled', 'rejected', 'returned'];

class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function newCode() {
  return 'CP' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function newHandoverCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function canTransition(actor, from, to) {
  return (TRANSITIONS[actor]?.[from] || []).includes(to);
}

function logEvent(db, orderId, status, note) {
  db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)').run(orderId, status, note || null);
}

function restock(db, orderId) {
  const items = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(orderId);
  const upd = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
  for (const it of items) upd.run(it.qty, it.product_id);
}

const placeholders = (list) => list.map(() => '?').join(',');

// The single place an order's status changes. Everything that must happen
// alongside a change (restock, refund flag, event, live push, dispatch) is
// done here so no route can forget it.
function transition(db, orderId, actor, to, { note, refund } = {}) {
  const run = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new OrderError('Order not found', 404);
    if (!canTransition(actor, order.status, to)) {
      throw new OrderError(`Order is ${order.status.replace('_', ' ')} and cannot be moved to ${to.replace('_', ' ')}`, 409);
    }
    const sets = ['status = ?', "updated_at = datetime('now')"];
    const args = [to];
    if (to === 'delivered') sets.push("delivered_at = datetime('now')");
    if (to === 'picked_up') sets.push("picked_up_at = datetime('now')");
    if (ENDED_WITHOUT_DELIVERY.includes(to)) {
      sets.push('cancel_reason = ?', 'offered_rider_id = NULL', 'offer_expires_at = NULL');
      args.push(note || null);
      restock(db, orderId);
      if (order.payment_status === 'paid') {
        sets.push("payment_status = 'refunded'");
        if (refund) refund(order);
      }
    }
    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...args, orderId);
    logEvent(db, orderId, to, note);
    return order;
  });
  const before = run();
  if (to === 'accepted') offerNext(db, orderId);
  bus.emit('order', orderId);
  if (before.offered_rider_id) bus.emit('rider', before.offered_rider_id);
  if (before.rider_id) bus.emit('rider', before.rider_id);
  // A rider who just finished is free for the next waiting order.
  if (['delivered', 'returned'].includes(to) && before.rider_id) dispatchWaiting(db);
}

// ---- Dispatch: offers with a countdown ----------------------------------

function freeRiders(db) {
  return db.prepare(`
    SELECT r.user_id, r.lat, r.lng FROM riders r
    JOIN users u ON u.id = r.user_id
    WHERE r.online = 1 AND r.paused = 0 AND u.suspended = 0 AND u.age_verified = 1 AND r.lat IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.rider_id = r.user_id AND o.status IN (${placeholders(RIDER_ACTIVE)}))
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.offered_rider_id = r.user_id AND o.offer_expires_at > datetime('now'))
  `).all(...RIDER_ACTIVE);
}

// Offer the order to the nearest free rider in range who has not already
// passed on it. Returns the rider offered, or null if nobody is available
// (the order then waits on the job board and is retried by the sweep).
function offerNext(db, orderId) {
  const order = db.prepare(`
    SELECT o.id, o.rider_id, o.offered_rider_id, o.offer_expires_at, o.status, o.distance_km, s.lat, s.lng
    FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = ?
  `).get(orderId);
  if (!order || order.rider_id || !WAITING_FOR_RIDER.includes(order.status)) return null;
  const live = db.prepare("SELECT 1 FROM orders WHERE id = ? AND offered_rider_id IS NOT NULL AND offer_expires_at > datetime('now')").get(orderId);
  if (live) return order.offered_rider_id;

  const passed = new Set(db.prepare('SELECT rider_id FROM offer_log WHERE order_id = ?').all(orderId).map((r) => r.rider_id));
  let best = null;
  for (const c of freeRiders(db)) {
    if (passed.has(c.user_id)) continue;
    const km = haversineKm(order, c);
    if (km <= DISPATCH_RADIUS_KM && (!best || km < best.km)) best = { id: c.user_id, km, lat: c.lat, lng: c.lng };
  }
  if (!best) {
    db.prepare('UPDATE orders SET offered_rider_id = NULL, offer_expires_at = NULL WHERE id = ?').run(orderId);
    return null;
  }
  const pickupKm = roadKm(order, best);
  db.prepare(`UPDATE orders SET offered_rider_id = ?, offer_expires_at = datetime('now', ?), offer_pickup_km = ?, rider_payout_cents = ?
    WHERE id = ?`).run(best.id, `+${OFFER_SECONDS} seconds`, pickupKm, riderPayoutCents(pickupKm, order.distance_km), orderId);
  bus.emit('rider', best.id);
  return best.id;
}

function acceptOffer(db, orderId, riderId) {
  const res = db.prepare(`
    UPDATE orders SET rider_id = ?, offered_rider_id = NULL, offer_expires_at = NULL,
      rider_assigned_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND offered_rider_id = ? AND offer_expires_at > datetime('now') AND rider_id IS NULL
      AND status IN (${placeholders(WAITING_FOR_RIDER)})
  `).run(riderId, orderId, riderId, ...WAITING_FOR_RIDER);
  if (res.changes === 0) throw new OrderError('This offer has expired', 409);
  db.prepare("INSERT INTO offer_log (order_id, rider_id, outcome) VALUES (?, ?, 'accepted')").run(orderId, riderId);
  logEvent(db, orderId, 'rider_assigned', null);
  bus.emit('order', orderId);
  bus.emit('rider', riderId);
}

function declineOffer(db, orderId, riderId) {
  const res = db.prepare('UPDATE orders SET offered_rider_id = NULL, offer_expires_at = NULL WHERE id = ? AND offered_rider_id = ?').run(orderId, riderId);
  if (res.changes === 0) throw new OrderError('There is no offer to decline', 409);
  db.prepare("INSERT INTO offer_log (order_id, rider_id, outcome) VALUES (?, ?, 'declined')").run(orderId, riderId);
  bus.emit('rider', riderId);
  offerNext(db, orderId);
}

// Called every few seconds: offers that ran out of time move to the next
// rider, and orders nobody has been offered yet get another try.
function expireOffers(db) {
  const stale = db.prepare("SELECT id, offered_rider_id FROM orders WHERE offered_rider_id IS NOT NULL AND offer_expires_at <= datetime('now')").all();
  for (const o of stale) {
    db.prepare('UPDATE orders SET offered_rider_id = NULL, offer_expires_at = NULL WHERE id = ? AND offered_rider_id = ?').run(o.id, o.offered_rider_id);
    db.prepare("INSERT INTO offer_log (order_id, rider_id, outcome) VALUES (?, ?, 'expired')").run(o.id, o.offered_rider_id);
    bus.emit('rider', o.offered_rider_id);
    offerNext(db, o.id);
  }
  return stale.length;
}

function dispatchWaiting(db) {
  const waiting = db.prepare(`SELECT id FROM orders WHERE rider_id IS NULL AND offered_rider_id IS NULL
    AND status IN (${placeholders(WAITING_FOR_RIDER)}) ORDER BY id`).all(...WAITING_FOR_RIDER);
  for (const { id } of waiting) offerNext(db, id);
}

function sweep(db) {
  expireOffers(db);
  dispatchWaiting(db);
}

// Taking a job straight from the board. Allowed when nobody else holds a
// live offer for it.
function assignRider(db, orderId, riderId) {
  const res = db.prepare(`
    UPDATE orders SET rider_id = ?, offered_rider_id = NULL, offer_expires_at = NULL,
      rider_assigned_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND rider_id IS NULL AND status IN (${placeholders(WAITING_FOR_RIDER)})
      AND (offered_rider_id IS NULL OR offered_rider_id = ? OR offer_expires_at <= datetime('now'))
  `).run(riderId, orderId, ...WAITING_FOR_RIDER, riderId);
  if (res.changes === 0) throw new OrderError('This job has already been taken', 409);
  const r = db.prepare('SELECT lat, lng FROM riders WHERE user_id = ?').get(riderId);
  const o = db.prepare('SELECT o.distance_km, s.lat, s.lng FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = ?').get(orderId);
  const pickupKm = r?.lat != null ? roadKm(o, r) : 0;
  db.prepare('UPDATE orders SET offer_pickup_km = ?, rider_payout_cents = ? WHERE id = ?').run(pickupKm, riderPayoutCents(pickupKm, o.distance_km), orderId);
  db.prepare("INSERT INTO offer_log (order_id, rider_id, outcome) VALUES (?, ?, 'accepted')").run(orderId, riderId);
  logEvent(db, orderId, 'rider_assigned', null);
  bus.emit('order', orderId);
  bus.emit('rider', riderId);
}

// ---- Views ----------------------------------------------------------------

// What the customer, store, rider and admin each see of an order.
function orderView(db, orderId, viewer) {
  const o = db.prepare(`
    SELECT o.*, s.name AS store_name, s.slug AS store_slug, s.address AS store_address,
           s.lat AS store_lat, s.lng AS store_lng, s.accent AS store_accent,
           c.name AS customer_name, c.phone AS customer_phone,
           ru.name AS rider_name, ru.phone AS rider_phone, r.vehicle AS rider_vehicle,
           r.plate AS rider_plate, r.lat AS rider_lat, r.lng AS rider_lng, r.located_at AS rider_located_at,
           r.rating_sum AS rider_rating_sum, r.rating_count AS rider_rating_count
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    JOIN users c ON c.id = o.customer_id
    LEFT JOIN users ru ON ru.id = o.rider_id
    LEFT JOIN riders r ON r.user_id = o.rider_id
    WHERE o.id = ?
  `).get(orderId);
  if (!o) return null;
  const items = db.prepare('SELECT product_id, name, price_cents, qty FROM order_items WHERE order_id = ?').all(orderId);
  const events = db.prepare('SELECT status, note, at FROM order_events WHERE order_id = ? ORDER BY id').all(orderId);
  const review = db.prepare('SELECT rating, comment FROM reviews WHERE order_id = ?').get(orderId) || null;
  const riderSide = viewer === 'rider' || viewer === 'admin';

  const view = {
    id: o.id,
    code: o.code,
    status: o.status,
    paymentStatus: o.payment_status,
    createdAt: o.created_at,
    deliveredAt: o.delivered_at,
    cancelReason: o.cancel_reason,
    etaMinutes: o.eta_minutes,
    scheduledFor: o.scheduled_for,
    distanceKm: o.distance_km,
    notes: o.notes,
    milestones: {
      riderAssignedAt: o.rider_assigned_at,
      arrivedStoreAt: o.arrived_store_at,
      pickedUpAt: o.picked_up_at,
      arrivedCustomerAt: o.arrived_customer_at,
    },
    totals: {
      subtotalCents: o.subtotal_cents,
      deliveryFeeCents: o.delivery_fee_cents,
      serviceFeeCents: o.service_fee_cents,
      tipCents: o.tip_cents,
      discountCents: o.discount_cents,
      promoCode: o.promo_code,
      totalCents: o.total_cents,
      vatCents: o.vat_cents,
    },
    items,
    events,
    review: review ? { ...review, riderRating: o.rider_rating } : null,
    store: { id: o.store_id, name: o.store_name, slug: o.store_slug, address: o.store_address, lat: o.store_lat, lng: o.store_lng, accent: o.store_accent },
    dropoff: { address: o.address, lat: o.lat, lng: o.lng },
    rider: o.rider_id
      ? {
          name: viewer === 'customer' ? o.rider_name.split(' ')[0] : o.rider_name,
          vehicle: o.rider_vehicle,
          plate: o.rider_plate,
          rating: o.rider_rating_count ? Math.round((o.rider_rating_sum / o.rider_rating_count) * 10) / 10 : null,
          // Location is shared only while the rider is on this order.
          location: RIDER_ACTIVE.includes(o.status) && o.rider_lat != null
            ? { lat: o.rider_lat, lng: o.rider_lng, at: o.rider_located_at }
            : null,
          phone: viewer === 'customer' && o.status === 'picked_up' ? o.rider_phone : undefined,
        }
      : null,
  };
  if (riderSide) {
    view.pay = { payoutCents: o.rider_payout_cents, tipCents: o.tip_cents, totalCents: o.rider_payout_cents + o.tip_cents, pickupKm: o.offer_pickup_km };
  }
  // The customer reads the handover code to the rider at the door; nobody
  // else sees it, so the rider cannot complete a delivery they did not make.
  if (viewer === 'customer' || viewer === 'admin') view.handoverCode = o.handover_code;
  if (viewer !== 'customer') {
    view.customer = {
      name: viewer === 'rider' ? o.customer_name.split(' ')[0] : o.customer_name,
      phone: viewer === 'admin' || (viewer === 'rider' && o.status === 'picked_up') ? o.customer_phone : undefined,
    };
  }
  return view;
}

// The offer card: enough to decide in a few seconds, nothing private.
function offerView(db, orderId) {
  const o = db.prepare(`
    SELECT o.id, o.code, o.distance_km, o.offer_pickup_km, o.rider_payout_cents, o.tip_cents, o.status, o.lat, o.lng,
      CAST(ROUND((julianday(o.offer_expires_at) - julianday('now')) * 86400) AS INTEGER) AS seconds_left,
      s.name AS store_name, s.address AS store_address, s.lat AS store_lat, s.lng AS store_lng,
      (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = ?
  `).get(orderId);
  if (!o) return null;
  const totalKm = (o.offer_pickup_km || 0) + o.distance_km;
  return {
    id: o.id,
    code: o.code,
    secondsLeft: Math.max(0, o.seconds_left),
    offerSeconds: OFFER_SECONDS,
    payoutCents: o.rider_payout_cents,
    tipCents: o.tip_cents,
    totalCents: o.rider_payout_cents + o.tip_cents,
    pickupKm: o.offer_pickup_km,
    dropoffKm: o.distance_km,
    totalKm: Math.round(totalKm * 10) / 10,
    estMinutes: Math.round((totalKm / 25) * 60 + 6),
    itemCount: o.item_count,
    storeReady: o.status === 'ready',
    store: { name: o.store_name, address: o.store_address, lat: o.store_lat, lng: o.store_lng },
    // Drop-off area only, rounded, until the rider accepts.
    dropoffArea: { lat: Math.round(o.lat * 100) / 100, lng: Math.round(o.lng * 100) / 100 },
  };
}

// Scheduled orders whose delivery time has come go to the store as new
// orders. The ETA restarts from now: time waited so far plus the original
// estimate, so "late" alerts count from the release, not from payment.
function releaseScheduled(db, now = new Date()) {
  const due = db.prepare("SELECT id, base_eta_minutes, eta_minutes FROM orders WHERE status = 'scheduled' AND scheduled_for <= ?").all(now.toISOString());
  for (const o of due) {
    transition(db, o.id, 'system', 'placed', { note: 'Delivery time reached — sent to the store' });
    const elapsed = db.prepare("SELECT (julianday('now') - julianday(created_at)) * 1440 AS m FROM orders WHERE id = ?").get(o.id).m;
    db.prepare("UPDATE orders SET eta_minutes = ?, updated_at = datetime('now') WHERE id = ?").run(Math.round(elapsed + (o.base_eta_minutes || o.eta_minutes)), o.id);
    bus.emit('order', o.id);
  }
  return due.length;
}

function expireUnpaid(db, refund) {
  const stale = db.prepare(`
    SELECT id FROM orders WHERE status = 'pending_payment'
    AND created_at < datetime('now', ?)
  `).all(`-${PAYMENT_TIMEOUT_MINUTES} minutes`);
  for (const { id } of stale) transition(db, id, 'system', 'cancelled', { note: 'Payment not completed in time', refund });
  return stale.length;
}

module.exports = {
  bus, ACTIVE, RIDER_ACTIVE, WAITING_FOR_RIDER, OrderError, TRANSITIONS, RIDER_PAY, OFFER_SECONDS, NO_ANSWER_WAIT_MINUTES,
  newCode, newHandoverCode, canTransition, transition, riderPayoutCents,
  offerNext, acceptOffer, declineOffer, expireOffers, dispatchWaiting, sweep, assignRider,
  orderView, offerView, logEvent, expireUnpaid, releaseScheduled,
};

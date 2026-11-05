'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { haversineKm } = require('./pricing');

// Live updates for the tracking screen. One process, so an in-memory bus is
// enough; swap for Redis pub/sub when running more than one instance.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const ACTIVE = ['placed', 'accepted', 'preparing', 'ready', 'picked_up'];
const RIDER_ACTIVE = ['accepted', 'preparing', 'ready', 'picked_up'];
const DISPATCH_RADIUS_KM = 10;
const PAYMENT_TIMEOUT_MINUTES = 15;

// Who may move an order from which status to which.
const TRANSITIONS = {
  merchant: {
    placed: ['accepted', 'rejected'],
    accepted: ['preparing', 'ready'],
    preparing: ['ready'],
  },
  rider: {
    ready: ['picked_up'],
    picked_up: ['delivered'],
  },
  customer: {
    pending_payment: ['cancelled'],
    placed: ['cancelled'],
  },
  admin: {
    pending_payment: ['cancelled'],
    placed: ['cancelled'],
    accepted: ['cancelled'],
    preparing: ['cancelled'],
    ready: ['cancelled'],
    picked_up: ['cancelled'],
  },
  system: {
    pending_payment: ['placed', 'cancelled'],
  },
};

class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function newCode() {
  return 'C9' + crypto.randomBytes(3).toString('hex').toUpperCase();
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
    if (to === 'cancelled' || to === 'rejected') {
      sets.push('cancel_reason = ?');
      args.push(note || null);
      restock(db, orderId);
      if (order.payment_status === 'paid') {
        sets.push("payment_status = 'refunded'");
        if (refund) refund(order);
      }
    }
    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...args, orderId);
    logEvent(db, orderId, to, note);
    return to;
  });
  run();
  if (to === 'accepted') autoDispatch(db, orderId);
  bus.emit('order', orderId);
}

// Nearest online rider, within range of the store, who is not already
// carrying an order. Riders can also claim from the job board, so a miss
// here is not fatal.
function autoDispatch(db, orderId) {
  const order = db.prepare(
    'SELECT o.id, o.rider_id, s.lat, s.lng FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = ?',
  ).get(orderId);
  if (!order || order.rider_id) return null;
  const candidates = db.prepare(`
    SELECT r.user_id, r.lat, r.lng FROM riders r
    JOIN users u ON u.id = r.user_id
    WHERE r.online = 1 AND u.suspended = 0 AND u.age_verified = 1 AND r.lat IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM orders o WHERE o.rider_id = r.user_id
        AND o.status IN (${RIDER_ACTIVE.map(() => '?').join(',')})
      )
  `).all(...RIDER_ACTIVE);
  let best = null;
  for (const c of candidates) {
    const km = haversineKm(order, c);
    if (km <= DISPATCH_RADIUS_KM && (!best || km < best.km)) best = { id: c.user_id, km };
  }
  if (!best) return null;
  assignRider(db, orderId, best.id);
  return best.id;
}

function assignRider(db, orderId, riderId) {
  const res = db.prepare(`
    UPDATE orders SET rider_id = ?, updated_at = datetime('now')
    WHERE id = ? AND rider_id IS NULL AND status IN ('accepted','preparing','ready')
  `).run(riderId, orderId);
  if (res.changes === 0) throw new OrderError('This job has already been taken', 409);
  logEvent(db, orderId, 'rider_assigned', null);
  bus.emit('order', orderId);
}

// What the customer, store, rider and admin each see of an order.
function orderView(db, orderId, viewer) {
  const o = db.prepare(`
    SELECT o.*, s.name AS store_name, s.slug AS store_slug, s.address AS store_address,
           s.lat AS store_lat, s.lng AS store_lng, s.accent AS store_accent,
           c.name AS customer_name, c.phone AS customer_phone,
           ru.name AS rider_name, ru.phone AS rider_phone, r.vehicle AS rider_vehicle,
           r.plate AS rider_plate, r.lat AS rider_lat, r.lng AS rider_lng, r.located_at AS rider_located_at
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

  const view = {
    id: o.id,
    code: o.code,
    status: o.status,
    paymentStatus: o.payment_status,
    createdAt: o.created_at,
    deliveredAt: o.delivered_at,
    cancelReason: o.cancel_reason,
    etaMinutes: o.eta_minutes,
    distanceKm: o.distance_km,
    notes: o.notes,
    totals: {
      subtotalCents: o.subtotal_cents,
      deliveryFeeCents: o.delivery_fee_cents,
      serviceFeeCents: o.service_fee_cents,
      totalCents: o.total_cents,
      vatCents: o.vat_cents,
    },
    items,
    events,
    review,
    store: { id: o.store_id, name: o.store_name, slug: o.store_slug, address: o.store_address, lat: o.store_lat, lng: o.store_lng, accent: o.store_accent },
    dropoff: { address: o.address, lat: o.lat, lng: o.lng },
    rider: o.rider_id
      ? {
          name: o.rider_name,
          vehicle: o.rider_vehicle,
          plate: o.rider_plate,
          // Location is only shared while the rider is carrying this order.
          location: ['picked_up', 'ready'].includes(o.status) && o.rider_lat != null
            ? { lat: o.rider_lat, lng: o.rider_lng, at: o.rider_located_at }
            : null,
          phone: viewer === 'customer' && o.status === 'picked_up' ? o.rider_phone : undefined,
        }
      : null,
  };
  // The customer reads the handover code to the rider at the door; nobody
  // else sees it, so the rider cannot complete a delivery they did not make.
  if (viewer === 'customer' || viewer === 'admin') view.handoverCode = o.handover_code;
  if (viewer !== 'customer') view.customer = { name: o.customer_name, phone: viewer === 'admin' || (viewer === 'rider' && o.status === 'picked_up') ? o.customer_phone : undefined };
  return view;
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
  bus, ACTIVE, RIDER_ACTIVE, OrderError, TRANSITIONS,
  newCode, newHandoverCode, canTransition, transition, autoDispatch, assignRider, orderView, logEvent, expireUnpaid,
};

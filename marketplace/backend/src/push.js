'use strict';
const webpush = require('web-push');
const orders = require('./orders');

// Web Push: notifications that reach a phone even when ClickNPuff is
// closed or the screen is off. Customers hear about their order, riders
// about new trip offers, stores about new orders.
//
// Keys: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to fix them; otherwise
// a pair is generated once and kept in the database, so subscriptions
// survive restarts. Changing keys invalidates every subscription.

const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:help@clicknpuff.co.za';

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_ok_at TEXT
    );
    CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
  `);
}

function keys(db) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  if (!get('vapid_public_key')) {
    const k = webpush.generateVAPIDKeys();
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    put.run('vapid_public_key', k.publicKey);
    put.run('vapid_private_key', k.privateKey);
  }
  return { publicKey: get('vapid_public_key'), privateKey: get('vapid_private_key') };
}

// What each status change tells the customer.
const CUSTOMER_MESSAGES = {
  scheduled: (o) => ({ title: 'Pre-order confirmed', body: `We'll send your ${o.store} order to the store when deliveries start.` }),
  accepted: (o) => ({ title: 'Order accepted 👍', body: `${o.store} is packing your order.` }),
  ready: (o) => ({ title: 'Packed and ready', body: `Your ${o.store} order is waiting for the rider.` }),
  picked_up: () => ({ title: 'On the way 🛵', body: 'Your rider has your order. Have your ID and 4-digit code ready.' }),
  rider_arrived: () => ({ title: 'Your rider is outside 👋', body: 'Meet them at the door with your ID and code.', urgent: true }),
  delivered: (o) => ({ title: 'Delivered — enjoy!', body: `How was ${o.store}? Tap to rate your order.` }),
  rejected: (o) => ({ title: 'Order declined', body: `${o.store} couldn't take your order. You've been refunded in full.` }),
  cancelled: () => ({ title: 'Order cancelled', body: "Your order was cancelled and you've been refunded." }),
  returned: () => ({ title: "We couldn't deliver", body: 'Your order went back to the store and you have been refunded. Tap for details.' }),
  item_unavailable: (o) => ({ title: 'Something is sold out', body: `${o.store} is out of part of your order. Tap to continue without it or cancel.`, urgent: true }),
  items_removed: (o) => ({ title: 'Order updated', body: `We've refunded the sold-out item${o.refund_cents ? ` (R${(o.refund_cents / 100).toFixed(2)})` : ''}. ${o.store} is on it.` }),
};

function registerPush(app, { db, auth, send = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts) }) {
  migrate(db);
  const k = keys(db);
  webpush.setVapidDetails(SUBJECT, k.publicKey, k.privateKey);

  app.get('/api/push/key', (req, res) => res.json({ publicKey: k.publicKey }));

  app.post('/api/push/subscribe', auth(), (req, res) => {
    const s = req.body?.subscription;
    if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return res.status(400).json({ error: 'Not a valid push subscription' });
    // One endpoint belongs to one browser; if someone else signs in on it,
    // it moves to them.
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth);
    res.status(201).json({ ok: true });
  });

  app.post('/api/push/unsubscribe', auth(), (req, res) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint || ''), req.user.id);
    res.json({ ok: true });
  });

  app.post('/api/push/test', auth(), wrapAsync(async (req, res) => {
    const n = await notifyUser(req.user.id, { title: 'Notifications are on ✅', body: "This is how we'll let you know what's happening.", url: '/' });
    res.json({ sent: n });
  }));

  async function notifyUser(userId, message) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    const payload = JSON.stringify(message);
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: message.ttl || 3600, urgency: message.urgent ? 'high' : 'normal' });
        db.prepare("UPDATE push_subscriptions SET last_ok_at = datetime('now') WHERE id = ?").run(s.id);
        sent++;
      } catch (e) {
        // Gone or no longer valid: forget it.
        if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      }
    }));
    return sent;
  }

  const fire = (p) => p.catch(() => {});

  orders.bus.on('status', (orderId, to, evDb) => {
    if (evDb && evDb !== db) return;
    const o = db.prepare(`SELECT o.id, o.code, o.customer_id, o.refund_cents, s.name AS store, s.owner_id FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = ?`).get(orderId);
    if (!o) return;
    const msg = CUSTOMER_MESSAGES[to];
    if (msg) {
      const m = msg(o);
      fire(notifyUser(o.customer_id, { ...m, url: `/orders/${o.id}`, tag: `order-${o.id}` }));
    }
    // A paid order (or a pre-order whose time has come) lands on the store's board.
    if (to === 'placed') {
      const items = db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM order_items WHERE order_id = ?').get(o.id).n;
      fire(notifyUser(o.owner_id, { title: `New order #${o.code}`, body: `${items} item${items === 1 ? '' : 's'} — tap to accept.`, url: '/merchant', tag: `store-order-${o.id}`, urgent: true }));
    }
  });

  orders.bus.on('offer', (riderId, orderId, evDb) => {
    if (evDb && evDb !== db) return;
    const offer = orders.offerView(db, orderId);
    if (!offer) return;
    const rand = (c) => `R${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
    fire(notifyUser(riderId, {
      title: `New trip · ${rand(offer.totalCents)}`,
      body: `${offer.store.name} · ${offer.totalKm} km · ${offer.secondsLeft}s to accept`,
      url: '/rider', tag: 'rider-offer', urgent: true, offer: true, ttl: Math.max(5, offer.secondsLeft),
    }));
  });

  orders.bus.on('low_stock', (productId, evDb) => {
    if (evDb !== db) return;
    const r = db.prepare('SELECT p.name, p.stock, s.owner_id FROM products p JOIN stores s ON s.id = p.store_id WHERE p.id = ?').get(productId);
    if (r) fire(notifyUser(r.owner_id, { title: r.stock ? `Running low: ${r.name}` : `Sold out: ${r.name}`, body: r.stock ? `Only ${r.stock} left. Tap to restock.` : 'Customers can no longer order it. Tap to restock.', url: '/merchant', tag: `stock-${productId}` }));
  });

  orders.bus.on('store_escalation', (orderId, minutesLeft, evDb) => {
    if (evDb !== db) return;
    const o = db.prepare('SELECT o.code, s.owner_id FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = ?').get(orderId);
    if (o) fire(notifyUser(o.owner_id, { title: `⏰ Still waiting: #${o.code}`, body: `Accept in the next ${minutesLeft} min or it will be declined and refunded.`, url: '/merchant', tag: `store-order-${orderId}`, urgent: true }));
  });

  orders.bus.on('payout', (storeId, amountCents, evDb) => {
    if (evDb !== db) return;
    const s = db.prepare('SELECT owner_id FROM stores WHERE id = ?').get(storeId);
    if (s) fire(notifyUser(s.owner_id, { title: `💸 Payout sent: R${(amountCents / 100).toFixed(2)}`, body: 'It should reach your account within 1–2 working days.', url: '/merchant', tag: `payout-${storeId}` }));
  });

  app.locals.notifyUser = notifyUser;
}

function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { registerPush, CUSTOMER_MESSAGES };

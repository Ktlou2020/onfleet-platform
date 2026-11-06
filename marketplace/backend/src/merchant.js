'use strict';
const compliance = require('./compliance');
const orders = require('./orders');
const pricing = require('./pricing');
const { availability, parseHours, validateHours } = require('./storeHours');

// The store owner's console: the live order board, busy controls, opening
// hours, the menu, insights, payouts and reviews.

const DECLINE_REASONS = {
  out_of_stock: 'An item is out of stock',
  too_busy: 'The store is too busy right now',
  closing: 'The store is about to close',
  cant_verify: 'The order could not be prepared',
  other: 'The store could not take this order',
};
const PREP_CHOICES = [5, 10, 15, 20, 30];
const LOW_STOCK = 3;
const ph = (list) => list.map(() => '?').join(',');
const DAY = (col) => `date(${col}, '+2 hours')`;

function registerMerchantRoutes(app, { db, auth, requireAdult, audit, refund, storeSummary, productView, categoriesById, settings, slugify }) {
  const merchant = auth('merchant');
  const myStore = (userId) => db.prepare('SELECT * FROM stores WHERE owner_id = ?').get(userId);
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  function requireStore(req) {
    const s = myStore(req.user.id);
    if (!s) throw new orders.OrderError('Set up your store first', 404);
    return s;
  }

  function storeView(s) {
    return {
      ...storeSummary({ ...s, city_slug: one('SELECT slug FROM cities WHERE id = ?', s.city_id)?.slug }),
      status: s.status, deliveryRadiusKm: s.delivery_radius_km, licenceNumber: s.licence_number,
      licenceCategories: JSON.parse(s.licence_categories), licenceVerified: !!s.licence_verified,
      switchedOn: !!s.is_open, pausedUntil: s.paused_until && new Date(s.paused_until) > new Date() ? s.paused_until : null,
      busyExtraMinutes: s.busy_extra_minutes, hours: parseHours(s.hours), phone: s.phone,
      availability: availability(s),
    };
  }

  // ---- Store ------------------------------------------------------------------
  app.get('/api/merchant/store', merchant, (req, res) => {
    const s = myStore(req.user.id);
    res.json({ store: s ? storeView(s) : null, declineReasons: DECLINE_REASONS, prepChoices: PREP_CHOICES });
  });

  app.post('/api/merchant/store', merchant, requireAdult, (req, res) => {
    if (myStore(req.user.id)) return res.status(409).json({ error: 'You already have a store' });
    const b = req.body || {};
    const city = one('SELECT * FROM cities WHERE slug = ?', b.city);
    if (!city) return res.status(400).json({ error: 'Choose a city' });
    if (!b.name?.trim() || !b.address?.trim()) return res.status(400).json({ error: 'Store name and address are required' });
    const lat = Number(b.lat ?? city.lat);
    const lng = Number(b.lng ?? city.lng);
    let slug = slugify(b.name);
    if (one('SELECT 1 FROM stores WHERE slug = ?', slug)) slug = `${slug}-${city.slug}-${Date.now() % 10000}`;
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO stores (owner_id, slug, name, description, city_id, address, lat, lng, licence_number, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, slug, b.name.trim(), String(b.description || '').slice(0, 400), city.id, b.address.trim(), lat, lng, b.licenceNumber?.trim() || null, b.phone?.trim() || null);
    audit(req.user.id, 'store_applied', { storeId: lastInsertRowid });
    res.status(201).json({ store: storeView(one('SELECT * FROM stores WHERE id = ?', lastInsertRowid)) });
  });

  app.patch('/api/merchant/store', merchant, (req, res) => {
    const s = requireStore(req);
    const b = req.body || {};
    const clamp = (v, lo, hi, dflt) => Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : dflt, lo), hi);
    let hours = s.hours;
    if (b.hours !== undefined) {
      try { hours = b.hours === null ? null : JSON.stringify(validateHours(b.hours)); } catch (e) { return res.status(400).json({ error: e.message }); }
    }
    let pausedUntil = s.paused_until;
    if (b.pauseMinutes !== undefined) {
      const m = Number(b.pauseMinutes);
      if (![0, 15, 30, 60, 120].includes(m)) return res.status(400).json({ error: 'Pause for 15, 30, 60 or 120 minutes' });
      pausedUntil = m ? new Date(Date.now() + m * 60000).toISOString() : null;
    }
    if (b.busyExtraMinutes !== undefined && ![0, 10, 20, 30].includes(Number(b.busyExtraMinutes))) return res.status(400).json({ error: 'Add 0, 10, 20 or 30 minutes' });
    const next = {
      is_open: b.isOpen === undefined ? s.is_open : b.isOpen ? 1 : 0,
      description: b.description === undefined ? s.description : String(b.description).slice(0, 400),
      prep_minutes: b.prepMinutes === undefined ? s.prep_minutes : clamp(b.prepMinutes, 3, 60, 10),
      delivery_radius_km: b.deliveryRadiusKm === undefined ? s.delivery_radius_km : clamp(b.deliveryRadiusKm, 1, 25, 8),
      licence_number: b.licenceNumber === undefined ? s.licence_number : String(b.licenceNumber).trim() || null,
      busy_extra_minutes: b.busyExtraMinutes === undefined ? s.busy_extra_minutes : Number(b.busyExtraMinutes),
      phone: b.phone === undefined ? s.phone : String(b.phone).trim().slice(0, 20) || null,
    };
    // Changing the licence number puts it back in the review queue.
    const licenceChanged = next.licence_number !== s.licence_number;
    db.prepare(`UPDATE stores SET is_open = ?, description = ?, prep_minutes = ?, delivery_radius_km = ?, licence_number = ?,
      busy_extra_minutes = ?, phone = ?, hours = ?, paused_until = ?,
      licence_verified = CASE WHEN ? THEN 0 ELSE licence_verified END WHERE id = ?`)
      .run(next.is_open, next.description, next.prep_minutes, next.delivery_radius_km, next.licence_number,
        next.busy_extra_minutes, next.phone, hours, pausedUntil, licenceChanged ? 1 : 0, s.id);
    if (b.pauseMinutes !== undefined) audit(req.user.id, Number(b.pauseMinutes) ? 'store_paused' : 'store_resumed', { storeId: s.id, minutes: Number(b.pauseMinutes) });
    res.json({ store: storeView(myStore(req.user.id)) });
  });

  // ---- Menu -------------------------------------------------------------------
  app.get('/api/merchant/products', merchant, (req, res) => {
    const s = myStore(req.user.id);
    if (!s) return res.json({ products: [], categories: [] });
    const cats = categoriesById();
    const st = settings();
    const sold = Object.fromEntries(db.prepare(`SELECT i.product_id, SUM(i.qty) AS n FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.store_id = ? AND o.status = 'delivered' AND o.delivered_at > datetime('now', '-7 days') GROUP BY i.product_id`).all(s.id).map((r) => [r.product_id, r.n]));
    const products = db.prepare('SELECT * FROM products WHERE store_id = ? ORDER BY active DESC, name').all(s.id).map((p) => {
      const sell = compliance.canSell({ category: cats[p.category_id], store: s, settings: st });
      return {
        ...productView(p, cats[p.category_id]), active: !!p.active, live: !!p.active && sell.ok && p.stock > 0,
        blockedReason: sell.ok ? null : sell.reason, lowStock: p.active && p.stock > 0 && p.stock <= LOW_STOCK, soldThisWeek: sold[p.id] || 0,
      };
    });
    res.json({ products, categories: db.prepare('SELECT slug, name, icon, regulated FROM categories ORDER BY sort').all() });
  });

  function productInput(b, existing = {}) {
    const cat = b.category ? one('SELECT * FROM categories WHERE slug = ?', b.category) : null;
    if (b.category && !cat) throw new orders.OrderError('Unknown category');
    const price = b.priceCents === undefined ? existing.price_cents : Math.round(Number(b.priceCents));
    if (!Number.isInteger(price) || price <= 0) throw new orders.OrderError('Enter a price above R0');
    const stock = b.stock === undefined ? existing.stock ?? 0 : Math.round(Number(b.stock));
    if (!Number.isInteger(stock) || stock < 0) throw new orders.OrderError('Stock cannot be negative');
    const name = b.name === undefined ? existing.name : String(b.name).trim();
    if (!name) throw new orders.OrderError('Enter a product name');
    const num = (v, old) => (v === undefined ? old ?? null : v === null || v === '' ? null : Number(v));
    return {
      category_id: cat ? cat.id : existing.category_id,
      name, price_cents: price, stock,
      description: b.description === undefined ? existing.description ?? '' : String(b.description).slice(0, 600),
      unit: b.unit === undefined ? existing.unit ?? 'each' : String(b.unit).slice(0, 20),
      thc_pct: num(b.thcPct, existing.thc_pct), cbd_pct: num(b.cbdPct, existing.cbd_pct),
      strain_type: b.strainType === undefined ? existing.strain_type ?? null : b.strainType || null,
      active: b.active === undefined ? existing.active ?? 1 : b.active ? 1 : 0,
    };
  }

  app.post('/api/merchant/products', merchant, (req, res) => {
    const s = requireStore(req);
    if (!req.body?.category) return res.status(400).json({ error: 'Choose a category' });
    const p = productInput(req.body);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO products (store_id, category_id, name, description, price_cents, unit, stock, thc_pct, cbd_pct, strain_type, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.id, p.category_id, p.name, p.description, p.price_cents, p.unit, p.stock, p.thc_pct, p.cbd_pct, p.strain_type, p.active);
    res.status(201).json({ id: lastInsertRowid });
  });

  app.patch('/api/merchant/products/:id', merchant, (req, res) => {
    const s = requireStore(req);
    const existing = one('SELECT * FROM products WHERE id = ? AND store_id = ?', req.params.id, s.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    const p = productInput(req.body || {}, existing);
    db.prepare(`UPDATE products SET category_id = ?, name = ?, description = ?, price_cents = ?, unit = ?, stock = ?,
      thc_pct = ?, cbd_pct = ?, strain_type = ?, active = ? WHERE id = ?`)
      .run(p.category_id, p.name, p.description, p.price_cents, p.unit, p.stock, p.thc_pct, p.cbd_pct, p.strain_type, p.active, existing.id);
    res.json({ ok: true });
  });

  // ---- Live orders --------------------------------------------------------------
  // Which column of the board an order sits in.
  function lane(o) {
    if (o.status === 'placed') return 'new';
    if (o.status === 'accepted' || o.status === 'preparing') return 'preparing';
    if (o.status === 'ready') return 'ready';
    if (o.status === 'picked_up') return 'out';
    return 'done';
  }

  function boardView(id) {
    const v = orders.orderView(db, id, 'merchant');
    const extra = one(`SELECT accepted_at, ready_at, prep_minutes,
        CAST((julianday('now') - julianday(updated_at)) * 86400 AS INTEGER) AS since_change_s,
        CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS age_s,
        CASE WHEN accepted_at IS NOT NULL AND prep_minutes IS NOT NULL
          THEN CAST((julianday(accepted_at) + prep_minutes / 1440.0 - julianday('now')) * 86400 AS INTEGER) END AS prep_left_s
      FROM orders WHERE id = ?`, id);
    return {
      ...v, lane: lane(v), acceptedAt: extra.accepted_at, readyAt: extra.ready_at, prepMinutes: extra.prep_minutes,
      waitingSeconds: extra.since_change_s, ageSeconds: extra.age_s, prepSecondsLeft: extra.prep_left_s,
      riderAtStore: !!v.milestones.arrivedStoreAt && ['accepted', 'preparing', 'ready'].includes(v.status),
    };
  }

  app.get('/api/merchant/orders', merchant, (req, res) => {
    const s = myStore(req.user.id);
    if (!s) return res.json({ live: [], recent: [], stats: null });
    const live = db.prepare(`SELECT id FROM orders WHERE store_id = ? AND status IN (${ph(orders.ACTIVE)}) ORDER BY id`).all(s.id, ...orders.ACTIVE);
    const recent = db.prepare(`SELECT id FROM orders WHERE store_id = ? AND status IN ('delivered','cancelled','rejected','returned')
      AND ${DAY('updated_at')} = date('now', '+2 hours') ORDER BY updated_at DESC LIMIT 40`).all(s.id);
    const t = one(`SELECT COUNT(*) AS n, COALESCE(SUM(subtotal_cents), 0) AS sales FROM orders
      WHERE store_id = ? AND status = 'delivered' AND ${DAY('delivered_at')} = date('now', '+2 hours')`, s.id);
    const prep = one(`SELECT AVG((julianday(ready_at) - julianday(accepted_at)) * 1440) AS m FROM orders
      WHERE store_id = ? AND ready_at IS NOT NULL AND ${DAY('ready_at')} = date('now', '+2 hours')`, s.id);
    const lowStock = db.prepare('SELECT id, name, stock FROM products WHERE store_id = ? AND active = 1 AND stock <= ? ORDER BY stock, name LIMIT 10').all(s.id, LOW_STOCK);
    // Pre-orders waiting for delivery time, so the store can plan stock and staff.
    const scheduled = db.prepare("SELECT id FROM orders WHERE store_id = ? AND status = 'scheduled' ORDER BY scheduled_for, id").all(s.id)
      .map(({ id }) => orders.orderView(db, id, 'merchant'));
    res.json({
      store: storeView(s),
      live: live.map(({ id }) => boardView(id)),
      recent: recent.map(({ id }) => boardView(id)),
      scheduled,
      stats: { todayOrders: t.n, todaySalesCents: t.sales, avgPrepMinutes: prep.m == null ? null : Math.round(prep.m) },
      lowStock,
    });
  });

  app.post('/api/merchant/orders/:id/status', merchant, (req, res) => {
    const s = requireStore(req);
    const order = one('SELECT * FROM orders WHERE id = ? AND store_id = ?', req.params.id, s.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const to = req.body?.status;
    let note = req.body?.reason;
    if (to === 'rejected') {
      const code = req.body?.reasonCode;
      if (!DECLINE_REASONS[code]) return res.status(400).json({ error: 'Choose why you are declining' });
      note = `${DECLINE_REASONS[code]}${note ? ` — ${String(note).slice(0, 160)}` : ''}`;
    }
    let prep = null;
    if (to === 'accepted') {
      prep = Number(req.body?.prepMinutes ?? s.prep_minutes + s.busy_extra_minutes);
      if (!Number.isInteger(prep) || prep < 3 || prep > 60) return res.status(400).json({ error: 'Choose a prep time between 3 and 60 minutes' });
    }
    orders.transition(db, order.id, 'merchant', to, { note, refund });
    if (to === 'accepted') {
      // The customer's ETA follows the store's own prep promise: time so
      // far, plus prep, plus dispatch and the ride.
      const elapsed = one("SELECT (julianday('now') - julianday(created_at)) * 1440 AS m FROM orders WHERE id = ?", order.id).m;
      const eta = Math.round(elapsed + pricing.etaMinutes(order.distance_km, prep));
      db.prepare("UPDATE orders SET accepted_at = datetime('now'), prep_minutes = ?, eta_minutes = ? WHERE id = ?").run(prep, eta, order.id);
      orders.bus.emit('order', order.id);
    }
    if (to === 'ready') {
      db.prepare("UPDATE orders SET ready_at = datetime('now') WHERE id = ?").run(order.id);
      orders.bus.emit('order', order.id);
    }
    res.json({ order: boardView(order.id) });
  });

  // ---- Insights ----------------------------------------------------------------
  app.get('/api/merchant/insights', merchant, (req, res) => {
    const s = requireStore(req);
    const days = [7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const since = `date('now', '+2 hours', '-${days - 1} days')`;
    const totals = one(`SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal_cents), 0) AS sales,
        AVG((julianday(ready_at) - julianday(accepted_at)) * 1440) AS prep
      FROM orders WHERE store_id = ? AND status = 'delivered' AND ${DAY('delivered_at')} >= ${since}`, s.id);
    const decided = one(`SELECT SUM(accepted_at IS NOT NULL) AS accepted, SUM(status = 'rejected') AS rejected FROM orders
      WHERE store_id = ? AND ${DAY('created_at')} >= ${since} AND status <> 'pending_payment'`, s.id);
    const dec = (decided.accepted || 0) + (decided.rejected || 0);
    const daily = Object.fromEntries(db.prepare(`SELECT ${DAY('delivered_at')} AS d, COUNT(*) AS n, SUM(subtotal_cents) AS sales FROM orders
      WHERE store_id = ? AND status = 'delivered' AND ${DAY('delivered_at')} >= ${since} GROUP BY d`).all(s.id).map((r) => [r.d, r]));
    const [y, m, d] = one("SELECT date('now', '+2 hours') AS d").d.split('-').map(Number);
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10);
      series.push({ day, orders: daily[day]?.n || 0, salesCents: daily[day]?.sales || 0 });
    }
    const hourlyRows = db.prepare(`SELECT CAST(strftime('%H', created_at, '+2 hours') AS INTEGER) AS h, COUNT(*) AS n FROM orders
      WHERE store_id = ? AND status = 'delivered' AND ${DAY('created_at')} >= ${since} GROUP BY h`).all(s.id);
    const top = db.prepare(`SELECT i.product_id AS id, i.name, SUM(i.qty) AS qty, SUM(i.qty * i.price_cents) AS sales
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.store_id = ? AND o.status = 'delivered' AND ${DAY('o.delivered_at')} >= ${since}
      GROUP BY i.product_id ORDER BY sales DESC LIMIT 8`).all(s.id);
    res.json({
      days,
      totals: {
        orders: totals.orders, salesCents: totals.sales, avgOrderCents: totals.orders ? Math.round(totals.sales / totals.orders) : 0,
        avgPrepMinutes: totals.prep == null ? null : Math.round(totals.prep),
        acceptanceRate: dec ? Math.round(((decided.accepted || 0) / dec) * 100) : null,
        rating: s.rating_count ? Math.round((s.rating_sum / s.rating_count) * 10) / 10 : null, ratingCount: s.rating_count,
      },
      series,
      hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: hourlyRows.find((r) => r.h === h)?.n || 0 })),
      topProducts: top.map((t) => ({ id: t.id, name: t.name, qty: t.qty, salesCents: t.sales })),
    });
  });

  // ---- Payouts -----------------------------------------------------------------
  // The store is owed the item subtotal of every delivered order; the
  // platform keeps delivery and service fees. Refunded orders owe nothing.
  app.get('/api/merchant/payouts', merchant, (req, res) => {
    const s = requireStore(req);
    // Weeks run Monday to Sunday, SAST.
    const rows = db.prepare(`SELECT date(delivered_at, '+2 hours', 'weekday 0', '-6 days') AS week,
        COUNT(*) AS orders, SUM(subtotal_cents) AS sales
      FROM orders WHERE store_id = ? AND status = 'delivered' AND delivered_at > datetime('now', '-84 days')
      GROUP BY week ORDER BY week DESC`).all(s.id);
    const refunds = Object.fromEntries(db.prepare(`SELECT date(updated_at, '+2 hours', 'weekday 0', '-6 days') AS week, COUNT(*) AS n
      FROM orders WHERE store_id = ? AND payment_status = 'refunded' AND updated_at > datetime('now', '-84 days') GROUP BY week`).all(s.id).map((r) => [r.week, r.n]));
    const thisWeek = one("SELECT date('now', '+2 hours', 'weekday 0', '-6 days') AS w").w;
    res.json({
      statements: rows.map((r) => ({
        weekStart: r.week, orders: r.orders, salesCents: r.sales, refundedOrders: refunds[r.week] || 0, payoutCents: r.sales,
        status: r.week === thisWeek ? 'in_progress' : 'due',
      })),
      owedCents: rows.reduce((n, r) => n + r.sales, 0),
      note: 'You receive the item total of every delivered order. Delivery and service fees are kept by the platform. Payouts are made weekly by EFT.',
    });
  });

  // ---- Reviews -----------------------------------------------------------------
  app.get('/api/merchant/reviews', merchant, (req, res) => {
    const s = requireStore(req);
    const rows = db.prepare(`SELECT r.id, r.rating, r.comment, r.created_at, r.store_reply, r.replied_at, u.name, o.code
      FROM reviews r JOIN users u ON u.id = r.customer_id JOIN orders o ON o.id = r.order_id
      WHERE r.store_id = ? ORDER BY r.id DESC LIMIT 100`).all(s.id);
    const dist = [5, 4, 3, 2, 1].map((n) => ({ stars: n, count: rows.filter((r) => r.rating === n).length }));
    res.json({
      rating: s.rating_count ? Math.round((s.rating_sum / s.rating_count) * 10) / 10 : null,
      ratingCount: s.rating_count,
      distribution: dist,
      reviews: rows.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, at: r.created_at, name: r.name.split(' ')[0], orderCode: r.code, reply: r.store_reply, repliedAt: r.replied_at })),
    });
  });

  app.post('/api/merchant/reviews/:id/reply', merchant, (req, res) => {
    const s = requireStore(req);
    const text = String(req.body?.reply || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'Write a reply first' });
    const r = db.prepare("UPDATE reviews SET store_reply = ?, replied_at = datetime('now') WHERE id = ? AND store_id = ?").run(text, req.params.id, s.id);
    if (!r.changes) return res.status(404).json({ error: 'Review not found' });
    res.json({ ok: true });
  });
}

module.exports = { registerMerchantRoutes, DECLINE_REASONS };

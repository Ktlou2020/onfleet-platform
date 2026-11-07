'use strict';
const compliance = require('./compliance');
const orders = require('./orders');

// The customer's own things: saved addresses, favourite stores, ordering
// again, and getting help with an order.

const HELP_TYPES = {
  missing_item: 'Something was missing',
  wrong_item: 'I got the wrong item',
  damaged: 'Something arrived damaged',
  late: 'My order was very late',
  not_received: "I didn't receive my order",
  rider: 'A problem with the rider',
  other: 'Something else',
};
const MAX_ADDRESSES = 10;

function registerCustomerRoutes(app, { db, auth, audit, refund, storeSummary, productView, categoriesById, settings }) {
  const customer = auth('customer');
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  // ---- Saved addresses -----------------------------------------------------
  const addressView = (a) => ({ id: a.id, label: a.label, address: a.address, lat: a.lat, lng: a.lng, city: a.city, notes: a.notes });

  function addressInput(b, existing = {}) {
    const label = b.label === undefined ? existing.label : String(b.label).trim().slice(0, 30);
    const address = b.address === undefined ? existing.address : String(b.address).trim().slice(0, 200);
    const lat = b.lat === undefined ? existing.lat : Number(b.lat);
    const lng = b.lng === undefined ? existing.lng : Number(b.lng);
    if (!label) throw new orders.OrderError('Give the address a name, like Home or Work');
    if (!address || address.length < 5) throw new orders.OrderError('Enter the full street address');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new orders.OrderError('Drop the pin on the map');
    return {
      label, address, lat, lng,
      city: b.city === undefined ? existing.city ?? null : String(b.city || '').slice(0, 40) || null,
      notes: b.notes === undefined ? existing.notes ?? '' : String(b.notes).slice(0, 200),
    };
  }

  app.get('/api/me/addresses', customer, (req, res) => {
    res.json({ addresses: db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY id').all(req.user.id).map(addressView) });
  });

  app.post('/api/me/addresses', customer, (req, res) => {
    if (one('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?', req.user.id).n >= MAX_ADDRESSES) return res.status(400).json({ error: `You can save up to ${MAX_ADDRESSES} addresses` });
    const a = addressInput(req.body || {});
    const { lastInsertRowid } = db.prepare('INSERT INTO addresses (user_id, label, address, lat, lng, city, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, a.label, a.address, a.lat, a.lng, a.city, a.notes);
    res.status(201).json({ address: addressView(one('SELECT * FROM addresses WHERE id = ?', lastInsertRowid)) });
  });

  app.patch('/api/me/addresses/:id', customer, (req, res) => {
    const existing = one('SELECT * FROM addresses WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Address not found' });
    const a = addressInput(req.body || {}, existing);
    db.prepare('UPDATE addresses SET label = ?, address = ?, lat = ?, lng = ?, city = ?, notes = ? WHERE id = ?').run(a.label, a.address, a.lat, a.lng, a.city, a.notes, existing.id);
    res.json({ address: addressView(one('SELECT * FROM addresses WHERE id = ?', existing.id)) });
  });

  app.delete('/api/me/addresses/:id', customer, (req, res) => {
    const r = db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Address not found' });
    res.json({ ok: true });
  });

  // ---- Favourite stores ----------------------------------------------------
  function storeRow(id) {
    return one(`SELECT s.*, c.slug AS city_slug FROM stores s JOIN cities c ON c.id = s.city_id WHERE s.id = ? AND s.status = 'approved'`, id);
  }

  app.get('/api/me/favourites', customer, (req, res) => {
    const origin = Number.isFinite(Number(req.query.lat)) && req.query.lat !== undefined ? { lat: Number(req.query.lat), lng: Number(req.query.lng) } : null;
    const ids = db.prepare('SELECT store_id FROM favourites WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ stores: ids.map(({ store_id: id }) => storeRow(id)).filter(Boolean).map((s) => storeSummary(s, origin)) });
  });

  app.put('/api/me/favourites/:storeId', customer, (req, res) => {
    if (!storeRow(req.params.storeId)) return res.status(404).json({ error: 'Store not found' });
    db.prepare('INSERT OR IGNORE INTO favourites (user_id, store_id) VALUES (?, ?)').run(req.user.id, req.params.storeId);
    res.json({ favourite: true });
  });

  app.delete('/api/me/favourites/:storeId', customer, (req, res) => {
    db.prepare('DELETE FROM favourites WHERE user_id = ? AND store_id = ?').run(req.user.id, req.params.storeId);
    res.json({ favourite: false });
  });

  // ---- Order again ------------------------------------------------------------
  // What can go back in the basket from a past order, at today's prices,
  // and what can't (sold out, no longer listed, not sellable).
  app.get('/api/orders/:id/reorder', customer, (req, res) => {
    const o = one('SELECT * FROM orders WHERE id = ? AND customer_id = ?', req.params.id, req.user.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const s = storeRow(o.store_id);
    if (!s) return res.status(409).json({ error: 'That store is no longer on the platform' });
    const cats = categoriesById();
    const st = settings();
    const items = db.prepare('SELECT product_id, name, qty FROM order_items WHERE order_id = ?').all(o.id).map((i) => {
      const p = one('SELECT * FROM products WHERE id = ? AND store_id = ?', i.product_id, s.id);
      const sellable = p && p.active && compliance.canSell({ category: cats[p.category_id], store: s, settings: st }).ok;
      if (!sellable) return { productId: i.product_id, name: i.name, qty: i.qty, available: false, reason: 'No longer available' };
      if (p.stock <= 0) return { productId: p.id, name: p.name, qty: i.qty, available: false, reason: 'Sold out' };
      const view = productView(p, cats[p.category_id]);
      return { ...view, productId: p.id, qty: Math.min(i.qty, p.stock), available: true, reduced: p.stock < i.qty };
    });
    res.json({ store: storeSummary(s), items });
  });

  // ---- Sold-out items: the customer chooses --------------------------------
  app.post('/api/orders/:id/item-decision', customer, (req, res) => {
    const o = one('SELECT * FROM orders WHERE id = ? AND customer_id = ?', req.params.id, req.user.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.awaiting_customer !== 'item_unavailable') return res.status(409).json({ error: 'Nothing to decide on this order' });
    if (req.body?.decision === 'continue') {
      orders.removeUnavailable(db, o.id, refund);
    } else if (req.body?.decision === 'cancel') {
      orders.transition(db, o.id, 'customer', 'cancelled', { note: 'Cancelled by customer after items sold out', refund });
    } else return res.status(400).json({ error: 'Choose to continue or cancel' });
    res.json({ order: orders.orderView(db, o.id, 'customer') });
  });

  // ---- Help with an order ---------------------------------------------------
  app.post('/api/orders/:id/help', customer, (req, res) => {
    const o = one('SELECT * FROM orders WHERE id = ? AND customer_id = ?', req.params.id, req.user.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status === 'pending_payment') return res.status(409).json({ error: 'This order was never paid for' });
    const type = req.body?.type;
    if (!HELP_TYPES[type]) return res.status(400).json({ error: 'Choose what went wrong' });
    const open = one("SELECT id FROM help_requests WHERE order_id = ? AND status = 'open'", o.id);
    if (open) return res.status(409).json({ error: "We're already looking into this order — we'll be in touch" });
    const { lastInsertRowid } = db.prepare('INSERT INTO help_requests (order_id, customer_id, type, note) VALUES (?, ?, ?, ?)')
      .run(o.id, req.user.id, type, String(req.body?.note || '').slice(0, 600));
    audit(req.user.id, 'help_requested', { orderId: o.id, type });
    res.status(201).json({ request: helpView(lastInsertRowid) });
  });

  function helpView(id) {
    const h = one(`SELECT h.*, o.code, s.name AS store_name, u.name AS customer_name, u.email, u.phone
      FROM help_requests h JOIN orders o ON o.id = h.order_id JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = h.customer_id WHERE h.id = ?`, id);
    return {
      id: h.id, orderId: h.order_id, orderCode: h.code, storeName: h.store_name, type: h.type, typeLabel: HELP_TYPES[h.type] || h.type,
      note: h.note, status: h.status, resolution: h.resolution, createdAt: h.created_at, resolvedAt: h.resolved_at,
      customer: { name: h.customer_name, email: h.email, phone: h.phone },
    };
  }

  app.get('/api/orders/:id/help', customer, (req, res) => {
    const o = one('SELECT id FROM orders WHERE id = ? AND customer_id = ?', req.params.id, req.user.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    res.json({ requests: db.prepare('SELECT id FROM help_requests WHERE order_id = ? ORDER BY id DESC').all(o.id).map(({ id }) => helpView(id)), types: HELP_TYPES });
  });

  app.get('/api/admin/help', auth('admin'), (req, res) => {
    const rows = db.prepare("SELECT id FROM help_requests ORDER BY status = 'resolved', id DESC LIMIT 100").all();
    res.json({ requests: rows.map(({ id }) => helpView(id)) });
  });

  app.post('/api/admin/help/:id/resolve', auth('admin'), (req, res) => {
    const resolution = String(req.body?.resolution || '').trim().slice(0, 400);
    if (!resolution) return res.status(400).json({ error: 'Say how it was resolved — the customer sees this' });
    const r = db.prepare("UPDATE help_requests SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'open'").run(resolution, req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'No open request with that id' });
    audit(req.user.id, 'help_resolved', { id: Number(req.params.id) });
    res.json({ request: helpView(Number(req.params.id)) });
  });
}

module.exports = { registerCustomerRoutes, HELP_TYPES };

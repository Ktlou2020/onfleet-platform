'use strict';
const compliance = require('./compliance');
const orders = require('./orders');
const pricing = require('./pricing');
const { availability, parseHours, validateHours } = require('./storeHours');
const sms = require('./sms');
const media = require('./media');
const csv = require('./csv');
const { productAvailability, validateWindow } = require('./storeHours');

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
const ESCALATE_AFTER_MINUTES = 3;
const DECISION_MINUTES = 5;
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
      busyExtraMinutes: s.busy_extra_minutes, hours: parseHours(s.hours), phone: s.phone, autoAccept: !!s.auto_accept,
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
      auto_accept: b.autoAccept === undefined ? s.auto_accept : b.autoAccept ? 1 : 0,
    };
    // Changing the licence number puts it back in the review queue.
    const licenceChanged = next.licence_number !== s.licence_number;
    db.prepare(`UPDATE stores SET is_open = ?, description = ?, prep_minutes = ?, delivery_radius_km = ?, licence_number = ?,
      busy_extra_minutes = ?, phone = ?, hours = ?, paused_until = ?, auto_accept = ?,
      licence_verified = CASE WHEN ? THEN 0 ELSE licence_verified END WHERE id = ?`)
      .run(next.is_open, next.description, next.prep_minutes, next.delivery_radius_km, next.licence_number,
        next.busy_extra_minutes, next.phone, hours, pausedUntil, next.auto_accept, licenceChanged ? 1 : 0, s.id);
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
        blockedReason: sell.ok ? null : sell.reason, lowStock: !!p.active && p.stock > 0 && p.stock <= p.low_stock_at, soldThisWeek: sold[p.id] || 0,
        lowStockAt: p.low_stock_at, availableDays: p.available_days ? JSON.parse(p.available_days) : [], availableFrom: p.available_from, availableTo: p.available_to,
        availableNow: productAvailability(p).now, availabilityNote: productAvailability(p).label,
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
      ...extraInput(b, existing),
    };
  }

  // Variants, featuring, availability windows and the low-stock line.
  function extraInput(b, existing) {
    const out = {
      variant_of: b.variantOf === undefined ? existing.variant_of ?? null : b.variantOf ? Number(b.variantOf) : null,
      variant_label: b.variantLabel === undefined ? existing.variant_label ?? null : String(b.variantLabel || '').trim().slice(0, 30) || null,
      featured: b.featured === undefined ? existing.featured ?? 0 : b.featured ? 1 : 0,
      available_days: b.availableDays === undefined ? existing.available_days ?? null : b.availableDays && b.availableDays.length ? JSON.stringify(b.availableDays) : null,
      available_from: b.availableFrom === undefined ? existing.available_from ?? null : b.availableFrom || null,
      available_to: b.availableTo === undefined ? existing.available_to ?? null : b.availableTo || null,
      low_stock_at: b.lowStockAt === undefined ? existing.low_stock_at ?? LOW_STOCK : Math.round(Number(b.lowStockAt)),
    };
    if (!Number.isInteger(out.low_stock_at) || out.low_stock_at < 0 || out.low_stock_at > 1000) throw new orders.OrderError('Low-stock alert must be 0 to 1000');
    try { validateWindow(out.available_days ? JSON.parse(out.available_days) : null, out.available_from, out.available_to); } catch (e) { throw new orders.OrderError(e.message); }
    return out;
  }

  // A variant hangs off one main product in the same store, one level deep.
  function checkVariant(storeId, p, selfId) {
    if (!p.variant_of) return;
    if (p.variant_of === selfId) throw new orders.OrderError("A product can't be an option of itself");
    const parent = one('SELECT * FROM products WHERE id = ? AND store_id = ?', p.variant_of, storeId);
    if (!parent) throw new orders.OrderError('Choose a main product from your menu');
    if (parent.variant_of) throw new orders.OrderError('Pick the main product, not another option');
    if (selfId && one('SELECT 1 FROM products WHERE variant_of = ?', selfId)) throw new orders.OrderError('This product has its own options, so it must stay a main product');
  }

  const PRODUCT_COLS = ['category_id', 'name', 'description', 'price_cents', 'unit', 'stock', 'thc_pct', 'cbd_pct', 'strain_type', 'active',
    'variant_of', 'variant_label', 'featured', 'available_days', 'available_from', 'available_to', 'low_stock_at'];
  function insertProduct(storeId, p) {
    return db.prepare(`INSERT INTO products (store_id, ${PRODUCT_COLS.join(', ')}) VALUES (?, ${PRODUCT_COLS.map(() => '?').join(', ')})`)
      .run(storeId, ...PRODUCT_COLS.map((c) => p[c])).lastInsertRowid;
  }
  function updateProduct(id, p) {
    db.prepare(`UPDATE products SET ${PRODUCT_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...PRODUCT_COLS.map((c) => p[c]), id);
  }

  app.post('/api/merchant/products', merchant, (req, res) => {
    const s = requireStore(req);
    if (!req.body?.category) return res.status(400).json({ error: 'Choose a category' });
    const p = productInput(req.body);
    checkVariant(s.id, p, null);
    res.status(201).json({ id: insertProduct(s.id, p) });
  });

  app.patch('/api/merchant/products/:id', merchant, (req, res) => {
    const s = requireStore(req);
    const existing = one('SELECT * FROM products WHERE id = ? AND store_id = ?', req.params.id, s.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    const p = productInput(req.body || {}, existing);
    checkVariant(s.id, p, existing.id);
    updateProduct(existing.id, p);
    res.json({ ok: true });
  });

  // ---- Photos -------------------------------------------------------------------
  app.post('/api/merchant/products/:id/photo', merchant, (req, res) => {
    const s = requireStore(req);
    const p = one('SELECT * FROM products WHERE id = ? AND store_id = ?', req.params.id, s.id);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    let name;
    try { name = media.saveDataUrl(req.body?.dataUrl); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    db.prepare('UPDATE products SET photo = ? WHERE id = ?').run(name, p.id);
    media.remove(p.photo);
    res.json({ photoUrl: media.url(name) });
  });

  app.delete('/api/merchant/products/:id/photo', merchant, (req, res) => {
    const s = requireStore(req);
    const p = one('SELECT * FROM products WHERE id = ? AND store_id = ?', req.params.id, s.id);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    db.prepare('UPDATE products SET photo = NULL WHERE id = ?').run(p.id);
    media.remove(p.photo);
    res.json({ ok: true });
  });

  // ---- What to reorder --------------------------------------------------------
  // Enough to cover the next week at the last fortnight's pace.
  function restockList(storeId) {
    const sold = Object.fromEntries(db.prepare(`SELECT i.product_id, SUM(i.qty) AS n FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.store_id = ? AND o.status = 'delivered' AND i.unavailable = 0 AND o.delivered_at > datetime('now', '-14 days') GROUP BY i.product_id`).all(storeId).map((r) => [r.product_id, r.n]));
    return db.prepare('SELECT * FROM products WHERE store_id = ? AND active = 1 ORDER BY name').all(storeId).map((p) => {
      const perDay = (sold[p.id] || 0) / 14;
      const need = Math.max(0, Math.ceil(perDay * 7) - p.stock, p.stock <= p.low_stock_at ? p.low_stock_at * 2 - p.stock : 0);
      return { id: p.id, name: p.name + (p.variant_label ? ` (${p.variant_label})` : ''), stock: p.stock, lowStockAt: p.low_stock_at, soldLast14Days: sold[p.id] || 0, perDay: Math.round(perDay * 10) / 10, suggestedOrder: need };
    }).filter((r) => r.suggestedOrder > 0).sort((a, b) => b.suggestedOrder - a.suggestedOrder);
  }

  app.get('/api/merchant/restock', merchant, (req, res) => {
    const s = requireStore(req);
    const list = restockList(s.id);
    if (req.query.format === 'csv') {
      res.type('text/csv').attachment(`restock-${s.slug}.csv`);
      return res.send(csv.stringify(['name', 'stock', 'sold_last_14_days', 'suggested_order'], list.map((r) => ({ name: r.name, stock: r.stock, sold_last_14_days: r.soldLast14Days, suggested_order: r.suggestedOrder }))));
    }
    res.json({ items: list });
  });

  // ---- Spreadsheet import / export --------------------------------------------
  const CSV_COLS = ['id', 'name', 'category', 'price', 'unit', 'stock', 'low_stock_at', 'active', 'featured', 'option_of', 'option_label', 'description'];

  app.get('/api/merchant/products.csv', merchant, (req, res) => {
    const s = requireStore(req);
    const cats = categoriesById();
    const rows = db.prepare('SELECT * FROM products WHERE store_id = ? ORDER BY COALESCE(variant_of, id), id').all(s.id).map((p) => ({
      id: p.id, name: p.name, category: cats[p.category_id].slug, price: (p.price_cents / 100).toFixed(2), unit: p.unit, stock: p.stock,
      low_stock_at: p.low_stock_at, active: p.active ? 'yes' : 'no', featured: p.featured ? 'yes' : 'no', option_of: p.variant_of || '', option_label: p.variant_label || '', description: p.description,
    }));
    res.type('text/csv').attachment(`menu-${s.slug}.csv`).send(csv.stringify(CSV_COLS, rows));
  });

  // Upload the same sheet back (or a new one). Rows with an id update that
  // product; rows without create one. Run with apply=false first to preview.
  app.post('/api/merchant/products/import', merchant, (req, res) => {
    const s = requireStore(req);
    const rows = csv.parse(req.body?.csv);
    if (!rows.length) return res.status(400).json({ error: 'That file has no rows under the header' });
    if (rows.length > 2000) return res.status(400).json({ error: 'Import up to 2 000 rows at a time' });
    const yes = (v, dflt) => (v === '' || v == null ? dflt : /^(yes|y|true|1)$/i.test(v));
    const results = [];
    const plan = [];
    for (const r of rows) {
      try {
        const existing = r.id ? one('SELECT * FROM products WHERE id = ? AND store_id = ?', Number(r.id), s.id) : null;
        if (r.id && !existing) throw new orders.OrderError(`No product with id ${r.id} in your store`);
        const price = r.price === '' || r.price == null ? undefined : Math.round(Number(String(r.price).replace(/[R\s,]/g, '')) * 100);
        const input = {
          name: r.name || undefined, category: r.category || undefined, priceCents: price, unit: r.unit || undefined,
          stock: r.stock === '' || r.stock == null ? undefined : Number(r.stock), lowStockAt: r.low_stock_at === '' || r.low_stock_at == null ? undefined : Number(r.low_stock_at),
          description: r.description === undefined ? undefined : r.description,
          active: r.active === undefined || r.active === '' ? undefined : yes(r.active, true), featured: r.featured === undefined || r.featured === '' ? undefined : yes(r.featured, false),
          variantOf: r.option_of === undefined ? undefined : r.option_of || null, variantLabel: r.option_label,
        };
        if (!existing && !input.category) throw new orders.OrderError('New products need a category');
        const p = productInput(input, existing || {});
        checkVariant(s.id, p, existing?.id || null);
        const norm = (v) => (typeof v === 'boolean' ? Number(v) : v ?? null);
        const same = existing && PRODUCT_COLS.every((c) => String(norm(p[c])) === String(norm(existing[c])));
        if (!same) plan.push({ existing, p });
        results.push({ row: r._row, action: same ? 'unchanged' : existing ? 'update' : 'create', name: p.name });
      } catch (e) {
        results.push({ row: r._row, action: 'error', name: r.name, error: e.message });
      }
    }
    const errors = results.filter((x) => x.action === 'error').length;
    if (req.body?.apply && !errors) {
      db.transaction(() => { for (const { existing, p } of plan) if (existing) updateProduct(existing.id, p); else insertProduct(s.id, p); })();
      audit(req.user.id, 'menu_imported', { storeId: s.id, rows: plan.length });
    }
    res.json({ applied: !!req.body?.apply && !errors, created: results.filter((x) => x.action === 'create').length, updated: results.filter((x) => x.action === 'update').length, unchanged: results.filter((x) => x.action === 'unchanged').length, errors, rows: results });
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
      riderEtaMinutes: riderEta(v),
      regulated: hasRegulated(id),
    };
  }

  // How far off the assigned rider is, so the bag is packed just in time.
  function riderEta(v) {
    if (!v.rider || v.milestones.arrivedStoreAt || !['accepted', 'preparing', 'ready'].includes(v.status)) return null;
    const r = one('SELECT r.lat, r.lng FROM riders r JOIN orders o ON o.rider_id = r.user_id WHERE o.id = ?', v.id);
    if (!r || r.lat == null) return null;
    return Math.max(1, Math.round((pricing.roadKm(r, v.store) / 25) * 60 + 1));
  }

  function hasRegulated(orderId) {
    return !!one(`SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id
      WHERE i.order_id = ? AND c.regulated = 1 AND i.unavailable = 0`, orderId);
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
    const lowStock = db.prepare('SELECT id, name, stock FROM products WHERE store_id = ? AND active = 1 AND stock <= low_stock_at ORDER BY stock, name LIMIT 10').all(s.id);
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
    if (order.awaiting_customer && to === 'accepted') return res.status(409).json({ error: 'Waiting for the customer to decide about the missing items' });
    if (to === 'accepted') {
      const prep = Number(req.body?.prepMinutes ?? s.prep_minutes + s.busy_extra_minutes);
      if (!Number.isInteger(prep) || prep < 3 || prep > 60) return res.status(400).json({ error: 'Choose a prep time between 3 and 60 minutes' });
      acceptOrder(order, prep);
      return res.json({ order: boardView(order.id) });
    }
    if (to === 'ready' && hasRegulated(order.id) && !req.body?.sealed) {
      return res.status(400).json({ error: 'Seal the bag and label it 18+ before marking it ready' });
    }
    orders.transition(db, order.id, 'merchant', to, { note, refund });
    if (to === 'ready') {
      db.prepare("UPDATE orders SET ready_at = datetime('now'), sealed = ? WHERE id = ?").run(req.body?.sealed ? 1 : 0, order.id);
      orders.bus.emit('order', order.id);
    }
    res.json({ order: boardView(order.id) });
  });

  // The customer's ETA follows the store's own prep promise: time so far,
  // plus prep, plus dispatch and the ride.
  function acceptOrder(order, prep, note) {
    orders.transition(db, order.id, 'merchant', 'accepted', { note, refund });
    const elapsed = one("SELECT (julianday('now') - julianday(created_at)) * 1440 AS m FROM orders WHERE id = ?", order.id).m;
    const eta = Math.round(elapsed + pricing.etaMinutes(order.distance_km, prep));
    db.prepare("UPDATE orders SET accepted_at = datetime('now'), prep_minutes = ?, eta_minutes = ? WHERE id = ?").run(prep, eta, order.id);
    orders.bus.emit('order', order.id);
  }

  // Auto-accept: stores that trust their stock take every order straight
  // away at their usual prep time.
  orders.bus.on('status', (orderId, to, evDb) => {
    if (evDb !== db || !['placed', 'items_removed'].includes(to)) return;
    setImmediate(() => {
      const o = one(`SELECT o.*, s.auto_accept, s.prep_minutes AS store_prep, s.busy_extra_minutes FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.id = ?`, orderId);
      if (!o || !o.auto_accept || o.status !== 'placed' || o.awaiting_customer) return;
      try { acceptOrder(o, o.store_prep + o.busy_extra_minutes, 'Accepted automatically'); } catch { /* moved on meanwhile */ }
    });
  });

  // Something in the order is sold out: mark it, and let the customer choose
  // to go ahead without it (refunded for that item) or cancel.
  app.post('/api/merchant/orders/:id/unavailable', merchant, (req, res) => {
    const s = requireStore(req);
    const order = one('SELECT * FROM orders WHERE id = ? AND store_id = ?', req.params.id, s.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'placed' || order.awaiting_customer) return res.status(409).json({ error: 'You can only do this on a new order' });
    const ids = (Array.isArray(req.body?.productIds) ? req.body.productIds : []).map(Number);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    const hit = items.filter((i) => ids.includes(i.product_id));
    if (!hit.length) return res.status(400).json({ error: 'Choose which items are out of stock' });
    db.transaction(() => {
      for (const i of hit) {
        db.prepare('UPDATE order_items SET unavailable = 1 WHERE id = ?').run(i.id);
        db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(i.product_id);
      }
    })();
    const names = hit.map((i) => i.name).join(', ');
    if (hit.length === items.length) {
      orders.transition(db, order.id, 'merchant', 'rejected', { note: `${DECLINE_REASONS.out_of_stock} — ${names}`, refund });
      return res.json({ order: boardView(order.id), declined: true });
    }
    db.prepare("UPDATE orders SET awaiting_customer = 'item_unavailable', awaiting_until = ?, updated_at = datetime('now') WHERE id = ?")
      .run(new Date(Date.now() + DECISION_MINUTES * 60000).toISOString(), order.id);
    orders.logEvent(db, order.id, 'item_unavailable', `${names} — sold out`);
    orders.bus.emit('order', order.id);
    orders.bus.emit('status', order.id, 'item_unavailable', db);
    audit(req.user.id, 'items_unavailable', { orderId: order.id, productIds: hit.map((i) => i.product_id) });
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

// Every few seconds: nudge stores that haven't answered a new order, decline
// it for them once it's waited too long (refunding the customer), and go
// ahead without sold-out items when the customer hasn't chosen in time.
function merchantSweep(db, refund, now = new Date()) {
  const timeout = Number(db.prepare("SELECT value FROM settings WHERE key = 'store_accept_timeout_minutes'").get()?.value || 10);
  const out = { escalated: 0, declined: 0, continued: 0 };
  for (const o of db.prepare(`SELECT id FROM orders WHERE status = 'placed' AND awaiting_customer = 'item_unavailable' AND awaiting_until <= ?`).all(now.toISOString())) {
    if (orders.removeUnavailable(db, o.id, refund, "Customer didn't choose in time — continued without the unavailable items") != null) out.continued++;
  }
  const waiting = db.prepare(`SELECT o.id, o.code, o.escalated_at, s.phone, s.name, s.owner_id,
      (julianday('now') - julianday(o.updated_at)) * 1440 AS mins
    FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.status = 'placed' AND o.awaiting_customer IS NULL`).all();
  for (const o of waiting) {
    if (o.mins >= timeout) {
      orders.transition(db, o.id, 'system', 'rejected', { note: "The store didn't respond in time. You've been refunded in full.", refund });
      out.declined++;
    } else if (o.mins >= ESCALATE_AFTER_MINUTES && !o.escalated_at) {
      db.prepare("UPDATE orders SET escalated_at = datetime('now') WHERE id = ?").run(o.id);
      orders.bus.emit('store_escalation', o.id, Math.max(1, Math.ceil(timeout - o.mins)), db);
      sms.send(o.phone, `ClickNPuff: order #${o.code} is waiting at ${o.name}. Accept it in the next ${Math.max(1, Math.ceil(timeout - o.mins))} min or it will be declined.`).catch(() => {});
      out.escalated++;
    }
  }
  return out;
}

module.exports = { registerMerchantRoutes, merchantSweep, DECLINE_REASONS };

'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const compliance = require('./compliance');
const pricing = require('./pricing');
const orders = require('./orders');
const payments = require('./payments');
const { registerRiderRoutes } = require('./rider');
const { registerAdminRoutes } = require('./admin');
const { registerMerchantRoutes } = require('./merchant');
const { availability } = require('./storeHours');
const promos = require('./promos');
const { deliveryStart } = require('./schedule');
const geocode = require('./geocode');
const { registerCustomerRoutes } = require('./customer');
const { registerPush } = require('./push');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'dev-only-secret-change-me') {
  throw new Error('Set JWT_SECRET in production');
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function createApp(db, { pushSend } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  // Map tiles come from CARTO's CDN; everything else is same-origin.
  // Map tiles come from the configured tile server; everything else is
  // same-origin. Tile servers such as OpenStreetMap's require a Referer, so
  // send the origin rather than helmet's default of nothing.
  app.use(helmet({
    contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', geocode.tileHost()].filter(Boolean) } },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true }));

  const refund = (order) => {
    payments.provider().refund(order).catch((e) => audit(null, 'refund_failed', { orderId: order.id, error: e.message }));
  };

  function audit(userId, action, detail) {
    db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)').run(userId, action, detail ? JSON.stringify(detail) : null);
  }

  // ---- Paystack webhook: needs the raw body for its signature ----------
  app.post('/api/payments/paystack/webhook', express.raw({ type: '*/*' }), wrap(async (req, res) => {
    if (!payments.paystack.verifyWebhook(req.body, req.get('x-paystack-signature'))) return res.sendStatus(401);
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'charge.success') {
      const order = db.prepare('SELECT * FROM orders WHERE payment_ref = ?').get(event.data.reference);
      if (order) await settle(order, event.data.reference);
    }
    res.sendStatus(200);
  }));

  app.use(express.json({ limit: '200kb' }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

  // ---- Auth --------------------------------------------------------------
  function sign(user) {
    return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  }

  function publicUser(u) {
    return {
      id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, ageVerified: !!u.age_verified, dob: u.dob,
      createdAt: u.created_at, lastLoginAt: u.last_login_at, mustChangePassword: !!u.must_change_password,
    };
  }

  function auth(...roles) {
    return (req, res, next) => {
      const header = req.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
      if (!token) return res.status(401).json({ error: 'Please sign in' });
      let payload;
      try {
        payload = jwt.verify(token, JWT_SECRET);
      } catch {
        return res.status(401).json({ error: 'Your session has expired — please sign in again' });
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
      if (!user || user.suspended) return res.status(401).json({ error: 'This account is not active' });
      if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Not allowed' });
      req.user = user;
      next();
    };
  }

  // For endpoints that work signed out but do more when signed in.
  function optionalUser(req) {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return null;
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(jwt.verify(header.slice(7), JWT_SECRET).sub);
      return user && !user.suspended ? user : null;
    } catch {
      return null;
    }
  }

  function requireAdult(req, res, next) {
    if (!req.user.age_verified) return res.status(403).json({ error: 'Verify your age with your SA ID before continuing', code: 'AGE_UNVERIFIED' });
    next();
  }

  app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
    const { email, password, name, phone } = req.body || {};
    const role = ['customer', 'merchant', 'rider'].includes(req.body?.role) ? req.body.role : 'customer';
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters' });
    if (!name?.trim()) return res.status(400).json({ error: 'Enter your name' });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'That email already has an account — sign in instead' });
    const hash = await bcrypt.hash(password, 10);
    const { lastInsertRowid } = db.prepare('INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, ?)')
      .run(email.trim(), hash, name.trim(), phone?.trim() || null, role);
    if (role === 'rider') db.prepare('INSERT INTO riders (user_id) VALUES (?)').run(lastInsertRowid);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    audit(user.id, 'register', { role });
    res.status(201).json({ token: sign(user), user: publicUser(user) });
  }));

  app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const user = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'Email or password is wrong' });
    if (user.suspended) return res.status(403).json({ error: 'This account is suspended' });
    // Shown back to the user as "last signed in", so record the sign-in
    // before this one too.
    const previous = user.last_login_at;
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    if (user.role === 'admin') audit(user.id, 'signed_in');
    res.json({ token: sign(user), user: { ...publicUser(user), lastLoginAt: previous } });
  }));

  app.get('/api/me', auth(), (req, res) => res.json({ user: publicUser(req.user) }));

  app.patch('/api/me', auth(), (req, res) => {
    const b = req.body || {};
    const name = b.name === undefined ? req.user.name : String(b.name).trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Your name cannot be empty' });
    const phone = b.phone === undefined ? req.user.phone : String(b.phone).trim().slice(0, 20) || null;
    if (phone && !/^[+\d][\d\s-]{6,19}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, req.user.id);
    audit(req.user.id, 'profile_updated', { name: name !== req.user.name, phone: phone !== req.user.phone });
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  app.post('/api/me/password', auth(), authLimiter, wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!(await bcrypt.compare(String(currentPassword || ''), req.user.password_hash))) return res.status(400).json({ error: 'Your current password is wrong' });
    if (!newPassword || String(newPassword).length < 10) return res.status(400).json({ error: 'Use a new password of at least 10 characters' });
    if (newPassword === currentPassword) return res.status(400).json({ error: 'Choose a password you have not used here' });
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await bcrypt.hash(String(newPassword), 10), req.user.id);
    audit(req.user.id, 'password_changed');
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  }));

  app.post('/api/me/verify-age', auth(), authLimiter, (req, res) => {
    const parsed = compliance.parseSaId(req.body?.idNumber);
    if (!parsed.valid) return res.status(400).json({ error: parsed.reason });
    if (!compliance.isAdult(parsed)) {
      audit(req.user.id, 'age_check_failed', { age: parsed.age });
      return res.status(403).json({ error: `You must be ${compliance.MIN_AGE} or older to use this service` });
    }
    const taken = db.prepare('SELECT id FROM users WHERE id_number = ? AND id <> ?').get(req.body.idNumber.replace(/\s/g, ''), req.user.id);
    if (taken) return res.status(409).json({ error: 'That ID number is already linked to another account' });
    db.prepare('UPDATE users SET id_number = ?, dob = ?, age_verified = 1 WHERE id = ?').run(req.body.idNumber.replace(/\s/g, ''), parsed.dob, req.user.id);
    audit(req.user.id, 'age_verified');
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  // ---- Catalogue ---------------------------------------------------------
  const settings = () => compliance.getSettings(db);
  const categoriesById = () => Object.fromEntries(db.prepare('SELECT * FROM categories').all().map((c) => [c.id, c]));

  function productView(p, cat) {
    return {
      id: p.id, storeId: p.store_id, name: p.name, description: p.description, priceCents: p.price_cents, unit: p.unit,
      inStock: p.stock > 0, stock: p.stock, thcPct: p.thc_pct, cbdPct: p.cbd_pct, strainType: p.strain_type,
      category: { slug: cat.slug, name: cat.name, icon: cat.icon },
    };
  }

  function storeSummary(s, origin) {
    const rating = s.rating_count ? Math.round((s.rating_sum / s.rating_count) * 10) / 10 : null;
    const avail = availability(s);
    const prep = s.prep_minutes + (s.busy_extra_minutes || 0);
    const out = {
      id: s.id, slug: s.slug, name: s.name, description: s.description, address: s.address, accent: s.accent,
      isOpen: avail.open, openLabel: avail.label, preorder: !avail.open && avail.reason === 'hours', rating, ratingCount: s.rating_count, prepMinutes: prep, city: s.city_slug,
      lat: s.lat, lng: s.lng,
    };
    if (origin) {
      const km = pricing.roadKm(s, origin);
      out.distanceKm = km;
      out.delivers = km <= s.delivery_radius_km;
      out.etaMinutes = pricing.etaMinutes(km, prep);
      out.deliveryFeeCents = pricing.deliveryFeeCents(km, 0);
    }
    return out;
  }

  function parseOrigin(q) {
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && q.lat !== undefined && q.lng !== undefined ? { lat, lng } : null;
  }

  function sellableProducts(store, { categorySlug, q } = {}) {
    const cats = categoriesById();
    const st = settings();
    return db.prepare('SELECT * FROM products WHERE store_id = ? AND active = 1 ORDER BY name').all(store.id)
      .filter((p) => compliance.canSell({ category: cats[p.category_id], store, settings: st }).ok)
      .filter((p) => !categorySlug || cats[p.category_id].slug === categorySlug)
      .filter((p) => !q || `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase()))
      .map((p) => productView(p, cats[p.category_id]));
  }

  app.get('/api/meta', (req, res) => {
    const st = settings();
    res.json({
      cities: db.prepare('SELECT slug, name, lat, lng FROM cities ORDER BY name').all(),
      categories: db.prepare('SELECT slug, name, icon, regulated FROM categories ORDER BY sort').all()
        .filter((c) => !c.regulated || st.regulatedSalesEnabled)
        .map((c) => ({ slug: c.slug, name: c.name, icon: c.icon })),
      deliveryHours: { open: st.deliveryOpenHour, close: st.deliveryCloseHour, openNow: compliance.deliveryWindowOpen(st) },
      fees: pricing.FEES,
      paymentProvider: payments.provider().name,
      tipPresetsCents: [0, 1000, 2000, 3000],
      mapTiles: geocode.mapTiles(),
      // Demo mode: simulated payments, so the one-tap demo logins and the
      // rider's simulate-move button are safe to show.
      demo: payments.provider().name === 'mock' && process.env.DEMO_MODE !== 'false',
    });
  });

  app.get('/api/stores', (req, res) => {
    const origin = parseOrigin(req.query);
    const rows = db.prepare(`
      SELECT s.*, c.slug AS city_slug FROM stores s JOIN cities c ON c.id = s.city_id
      WHERE s.status = 'approved' AND (? IS NULL OR c.slug = ?)
    `).all(req.query.city || null, req.query.city || null);
    let list = rows.map((s) => ({ ...storeSummary(s, origin), productCount: sellableProducts(s, { categorySlug: req.query.category }).length }))
      .filter((s) => s.productCount > 0);
    list.sort((a, b) => (b.isOpen - a.isOpen) || ((b.delivers ?? 1) - (a.delivers ?? 1)) || ((a.etaMinutes ?? 0) - (b.etaMinutes ?? 0)) || ((b.rating ?? 0) - (a.rating ?? 0)));
    res.json({ stores: list });
  });

  app.get('/api/stores/:slug', (req, res) => {
    const s = db.prepare(`SELECT s.*, c.slug AS city_slug FROM stores s JOIN cities c ON c.id = s.city_id WHERE s.slug = ? AND s.status = 'approved'`).get(req.params.slug);
    if (!s) return res.status(404).json({ error: 'Store not found' });
    const reviews = db.prepare(`
      SELECT r.rating, r.comment, r.created_at, r.store_reply AS reply, u.name FROM reviews r JOIN users u ON u.id = r.customer_id
      WHERE r.store_id = ? ORDER BY r.id DESC LIMIT 10
    `).all(s.id).map((r) => ({ ...r, name: r.name.split(' ')[0] }));
    res.json({ store: storeSummary(s, parseOrigin(req.query)), products: sellableProducts(s), reviews });
  });

  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    const origin = parseOrigin(req.query);
    const stores = db.prepare(`
      SELECT s.*, c.slug AS city_slug FROM stores s JOIN cities c ON c.id = s.city_id
      WHERE s.status = 'approved' AND (? IS NULL OR c.slug = ?)
    `).all(req.query.city || null, req.query.city || null);
    const results = [];
    for (const s of stores) {
      const summary = storeSummary(s, origin);
      for (const p of sellableProducts(s, { q, categorySlug: req.query.category })) results.push({ ...p, store: summary });
    }
    results.sort((a, b) => (b.inStock - a.inStock) || ((a.store.etaMinutes ?? 0) - (b.store.etaMinutes ?? 0)));
    res.json({ results: results.slice(0, 60) });
  });

  // ---- Basket → quote → order -------------------------------------------
  function buildBasket(storeId, items) {
    const store = db.prepare("SELECT * FROM stores WHERE id = ? AND status = 'approved'").get(storeId);
    if (!store) throw new orders.OrderError('That store is not available', 404);
    if (!Array.isArray(items) || !items.length) throw new orders.OrderError('Your basket is empty');
    const cats = categoriesById();
    const st = settings();
    const merged = new Map();
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new orders.OrderError('Quantities must be between 1 and 20');
      merged.set(Number(it.productId), (merged.get(Number(it.productId)) || 0) + qty);
    }
    const lines = [];
    for (const [productId, qty] of merged) {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ? AND active = 1').get(productId, store.id);
      if (!p) throw new orders.OrderError('An item in your basket is no longer available');
      if (!compliance.canSell({ category: cats[p.category_id], store, settings: st }).ok) throw new orders.OrderError(`${p.name} cannot be sold right now`);
      if (p.stock < qty) throw new orders.OrderError(p.stock ? `Only ${p.stock} × ${p.name} left` : `${p.name} is sold out`, 409);
      lines.push({ product: p, qty });
    }
    const subtotal = lines.reduce((sum, l) => sum + l.product.price_cents * l.qty, 0);
    return { store, lines, subtotal };
  }

  function quoteFor(store, subtotal, dropoff) {
    const lat = Number(dropoff?.lat);
    const lng = Number(dropoff?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new orders.OrderError('Choose a delivery address');
    const km = pricing.roadKm(store, { lat, lng });
    if (km > store.delivery_radius_km) throw new orders.OrderError(`${store.name} doesn't deliver that far (${km} km — limit ${store.delivery_radius_km} km)`);
    return pricing.quote({ subtotalCents: subtotal, km, prepMinutes: store.prep_minutes + (store.busy_extra_minutes || 0) });
  }

  // Takes a promo off a quote. Discount comes off before VAT is worked out;
  // a bad code is reported, not fatal, so checkout can show why.
  function withPromo(q, code, userId) {
    if (!code) return q;
    const r = promos.apply(db, code, { userId, subtotalCents: q.subtotalCents, deliveryFeeCents: q.deliveryFeeCents });
    if (!r.ok) return { ...q, promoError: r.reason };
    const total = q.totalCents - r.discountCents;
    return { ...q, discountCents: r.discountCents, promo: r.promo, totalCents: total, vatCents: Math.round((total * 0.15) / 1.15) };
  }

  app.post('/api/quote', wrap(async (req, res) => {
    const { store, subtotal } = buildBasket(req.body.storeId, req.body.items);
    const user = optionalUser(req);
    const q = withPromo(quoteFor(store, subtotal, req.body), req.body.promoCode, user?.id);
    res.json({ quote: { ...q, delivery: deliveryView(deliveryStart(store, settings())) } });
  }));

  function deliveryView(d) {
    if (d.blocked) return { possible: false, reason: d.blocked };
    if (d.now) return { possible: true, now: true };
    return { possible: true, now: false, scheduledFor: d.at.toISOString(), label: d.label };
  }

  // ---- Address search -------------------------------------------------
  const geoLimiter = rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false });

  app.get('/api/geocode/search', geoLimiter, wrap(async (req, res) => {
    const near = parseOrigin(req.query);
    try {
      res.json({ results: await geocode.search(req.query.q, near) });
    } catch {
      res.status(502).json({ error: "Address search isn't available right now — drop the pin on the map instead", results: [] });
    }
  }));

  app.get('/api/geocode/reverse', geoLimiter, wrap(async (req, res) => {
    try {
      res.json({ place: await geocode.reverse(Number(req.query.lat), Number(req.query.lng)) });
    } catch {
      res.status(502).json({ error: "Couldn't look up that spot", place: null });
    }
  }));

  app.get('/api/promos', (req, res) => res.json({ promos: promos.available(db, optionalUser(req)?.id) }));

  app.post('/api/orders', auth('customer'), requireAdult, wrap(async (req, res) => {
    const address = String(req.body.address || '').trim();
    if (address.length < 5) return res.status(400).json({ error: 'Enter your full delivery address' });

    const create = db.transaction(() => {
      const { store, lines, subtotal } = buildBasket(req.body.storeId, req.body.items);
      // Outside delivery or opening hours the order is taken now and
      // delivered from the next delivery time; paused or closed stores
      // can't take it at all.
      const when = deliveryStart(store, settings());
      if (when.blocked) throw new orders.OrderError(when.blocked, 409);
      const scheduledFor = when.now ? null : when.at.toISOString();
      const q = withPromo(quoteFor(store, subtotal, req.body), req.body.promoCode, req.user.id);
      if (q.promoError) throw new orders.OrderError(q.promoError);
      if (q.belowMinimum) throw new orders.OrderError(`The minimum order is R${q.minimumOrderCents / 100}`);
      // The rider tip is optional, goes to the rider in full, and is not
      // part of the VAT-able supply.
      const tip = Math.round(Number(req.body.tipCents || 0));
      if (!Number.isInteger(tip) || tip < 0 || tip > 50000) throw new orders.OrderError('Tips can be up to R500');
      const { lastInsertRowid: id } = db.prepare(`
        INSERT INTO orders (code, customer_id, store_id, status, subtotal_cents, delivery_fee_cents, service_fee_cents,
          tip_cents, promo_code, discount_cents, total_cents, vat_cents, address, lat, lng, distance_km, eta_minutes, notes, handover_code,
          scheduled_for, base_eta_minutes)
        VALUES (?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(orders.newCode(), req.user.id, store.id, q.subtotalCents, q.deliveryFeeCents, q.serviceFeeCents, tip,
        q.promo?.code || null, q.discountCents || 0, q.totalCents + tip, q.vatCents,
        address, Number(req.body.lat), Number(req.body.lng), q.distanceKm, q.etaMinutes, String(req.body.notes || '').slice(0, 300), orders.newHandoverCode(),
        scheduledFor, q.etaMinutes);
      const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, name, price_cents, qty) VALUES (?, ?, ?, ?, ?)');
      const reserve = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
      for (const l of lines) {
        insertItem.run(id, l.product.id, l.product.name, l.product.price_cents, l.qty);
        if (reserve.run(l.qty, l.product.id, l.qty).changes === 0) throw new orders.OrderError(`${l.product.name} just sold out`, 409);
      }
      orders.logEvent(db, id, 'pending_payment', null);
      return id;
    });
    const id = create();
    res.status(201).json({ order: orders.orderView(db, id, 'customer') });
  }));

  async function settle(order, reference) {
    if (order.payment_status === 'paid' || order.status !== 'pending_payment') return;
    db.prepare("UPDATE orders SET payment_status = 'paid', payment_ref = ? WHERE id = ?").run(reference, order.id);
    // A pre-order waits until delivery time; anything due already goes now.
    const later = order.scheduled_for && new Date(order.scheduled_for) > new Date();
    orders.transition(db, order.id, 'system', later ? 'scheduled' : 'placed', { note: later ? 'Payment received — scheduled for delivery time' : 'Payment received' });
  }

  app.post('/api/orders/:id/pay', auth('customer'), wrap(async (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending_payment') return res.status(409).json({ error: 'This order has already been paid or cancelled' });
    const p = payments.provider();
    const started = await p.start(order, req.user);
    if (started.settleNow) {
      await settle(order, started.reference);
      return res.json({ order: orders.orderView(db, order.id, 'customer') });
    }
    db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(started.reference, order.id);
    res.json({ redirectUrl: started.redirectUrl });
  }));

  app.post('/api/orders/:id/verify-payment', auth('customer'), wrap(async (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_ref && order.status === 'pending_payment') {
      const v = await payments.provider().verify(order.payment_ref, order.total_cents);
      if (v.ok) await settle(order, order.payment_ref);
    }
    res.json({ order: orders.orderView(db, order.id, 'customer') });
  }));

  app.get('/api/orders', auth('customer'), (req, res) => {
    const ids = db.prepare('SELECT id FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
    res.json({ orders: ids.map(({ id }) => orders.orderView(db, id, 'customer')) });
  });

  // Who is looking at this order, and in what capacity.
  function viewerOf(user, order) {
    if (user.role === 'admin') return 'admin';
    if (user.role === 'customer' && order.customer_id === user.id) return 'customer';
    if (user.role === 'rider' && order.rider_id === user.id) return 'rider';
    if (user.role === 'merchant' && db.prepare('SELECT 1 FROM stores WHERE id = ? AND owner_id = ?').get(order.store_id, user.id)) return 'merchant';
    return null;
  }

  app.get('/api/orders/:id', auth(), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    const viewer = order && viewerOf(req.user, order);
    if (!viewer) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: orders.orderView(db, order.id, viewer) });
  });

  // Server-sent events: the tracking screen holds this open and gets the
  // full order every time anything about it changes, including the rider
  // moving.
  app.get('/api/orders/:id/stream', auth(), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    const viewer = order && viewerOf(req.user, order);
    if (!viewer) return res.status(404).json({ error: 'Order not found' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = () => res.write(`data: ${JSON.stringify(orders.orderView(db, order.id, viewer))}\n\n`);
    const onOrder = (id) => { if (id === order.id) send(); };
    orders.bus.on('order', onOrder);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    send();
    req.on('close', () => {
      clearInterval(ping);
      orders.bus.off('order', onOrder);
    });
  });

  app.post('/api/orders/:id/cancel', auth('customer', 'admin'), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order || (req.user.role === 'customer' && order.customer_id !== req.user.id)) return res.status(404).json({ error: 'Order not found' });
    orders.transition(db, order.id, req.user.role, 'cancelled', { note: String(req.body?.reason || 'Cancelled by ' + req.user.role).slice(0, 200), refund });
    audit(req.user.id, 'order_cancelled', { orderId: order.id });
    res.json({ order: orders.orderView(db, order.id, req.user.role === 'admin' ? 'admin' : 'customer') });
  });

  app.post('/api/orders/:id/review', auth('customer'), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'delivered') return res.status(409).json({ error: 'You can review once your order has arrived' });
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1 to 5 stars' });
    const riderRating = req.body?.riderRating === undefined || req.body.riderRating === null ? null : Number(req.body.riderRating);
    if (riderRating !== null && (!Number.isInteger(riderRating) || riderRating < 1 || riderRating > 5)) return res.status(400).json({ error: 'Rider rating must be 1 to 5 stars' });
    const add = db.transaction(() => {
      db.prepare('INSERT INTO reviews (order_id, customer_id, store_id, rating, comment) VALUES (?, ?, ?, ?, ?)')
        .run(order.id, req.user.id, order.store_id, rating, String(req.body.comment || '').slice(0, 500));
      db.prepare('UPDATE stores SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?').run(rating, order.store_id);
      if (riderRating && order.rider_id) {
        db.prepare('UPDATE orders SET rider_rating = ? WHERE id = ?').run(riderRating, order.id);
        db.prepare('UPDATE riders SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?').run(riderRating, order.rider_id);
      }
    });
    try {
      add();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'You have already reviewed this order' });
      throw e;
    }
    res.status(201).json({ order: orders.orderView(db, order.id, 'customer') });
  });

  // How admin sees a store: the public summary plus status and licence.
  function merchantStoreView(s) {
    return {
      ...storeSummary({ ...s, city_slug: db.prepare('SELECT slug FROM cities WHERE id = ?').get(s.city_id)?.slug }),
      status: s.status, deliveryRadiusKm: s.delivery_radius_km, licenceNumber: s.licence_number,
      licenceCategories: JSON.parse(s.licence_categories), licenceVerified: !!s.licence_verified,
    };
  }

  // ---- Merchant ----------------------------------------------------------
  registerMerchantRoutes(app, { db, auth, requireAdult, audit, refund, storeSummary, productView, categoriesById, settings, slugify });

  // ---- Rider -------------------------------------------------------------
  registerRiderRoutes(app, { db, auth, requireAdult, audit, refund });
  registerAdminRoutes(app, { db, auth, audit });
  registerCustomerRoutes(app, { db, auth, audit, storeSummary, productView, categoriesById, settings });
  registerPush(app, { db, auth, ...(pushSend ? { send: pushSend } : {}) });

  // ---- Admin -------------------------------------------------------------
  app.get('/api/admin/overview', auth('admin'), (req, res) => {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const active = orders.ACTIVE.map(() => '?').join(',');
    res.json({
      today: one(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS gmv_cents,
        COALESCE(SUM(service_fee_cents), 0) AS service_fees_cents,
        COALESCE(AVG((julianday(delivered_at) - julianday(created_at)) * 1440), 0) AS avg_minutes
        FROM orders WHERE status = 'delivered' AND date(delivered_at) = date('now')`),
      activeOrders: one(`SELECT COUNT(*) AS n FROM orders WHERE status IN (${active})`, ...orders.ACTIVE).n,
      unassigned: one("SELECT COUNT(*) AS n FROM orders WHERE rider_id IS NULL AND status IN ('accepted','preparing','ready')").n,
      ridersOnline: one('SELECT COUNT(*) AS n FROM riders WHERE online = 1').n,
      openIncidents: one('SELECT COUNT(*) AS n FROM incidents WHERE resolved = 0').n + one("SELECT COUNT(*) AS n FROM help_requests WHERE status = 'open'").n,
      pendingStores: one("SELECT COUNT(*) AS n FROM stores WHERE status = 'pending'").n,
      unverifiedLicences: one("SELECT COUNT(*) AS n FROM stores WHERE licence_number IS NOT NULL AND licence_verified = 0").n,
      customers: one("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").n,
      settings: settings(),
    });
  });

  app.get('/api/admin/stores', auth('admin'), (req, res) => {
    const rows = db.prepare(`SELECT s.*, c.slug AS city_slug, u.name AS owner_name, u.email AS owner_email
      FROM stores s JOIN cities c ON c.id = s.city_id JOIN users u ON u.id = s.owner_id ORDER BY s.status = 'pending' DESC, s.name`).all();
    res.json({ stores: rows.map((s) => ({ ...merchantStoreView(s), owner: { name: s.owner_name, email: s.owner_email } })) });
  });

  app.post('/api/admin/stores/:id', auth('admin'), (req, res) => {
    const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Store not found' });
    const b = req.body || {};
    if (b.status && !['approved', 'suspended', 'pending'].includes(b.status)) return res.status(400).json({ error: 'Bad status' });
    let licenceCats = s.licence_categories;
    if (b.licenceCategories !== undefined) {
      const valid = db.prepare('SELECT slug FROM categories WHERE regulated = 1').all().map((c) => c.slug);
      const bad = b.licenceCategories.filter((c) => !valid.includes(c));
      if (bad.length) return res.status(400).json({ error: `Not regulated categories: ${bad.join(', ')}` });
      licenceCats = JSON.stringify(b.licenceCategories);
    }
    const verified = b.licenceVerified === undefined ? s.licence_verified : b.licenceVerified ? 1 : 0;
    if (verified && !s.licence_number) return res.status(400).json({ error: 'The store has not given a licence number' });
    db.prepare('UPDATE stores SET status = COALESCE(?, status), licence_categories = ?, licence_verified = ? WHERE id = ?')
      .run(b.status || null, licenceCats, verified, s.id);
    audit(req.user.id, 'store_updated', { storeId: s.id, ...b });
    res.json({ ok: true });
  });

  app.put('/api/admin/settings', auth('admin'), (req, res) => {
    const b = req.body || {};
    const put = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    if (b.regulatedSalesEnabled !== undefined) put.run(b.regulatedSalesEnabled ? 'true' : 'false', 'regulated_sales_enabled');
    for (const [k, col] of [['deliveryOpenHour', 'delivery_open_hour'], ['deliveryCloseHour', 'delivery_close_hour']]) {
      if (b[k] === undefined) continue;
      const h = Number(b[k]);
      if (!Number.isInteger(h) || h < 0 || h > 24) return res.status(400).json({ error: 'Hours must be 0–24' });
      put.run(String(h), col);
    }
    audit(req.user.id, 'settings_updated', b);
    res.json({ settings: settings() });
  });


  app.get('/api/admin/riders', auth('admin'), (req, res) => {
    const active = orders.RIDER_ACTIVE.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT u.id, u.name, u.phone, u.suspended, r.online, r.paused, r.vehicle, r.plate, r.lat, r.lng, r.located_at,
        r.rating_sum, r.rating_count,
        (SELECT code FROM orders o WHERE o.rider_id = u.id AND o.status IN (${active}) LIMIT 1) AS current_code,
        (SELECT COUNT(*) FROM orders o WHERE o.rider_id = u.id AND o.status = 'delivered' AND date(o.delivered_at, '+2 hours') = date('now', '+2 hours')) AS trips_today,
        (SELECT COUNT(*) FROM offer_log l WHERE l.rider_id = u.id AND l.outcome = 'accepted' AND l.at > datetime('now', '-30 days')) AS accepted,
        (SELECT COUNT(*) FROM offer_log l WHERE l.rider_id = u.id AND l.at > datetime('now', '-30 days')) AS offered
      FROM users u JOIN riders r ON r.user_id = u.id ORDER BY r.online DESC, u.name
    `).all(...orders.RIDER_ACTIVE);
    res.json({
      riders: rows.map((r) => ({
        id: r.id, name: r.name, phone: r.phone, suspended: !!r.suspended, online: !!r.online, paused: !!r.paused,
        vehicle: r.vehicle, plate: r.plate, location: r.lat != null ? { lat: r.lat, lng: r.lng, at: r.located_at } : null,
        rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : null,
        currentOrder: r.current_code, tripsToday: r.trips_today,
        acceptanceRate: r.offered ? Math.round((r.accepted / r.offered) * 100) : null,
      })),
    });
  });

  app.get('/api/admin/incidents', auth('admin'), (req, res) => {
    const rows = db.prepare(`SELECT i.*, u.name AS rider_name, u.phone AS rider_phone, o.code AS order_code
      FROM incidents i JOIN users u ON u.id = i.rider_id LEFT JOIN orders o ON o.id = i.order_id
      ORDER BY i.resolved, i.id DESC LIMIT 100`).all();
    res.json({
      incidents: rows.map((i) => ({
        id: i.id, type: i.type, note: i.note, at: i.at, resolved: !!i.resolved, orderCode: i.order_code,
        rider: { id: i.rider_id, name: i.rider_name, phone: i.rider_phone },
        location: i.lat != null ? { lat: i.lat, lng: i.lng } : null,
      })),
    });
  });

  app.post('/api/admin/incidents/:id/resolve', auth('admin'), (req, res) => {
    const r = db.prepare('UPDATE incidents SET resolved = 1 WHERE id = ?').run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Incident not found' });
    audit(req.user.id, 'incident_resolved', { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // ---- Errors ------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof orders.OrderError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side — please try again' });
  });

  app.locals.db = db;
  app.locals.refund = refund;
  return app;
}

module.exports = { createApp };

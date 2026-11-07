'use strict';
const bcrypt = require('bcryptjs');
const orders = require('./orders');
const csv = require('./csv');
const team = require('./team');

// Money for stores and the platform: bank and tax details, what each store
// has earned and been paid, statements, refunds after delivery (and who
// carries them), tax invoices and a store's own promo codes.
//
// A store earns the item total of each delivered order, less any discount
// from its own promo codes and any refund it agreed to carry. Delivery and
// service fees belong to the platform. Its balance is everything earned
// less every payout recorded.

const EARNED = '(o.subtotal_cents - o.store_discount_cents - o.store_refund_cents)';
const SAST = (col) => `datetime(${col}, '+2 hours')`;
const vatOf = (cents) => Math.round((cents * 15) / 115);

// Universal branch codes for South Africa's main banks.
const BANKS = {
  'Absa': '632005', 'African Bank': '430000', 'Bidvest Bank': '462005', 'Capitec': '470010', 'Discovery Bank': '679000',
  'FNB': '250655', 'Investec': '580105', 'Nedbank': '198765', 'Standard Bank': '051001', 'TymeBank': '678910', 'Other': '',
};
const ACCOUNT_TYPES = ['cheque', 'savings', 'transmission'];

// Rows as arrays, the first being the header.
const sheet = (rows) => csv.stringify(rows[0], rows.slice(1).map((r) => Object.fromEntries(rows[0].map((c, i) => [c, r[i]]))));
const mask = (n) => (n ? `••••${String(n).slice(-4)}` : null);

function validVat(v) {
  // SA VAT numbers are 10 digits starting with 4.
  return /^4\d{9}$/.test(v);
}

function registerMoneyRoutes(app, { db, auth, audit, refund, wrap }) {
  const merchant = auth('merchant');
  const admin = auth('admin');
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const setting = (k) => one('SELECT value FROM settings WHERE key = ?', k)?.value || '';

  const requireStore = (req, need = 'owner') => team.storeFor(db, req, need);

  function bankView(s, full = false) {
    if (!s.bank_account_number) return null;
    return {
      bankName: s.bank_name, accountHolder: s.bank_account_holder, accountType: s.bank_account_type, branchCode: s.bank_branch_code,
      accountNumber: full ? s.bank_account_number : mask(s.bank_account_number), updatedAt: s.bank_updated_at,
    };
  }
  const taxView = (s) => ({ legalName: s.legal_name || '', vatNumber: s.vat_number || '', companyReg: s.company_reg || '', address: s.address });

  function balance(storeId, before) {
    const cut = before ? `AND o.delivered_at < ?` : '';
    const args = before ? [storeId, before] : [storeId];
    const earned = one(`SELECT COALESCE(SUM(${EARNED}), 0) AS c FROM orders o WHERE o.store_id = ? AND o.status = 'delivered' ${cut}`, ...args).c;
    const paid = one(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM payouts WHERE store_id = ? ${before ? 'AND paid_at < ?' : ''}`, ...args).c;
    // Refunds a store carries on orders delivered before the cut-off but
    // refunded later are already in "earned" via store_refund_cents.
    return { earnedCents: earned, paidCents: paid, balanceCents: earned - paid };
  }

  // ---- Bank and tax details ------------------------------------------------------
  app.get('/api/merchant/billing', merchant, (req, res) => {
    const s = requireStore(req);
    res.json({ bank: bankView(s), tax: taxView(s), banks: Object.entries(BANKS).map(([name, branchCode]) => ({ name, branchCode })), accountTypes: ACCOUNT_TYPES });
  });

  // Changing where money goes is the thing a fraudster most wants to do with
  // a stolen login, so it needs the password again and is logged.
  app.put('/api/merchant/bank', merchant, wrap(async (req, res) => {
    const s = requireStore(req);
    const b = req.body || {};
    if (!(await bcrypt.compare(String(b.password || ''), req.user.password_hash))) return res.status(400).json({ error: 'Your password is wrong' });
    const bankName = String(b.bankName || '');
    if (!(bankName in BANKS)) return res.status(400).json({ error: 'Choose your bank' });
    const holder = String(b.accountHolder || '').trim();
    if (holder.length < 2) return res.status(400).json({ error: 'Enter the account holder name' });
    const number = String(b.accountNumber || '').replace(/[\s-]/g, '');
    if (!/^\d{6,16}$/.test(number)) return res.status(400).json({ error: 'Account numbers are 6 to 16 digits' });
    const branch = String(b.branchCode || BANKS[bankName] || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(branch)) return res.status(400).json({ error: 'Branch codes are 6 digits' });
    const type = ACCOUNT_TYPES.includes(b.accountType) ? b.accountType : 'cheque';
    db.prepare(`UPDATE stores SET bank_name = ?, bank_account_holder = ?, bank_account_number = ?, bank_branch_code = ?, bank_account_type = ?,
      bank_updated_at = datetime('now') WHERE id = ?`).run(bankName, holder.slice(0, 120), number, branch, type, s.id);
    audit(req.user.id, 'bank_details_changed', { storeId: s.id, bank: bankName, account: mask(number), before: mask(s.bank_account_number) });
    team.log(db, s.id, req.user.id, 'bank_details_changed', `${bankName} ${mask(number)}`);
    res.json({ bank: bankView(one('SELECT * FROM stores WHERE id = ?', s.id)) });
  }));

  app.put('/api/merchant/tax', merchant, (req, res) => {
    const s = requireStore(req);
    const b = req.body || {};
    const vat = String(b.vatNumber || '').replace(/\s/g, '');
    if (vat && !validVat(vat)) return res.status(400).json({ error: 'A VAT number is 10 digits and starts with 4' });
    db.prepare('UPDATE stores SET legal_name = ?, vat_number = ?, company_reg = ? WHERE id = ?')
      .run(String(b.legalName || '').trim().slice(0, 160) || null, vat || null, String(b.companyReg || '').trim().slice(0, 40) || null, s.id);
    audit(req.user.id, 'tax_details_changed', { storeId: s.id, vat: vat || null });
    res.json({ tax: taxView(one('SELECT * FROM stores WHERE id = ?', s.id)) });
  });

  // ---- Payouts and statements ------------------------------------------------------
  app.get('/api/merchant/payouts', merchant, (req, res) => {
    const s = requireStore(req);
    const weeks = db.prepare(`SELECT date(o.delivered_at, '+2 hours', 'weekday 0', '-6 days') AS week, COUNT(*) AS orders,
        SUM(o.subtotal_cents) AS sales, SUM(o.store_discount_cents) AS promos, SUM(o.store_refund_cents) AS refunds, SUM(${EARNED}) AS earned
      FROM orders o WHERE o.store_id = ? AND o.status = 'delivered' AND o.delivered_at > datetime('now', '-84 days')
      GROUP BY week ORDER BY week DESC`).all(s.id);
    const paid = db.prepare('SELECT id, amount_cents, reference, period_end, note, paid_at FROM payouts WHERE store_id = ? ORDER BY paid_at DESC, id DESC LIMIT 52').all(s.id);
    res.json({
      ...balance(s.id),
      weeks: weeks.map((w) => ({ weekStart: w.week, orders: w.orders, salesCents: w.sales, storePromoCents: w.promos, storeRefundCents: w.refunds, earnedCents: w.earned })),
      payouts: paid.map((p) => ({ id: p.id, amountCents: p.amount_cents, reference: p.reference, periodEnd: p.period_end, note: p.note, paidAt: p.paid_at })),
      bank: bankView(s),
      note: "You earn the item total of every delivered order, less your own promo codes and any refunds you agreed to. Delivery and service fees are kept by the platform. Payouts go out weekly by EFT to the account below.",
    });
  });

  // Dates are SAST calendar days, both ends included.
  function range(q) {
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const to = day(q.to) || one("SELECT date('now', '+2 hours') AS d").d;
    const from = day(q.from) || one("SELECT date(?, '-30 days') AS d", to).d;
    if (from > to) throw new orders.OrderError('The start date is after the end date');
    // As UTC instants: SAST midnight is 22:00 the day before.
    return { from, to, fromUtc: one("SELECT datetime(?, '-2 hours') AS d", from).d, toUtc: one("SELECT datetime(?, '+1 day', '-2 hours') AS d", to).d };
  }

  function statement(s, q) {
    const r = range(q);
    const lines = db.prepare(`SELECT o.id, o.code, ${SAST('o.delivered_at')} AS at, o.subtotal_cents, o.store_discount_cents, o.store_refund_cents, ${EARNED} AS earned,
        (SELECT SUM(qty) FROM order_items i WHERE i.order_id = o.id AND i.unavailable = 0) AS items
      FROM orders o WHERE o.store_id = ? AND o.status = 'delivered' AND o.delivered_at >= ? AND o.delivered_at < ? ORDER BY o.delivered_at`).all(s.id, r.fromUtc, r.toUtc);
    const paid = db.prepare(`SELECT amount_cents, reference, ${SAST('paid_at')} AS at FROM payouts WHERE store_id = ? AND paid_at >= ? AND paid_at < ? ORDER BY paid_at`).all(s.id, r.fromUtc, r.toUtc);
    const opening = balance(s.id, r.fromUtc).balanceCents;
    const sum = (k) => lines.reduce((n, l) => n + l[k], 0);
    const earned = sum('earned');
    const paidOut = paid.reduce((n, p) => n + p.amount_cents, 0);
    return {
      store: { name: s.name, address: s.address, ...taxView(s) },
      from: r.from, to: r.to,
      openingBalanceCents: opening,
      salesCents: sum('subtotal_cents'), storePromoCents: sum('store_discount_cents'), storeRefundCents: sum('store_refund_cents'), earnedCents: earned,
      vatOnSalesCents: s.vat_number ? vatOf(earned) : null,
      paidCents: paidOut,
      closingBalanceCents: opening + earned - paidOut,
      orders: lines.map((l) => ({ code: l.code, deliveredAt: l.at, items: l.items, salesCents: l.subtotal_cents, storePromoCents: l.store_discount_cents, storeRefundCents: l.store_refund_cents, earnedCents: l.earned })),
      payouts: paid.map((p) => ({ amountCents: p.amount_cents, reference: p.reference, paidAt: p.at })),
      platform: { name: setting('company_name'), vatNumber: setting('company_vat_number') },
    };
  }

  const rands = (c) => (c / 100).toFixed(2);
  app.get('/api/merchant/statement', merchant, (req, res) => {
    const st = statement(requireStore(req), req.query);
    if (req.query.format !== 'csv') return res.json(st);
    const rows = [['date', 'type', 'reference', 'items', 'sales', 'your_promos', 'refunds_you_carry', 'earned', 'paid_out']];
    rows.push([st.from, 'opening_balance', '', '', '', '', '', rands(st.openingBalanceCents), '']);
    const events = [
      ...st.orders.map((o) => ({ at: o.deliveredAt, row: [o.deliveredAt, 'order', o.code, o.items, rands(o.salesCents), rands(o.storePromoCents), rands(o.storeRefundCents), rands(o.earnedCents), ''] })),
      ...st.payouts.map((p) => ({ at: p.paidAt, row: [p.paidAt, 'payout', p.reference, '', '', '', '', '', rands(p.amountCents)] })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    for (const e of events) rows.push(e.row);
    rows.push([st.to, 'closing_balance', '', '', rands(st.salesCents), rands(st.storePromoCents), rands(st.storeRefundCents), rands(st.closingBalanceCents), rands(st.paidCents)]);
    res.type('text/csv').attachment(`statement-${st.from}-to-${st.to}.csv`).send(sheet(rows));
  });

  // ---- A store's own promo codes ------------------------------------------------------
  function promoView(p) {
    const used = one(`SELECT COUNT(*) AS n, COALESCE(SUM(store_discount_cents), 0) AS c, COALESCE(SUM(subtotal_cents), 0) AS sales
      FROM orders WHERE promo_code = ? AND status = 'delivered'`, p.code);
    return {
      code: p.code, description: p.description, kind: p.kind, value: p.value, maxDiscountCents: p.max_discount_cents, minSubtotalCents: p.min_subtotal_cents,
      perUserLimit: p.per_user_limit, public: !!p.public, active: !!p.active, expiresAt: p.expires_at,
      expired: !!p.expires_at && new Date(p.expires_at) < new Date(),
      uses: used.n, discountGivenCents: used.c, salesCents: used.sales,
    };
  }

  function promoInput(b, existing = {}) {
    const kind = b.kind ?? existing.kind ?? 'percent';
    if (!['percent', 'fixed'].includes(kind)) throw new orders.OrderError('Choose a percentage or a rand amount off');
    const value = b.value === undefined ? existing.value : Math.round(Number(b.value));
    if (!Number.isInteger(value) || value <= 0) throw new orders.OrderError('Enter how much it takes off');
    if (kind === 'percent' && value > 50) throw new orders.OrderError('Percentage codes can take up to 50% off');
    const min = b.minSubtotalCents === undefined ? existing.min_subtotal_cents ?? 0 : Math.max(0, Math.round(Number(b.minSubtotalCents) || 0));
    if (kind === 'fixed' && value > 100000) throw new orders.OrderError('Rand codes can take up to R1 000 off');
    const max = b.maxDiscountCents === undefined ? existing.max_discount_cents ?? null : (b.maxDiscountCents ? Math.round(Number(b.maxDiscountCents)) : null);
    const per = b.perUserLimit === undefined ? existing.per_user_limit ?? 1 : Math.min(20, Math.max(1, Math.round(Number(b.perUserLimit) || 1)));
    let expires = b.expiresAt === undefined ? existing.expires_at ?? null : (b.expiresAt || null);
    if (expires && /^\d{4}-\d{2}-\d{2}$/.test(expires)) expires = one("SELECT datetime(?, '+1 day', '-2 hours') AS d", expires).d; // end of that SAST day
    if (expires && Number.isNaN(new Date(expires).getTime())) throw new orders.OrderError('That end date is not valid');
    const off = kind === 'percent' ? `${value}% off` : `R${value / 100} off`;
    const description = String(b.description ?? existing.description ?? '').trim().slice(0, 120) || `${off}${min ? ` orders over R${min / 100}` : ''}`;
    return { kind, value, min, max, per, expires, description, public: b.public === undefined ? existing.public ?? 1 : b.public ? 1 : 0, active: b.active === undefined ? existing.active ?? 1 : b.active ? 1 : 0 };
  }

  app.get('/api/merchant/promos', merchant, (req, res) => {
    const s = requireStore(req, 'manager');
    res.json({ promos: db.prepare('SELECT * FROM promos WHERE store_id = ? ORDER BY active DESC, created_at DESC').all(s.id).map(promoView) });
  });

  app.post('/api/merchant/promos', merchant, (req, res) => {
    const s = requireStore(req, 'manager');
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(code)) return res.status(400).json({ error: 'Codes are 4 to 16 letters or numbers' });
    if (one('SELECT 1 FROM promos WHERE code = ?', code)) return res.status(409).json({ error: 'That code is taken — try another' });
    const p = promoInput(req.body || {});
    db.prepare(`INSERT INTO promos (code, description, kind, value, max_discount_cents, min_subtotal_cents, first_order_only, per_user_limit, public, active, expires_at, store_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, datetime('now'))`).run(code, p.description, p.kind, p.value, p.max, p.min, p.per, p.public, p.active, p.expires, s.id);
    audit(req.user.id, 'store_promo_created', { storeId: s.id, code });
    team.log(db, s.id, req.user.id, 'promo_created', `${code} · ${p.description}`);
    res.status(201).json({ promo: promoView(one('SELECT * FROM promos WHERE code = ?', code)) });
  });

  app.patch('/api/merchant/promos/:code', merchant, (req, res) => {
    const s = requireStore(req, 'manager');
    const existing = one('SELECT * FROM promos WHERE code = ? AND store_id = ?', req.params.code, s.id);
    if (!existing) return res.status(404).json({ error: 'Promo not found' });
    const p = promoInput(req.body || {}, existing);
    db.prepare(`UPDATE promos SET description = ?, kind = ?, value = ?, max_discount_cents = ?, min_subtotal_cents = ?, per_user_limit = ?, public = ?, active = ?, expires_at = ?
      WHERE code = ?`).run(p.description, p.kind, p.value, p.max, p.min, p.per, p.public, p.active, p.expires, existing.code);
    if (req.body?.active !== undefined && !!req.body.active !== !!existing.active) team.log(db, s.id, req.user.id, req.body.active ? 'promo_on' : 'promo_off', existing.code);
    res.json({ promo: promoView(one('SELECT * FROM promos WHERE code = ?', existing.code)) });
  });

  // ---- Admin: what each store is owed, and recording payouts ----------------------------
  app.get('/api/admin/payouts', admin, (req, res) => {
    const stores = db.prepare("SELECT * FROM stores WHERE status <> 'pending' ORDER BY name").all();
    const list = stores.map((s) => {
      const b = balance(s.id);
      const last = one('SELECT amount_cents, paid_at, reference FROM payouts WHERE store_id = ? ORDER BY paid_at DESC, id DESC LIMIT 1', s.id);
      const recentChange = s.bank_updated_at && one("SELECT ? > datetime('now', '-7 days') AS r", s.bank_updated_at).r === 1;
      return {
        storeId: s.id, name: s.name, ...b, bank: bankView(s, true), bankChangedRecently: !!recentChange,
        lastPayout: last ? { amountCents: last.amount_cents, paidAt: last.paid_at, reference: last.reference } : null,
      };
    });
    const recent = db.prepare(`SELECT p.*, s.name FROM payouts p JOIN stores s ON s.id = p.store_id ORDER BY p.paid_at DESC, p.id DESC LIMIT 30`).all()
      .map((p) => ({ id: p.id, store: p.name, amountCents: p.amount_cents, reference: p.reference, paidAt: p.paid_at }));
    res.json({ stores: list, recent, totalOwedCents: list.reduce((n, s) => n + Math.max(0, s.balanceCents), 0) });
  });

  // A bank-ready list of what to pay (for upload or capturing by hand).
  app.get('/api/admin/payouts/batch.csv', admin, (req, res) => {
    const today = one("SELECT date('now', '+2 hours') AS d").d;
    const rows = [['store', 'account_holder', 'bank', 'branch_code', 'account_number', 'account_type', 'amount', 'reference', 'warning']];
    for (const s of db.prepare("SELECT * FROM stores WHERE status <> 'pending' ORDER BY name").all()) {
      const b = balance(s.id);
      if (b.balanceCents <= 0) continue;
      const changed = s.bank_updated_at && one("SELECT ? > datetime('now', '-7 days') AS r", s.bank_updated_at).r === 1;
      rows.push([s.name, s.bank_account_holder || '', s.bank_name || '', s.bank_branch_code || '', s.bank_account_number || '', s.bank_account_type || '',
        rands(b.balanceCents), `CNP ${today.replace(/-/g, '')} S${s.id}`,
        !s.bank_account_number ? 'No bank details' : changed ? 'Bank details changed this week — confirm by phone' : '']);
    }
    res.type('text/csv').attachment(`payouts-${today}.csv`).send(sheet(rows));
  });

  app.post('/api/admin/payouts', admin, (req, res) => {
    const b = req.body || {};
    const s = one('SELECT * FROM stores WHERE id = ?', Number(b.storeId));
    if (!s) return res.status(404).json({ error: 'Store not found' });
    const amount = Math.round(Number(b.amountCents));
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Enter the amount paid' });
    const owed = balance(s.id).balanceCents;
    if (amount > owed && !b.allowOverpay) return res.status(409).json({ error: `That is more than the R${rands(owed)} owed`, owedCents: owed });
    const reference = String(b.reference || '').trim().slice(0, 60);
    if (!reference) return res.status(400).json({ error: 'Enter the payment reference from your bank' });
    const { lastInsertRowid: id } = db.prepare('INSERT INTO payouts (store_id, amount_cents, reference, period_end, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, amount, reference, b.periodEnd || null, String(b.note || '').slice(0, 200) || null, req.user.id);
    audit(req.user.id, 'payout_recorded', { storeId: s.id, amountCents: amount, reference });
    orders.bus.emit('payout', s.id, amount, db);
    res.status(201).json({ id, ...balance(s.id) });
  });

  // ---- Refunds after delivery ---------------------------------------------------------
  // Support refunds a delivered order (wrong item, damaged, missing) and
  // says who carries it: the store (it comes off their payout, up to what
  // they earned on the order) or the platform.
  app.post('/api/admin/orders/:id/refund', admin, (req, res) => {
    const o = one('SELECT * FROM orders WHERE id = ?', req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== 'delivered') return res.status(409).json({ error: 'Only delivered orders are refunded here — cancel active orders instead' });
    const b = req.body || {};
    const amount = Math.round(Number(b.amountCents));
    const left = o.total_cents - o.platform_refund_cents - o.store_refund_cents;
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Enter an amount to refund' });
    if (amount > left) return res.status(400).json({ error: `Up to R${rands(left)} can still be refunded on this order` });
    const reason = String(b.reason || '').trim().slice(0, 200);
    if (!reason) return res.status(400).json({ error: 'Say why — the store and customer will see it' });
    if (!['store', 'platform'].includes(b.borneBy)) return res.status(400).json({ error: 'Choose who carries the refund' });
    const storeRoom = Math.max(0, o.subtotal_cents - o.store_discount_cents - o.store_refund_cents);
    const storeCents = b.borneBy === 'store' ? Math.min(amount, storeRoom) : 0;
    const platformCents = amount - storeCents;
    db.transaction(() => {
      db.prepare(`UPDATE orders SET refund_cents = refund_cents + ?, store_refund_cents = store_refund_cents + ?, platform_refund_cents = platform_refund_cents + ?,
        payment_status = CASE WHEN ? >= ? THEN 'refunded' ELSE payment_status END WHERE id = ?`)
        .run(amount, storeCents, platformCents, amount, left, o.id);
      db.prepare('INSERT INTO refunds (order_id, amount_cents, store_cents, reason, created_by) VALUES (?, ?, ?, ?, ?)').run(o.id, amount, storeCents, reason, req.user.id);
      orders.logEvent(db, o.id, 'refunded', `Refunded R${rands(amount)}: ${reason}`);
    })();
    if (refund) refund(o, amount);
    audit(req.user.id, 'order_refunded', { orderId: o.id, amountCents: amount, storeCents, platformCents, reason });
    orders.bus.emit('order', o.id);
    res.json({ order: orders.orderView(db, o.id, 'admin'), storeCents, platformCents });
  });

  app.get('/api/admin/orders/:id/refunds', admin, (req, res) => {
    res.json({ refunds: db.prepare(`SELECT r.amount_cents AS amountCents, r.store_cents AS storeCents, r.reason, r.created_at AS at, u.name AS byName
      FROM refunds r LEFT JOIN users u ON u.id = r.created_by WHERE r.order_id = ? ORDER BY r.id`).all(req.params.id) });
  });

  // ---- Company details for invoices ------------------------------------------------------
  const COMPANY = { name: 'company_name', vatNumber: 'company_vat_number', companyReg: 'company_reg', address: 'company_address' };
  const company = () => Object.fromEntries(Object.entries(COMPANY).map(([k, key]) => [k, setting(key)]));
  app.get('/api/admin/company', admin, (req, res) => res.json({ company: company() }));
  app.put('/api/admin/company', admin, (req, res) => {
    const b = req.body || {};
    const vat = b.vatNumber === undefined ? undefined : String(b.vatNumber).replace(/\s/g, '');
    if (vat && !validVat(vat)) return res.status(400).json({ error: 'A VAT number is 10 digits and starts with 4' });
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, key] of Object.entries(COMPANY)) {
      if (b[k] === undefined) continue;
      put.run(key, k === 'vatNumber' ? vat : String(b[k]).trim().slice(0, 200));
    }
    audit(req.user.id, 'company_details_changed', b);
    res.json({ company: company() });
  });

  // ---- Tax invoice ------------------------------------------------------------------
  // Two suppliers on one receipt: the store sells the goods, the platform
  // sells delivery and its service. Each is a tax invoice only if that
  // supplier is VAT-registered; otherwise it is a plain invoice.
  app.get('/api/orders/:id/invoice', auth(), (req, res) => {
    const o = one('SELECT * FROM orders WHERE id = ?', req.params.id);
    if (!o || (req.user.role !== 'admin' && o.customer_id !== req.user.id)) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== 'delivered') return res.status(409).json({ error: 'The invoice is ready once the order is delivered' });
    const s = one('SELECT * FROM stores WHERE id = ?', o.store_id);
    const c = one('SELECT name, email FROM users WHERE id = ?', o.customer_id);
    const items = db.prepare('SELECT name, price_cents, qty FROM order_items WHERE order_id = ? AND unavailable = 0').all(o.id);
    const goods = o.subtotal_cents - o.store_discount_cents;
    const platformDiscount = o.discount_cents - o.store_discount_cents;
    // A platform promo is the platform's cost: it comes off the platform's
    // own fees on the invoice where it can, and off the goods otherwise.
    const fees = o.delivery_fee_cents + o.service_fee_cents;
    const feeDiscount = Math.min(platformDiscount, fees);
    const goodsDiscount = platformDiscount - feeDiscount;
    const goodsTotal = goods - goodsDiscount;
    const feesTotal = fees - feeDiscount;
    const p = company();
    const at = one(`SELECT ${SAST('?')} AS d`, o.delivered_at).d;
    res.json({
      number: `INV-${o.code}`, orderCode: o.code, date: at,
      customer: { name: c.name, email: c.email, address: o.address },
      goods: {
        supplier: { name: s.legal_name || s.name, tradingAs: s.legal_name ? s.name : null, address: s.address, vatNumber: s.vat_number || null, companyReg: s.company_reg || null },
        taxInvoice: !!s.vat_number,
        lines: items.map((i) => ({ name: i.name, qty: i.qty, unitCents: i.price_cents, totalCents: i.price_cents * i.qty })),
        discountCents: o.store_discount_cents + goodsDiscount,
        totalCents: goodsTotal, vatCents: s.vat_number ? vatOf(goodsTotal) : null,
      },
      services: {
        supplier: { name: p.name, address: p.address || null, vatNumber: p.vatNumber || null, companyReg: p.companyReg || null },
        taxInvoice: !!p.vatNumber,
        lines: [
          { name: 'Delivery', totalCents: o.delivery_fee_cents },
          { name: 'Service fee', totalCents: o.service_fee_cents },
        ].filter((l) => l.totalCents > 0),
        discountCents: feeDiscount,
        totalCents: feesTotal, vatCents: p.vatNumber ? vatOf(feesTotal) : null,
      },
      tipCents: o.tip_cents,
      refundedCents: o.refund_cents,
      paidCents: o.total_cents,
      promoCode: o.promo_code,
    });
  });
}

module.exports = { registerMoneyRoutes, BANKS };

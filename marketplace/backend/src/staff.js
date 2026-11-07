'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const orders = require('./orders');
const team = require('./team');
const compliance = require('./compliance');

// Staff logins, the store activity log, review follow-ups and licence
// expiry. Routes for the store console; the sweep runs from the server.

const LICENCE_STEPS = [60, 30, 7]; // days before expiry
const LOW_RATING = 3;
const REPLY_WINDOW_DAYS = 14;

const ACTIONS = {
  store_created: 'Opened the store', store_paused: 'Paused orders', store_resumed: 'Resumed orders', store_opened: 'Opened the store',
  store_closed: 'Closed the store', busy_time: 'Set busy time', settings_changed: 'Changed store settings', licence_changed: 'Updated the licence',
  product_added: 'Added a product', product_updated: 'Updated a product', menu_imported: 'Imported the menu', items_sold_out: 'Marked items sold out',
  order_accepted: 'Accepted an order', order_rejected: 'Declined an order', order_preparing: 'Started preparing', order_ready: 'Marked an order ready',
  review_replied: 'Replied to a review', bank_details_changed: 'Changed bank details', promo_created: 'Created a promo code',
  promo_on: 'Switched a promo on', promo_off: 'Switched a promo off', staff_added: 'Added a team member', staff_role: 'Changed a role',
  staff_removed: 'Removed a team member', licence_reminder: 'Licence expiry reminder', licence_expired: 'Licence expired',
};

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
}

function licenceStatus(store, now = new Date()) {
  if (!store.licence_expires_on) return null;
  const daysLeft = daysBetween(compliance.sastToday(now), store.licence_expires_on);
  return { expiresOn: store.licence_expires_on, daysLeft, expired: daysLeft < 0, soon: daysLeft >= 0 && daysLeft <= 60 };
}

function reviewsToReply(db, storeId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE store_id = ? AND rating <= ? AND store_reply IS NULL
    AND created_at > datetime('now', ?)`).get(storeId, LOW_RATING, `-${REPLY_WINDOW_DAYS} days`).n;
}

function registerStaffRoutes(app, { db, auth, audit, mailer }) {
  const merchant = auth('merchant');
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  // Badges and warnings for the console header.
  app.get('/api/merchant/alerts', merchant, (req, res) => {
    const c = team.currentStore(db, req);
    if (!c) return res.json({ alerts: null });
    res.json({ alerts: { reviewsToReply: reviewsToReply(db, c.store.id), licence: licenceStatus(c.store) } });
  });

  app.get('/api/merchant/team', merchant, (req, res) => {
    const s = team.storeFor(db, req, 'owner');
    const rows = db.prepare(`SELECT u.id, u.name, u.email, u.last_login_at, u.must_change_password, u.suspended,
        CASE WHEN u.id = s.owner_id THEN 'owner' ELSE m.role END AS member_role, m.created_at
      FROM stores s JOIN users u ON u.id = s.owner_id OR u.id IN (SELECT user_id FROM store_members WHERE store_id = s.id)
      LEFT JOIN store_members m ON m.store_id = s.id AND m.user_id = u.id
      WHERE s.id = ? GROUP BY u.id ORDER BY member_role = 'owner' DESC, u.name`).all(s.id);
    res.json({
      members: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.member_role, lastLoginAt: r.last_login_at, invited: !!r.must_change_password, addedAt: r.created_at })),
      roles: [
        { role: 'packer', label: 'Packer', can: 'The order board: accept, pack, mark sold out, pause and change stock.' },
        { role: 'manager', label: 'Manager', can: 'Everything a packer does, plus the menu, promotions, reviews, insights and settings.' },
      ],
    });
  });

  app.post('/api/merchant/team', merchant, async (req, res, next) => {
    try {
      const s = team.storeFor(db, req, 'owner');
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim();
      const role = req.body?.role;
      if (!['packer', 'manager'].includes(role)) return res.status(400).json({ error: 'Choose packer or manager' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
      const existing = one('SELECT * FROM users WHERE email = ?', email);
      let userId;
      let temp = null;
      if (existing) {
        // Someone who already works in a ClickNPuff store (e.g. at another
        // branch) can be added as they are. Customer and rider accounts
        // can't double as staff logins.
        if (existing.role !== 'merchant') return res.status(409).json({ error: 'That email is used by a customer or rider account — use their work email instead' });
        if (team.isMember(db, s.id, existing.id)) return res.status(409).json({ error: 'They are already on your team' });
        userId = existing.id;
      } else {
        if (!name) return res.status(400).json({ error: 'Enter their name' });
        temp = crypto.randomBytes(9).toString('base64url');
        userId = db.prepare(`INSERT INTO users (email, password_hash, name, role, must_change_password) VALUES (?, ?, ?, 'merchant', 1)`)
          .run(email, await bcrypt.hash(temp, 10), name.slice(0, 80)).lastInsertRowid;
      }
      db.prepare('INSERT INTO store_members (store_id, user_id, role, added_by) VALUES (?, ?, ?, ?)').run(s.id, userId, role, req.user.id);
      team.log(db, s.id, req.user.id, 'staff_added', `${existing?.name || name} as ${role}`);
      // Email them a link to set their own password (7 days), or just let
      // existing staff know. The temporary password is still shown to the
      // owner, for people without email to hand.
      if (mailer) {
        const u = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(userId);
        mailer.emails.staffInvite(u, s.name, role, existing ? null : mailer.makeLink(userId, 'invite', 24 * 7), req.user.name).catch(() => {});
      }
      audit(req.user.id, 'store_staff_added', { storeId: s.id, userId, role });
      res.status(201).json({ id: userId, email, temporaryPassword: temp });
    } catch (e) { next(e); }
  });

  function member(req) {
    const s = team.storeFor(db, req, 'owner');
    const id = Number(req.params.userId);
    if (id === s.owner_id) throw new orders.OrderError("The owner's access can't be changed", 400);
    const m = one('SELECT m.*, u.name FROM store_members m JOIN users u ON u.id = m.user_id WHERE m.store_id = ? AND m.user_id = ?', s.id, id);
    if (!m) throw new orders.OrderError('Not on your team', 404);
    return { s, m };
  }

  app.patch('/api/merchant/team/:userId', merchant, (req, res) => {
    const { s, m } = member(req);
    if (!['packer', 'manager'].includes(req.body?.role)) return res.status(400).json({ error: 'Choose packer or manager' });
    db.prepare('UPDATE store_members SET role = ? WHERE store_id = ? AND user_id = ?').run(req.body.role, s.id, m.user_id);
    team.log(db, s.id, req.user.id, 'staff_role', `${m.name}: ${m.role} → ${req.body.role}`);
    orders.bus.emit('staff_changed', s.id, m.user_id, req.body.role, db);
    res.json({ ok: true });
  });

  app.delete('/api/merchant/team/:userId', merchant, (req, res) => {
    const { s, m } = member(req);
    db.prepare('DELETE FROM store_members WHERE store_id = ? AND user_id = ?').run(s.id, m.user_id);
    team.log(db, s.id, req.user.id, 'staff_removed', m.name);
    orders.bus.emit('staff_changed', s.id, m.user_id, null, db);
    audit(req.user.id, 'store_staff_removed', { storeId: s.id, userId: m.user_id });
    res.json({ ok: true });
  });

  app.get('/api/merchant/activity', merchant, (req, res) => {
    const s = team.storeFor(db, req, 'manager');
    const before = Number(req.query.before) || null;
    const rows = db.prepare(`SELECT a.id, a.action, a.detail, a.at, u.name FROM store_activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.store_id = ? AND (? IS NULL OR a.id < ?) ORDER BY a.id DESC LIMIT 100`).all(s.id, before, before);
    res.json({ entries: rows.map((r) => ({ id: r.id, action: r.action, label: ACTIONS[r.action] || r.action.replace(/_/g, ' '), detail: r.detail, at: r.at, by: r.name || 'System' })) });
  });
}

// Licence reminders at 60, 30 and 7 days, and once when it lapses (when
// canSell starts hiding the store's regulated products). Each step is sent
// once per expiry date; changing the date starts over.
function licenceSweep(db, now = new Date()) {
  const out = [];
  for (const s of db.prepare("SELECT * FROM stores WHERE licence_expires_on IS NOT NULL AND status = 'approved'").all()) {
    const st = licenceStatus(s, now);
    const step = st.expired ? 'expired' : String(LICENCE_STEPS.filter((d) => st.daysLeft <= d).pop() ?? '');
    if (!step || step === s.licence_reminded) continue;
    // Don't send an older step after a newer one (e.g. 60 after 30).
    const order = ['60', '30', '7', 'expired'];
    if (s.licence_reminded && order.indexOf(step) < order.indexOf(s.licence_reminded)) continue;
    db.prepare('UPDATE stores SET licence_reminded = ? WHERE id = ?').run(step, s.id);
    team.log(db, s.id, null, step === 'expired' ? 'licence_expired' : 'licence_reminder', step === 'expired' ? 'Regulated products hidden' : `${st.daysLeft} days left`);
    orders.bus.emit('licence', s.id, step, st.daysLeft, db);
    out.push({ storeId: s.id, step });
  }
  return out;
}

module.exports = { registerStaffRoutes, licenceSweep, licenceStatus, reviewsToReply, LOW_RATING };

'use strict';

// Promo codes: who may use one, and what it takes off. Platform codes are
// funded by the platform (stores are still owed their full item total);
// a store's own codes only work at that store and come off its payout.

const COUNTED = "status NOT IN ('cancelled','rejected')";

function find(db, code) {
  if (!code) return null;
  return db.prepare('SELECT * FROM promos WHERE code = ? AND active = 1').get(String(code).trim()) || null;
}

function uses(db, code, userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE promo_code = ? AND customer_id = ? AND ${COUNTED}`).get(code, userId).n;
}

function isFirstOrder(db, userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND ${COUNTED} AND status <> 'pending_payment'`).get(userId).n === 0;
}

// Returns { ok, discountCents, promo } or { ok: false, reason }.
function apply(db, code, { userId, storeId, subtotalCents, deliveryFeeCents, now = new Date() }) {
  const p = find(db, code);
  if (!p) return { ok: false, reason: "That code isn't valid" };
  if (p.store_id && p.store_id !== storeId) {
    const s = db.prepare('SELECT name FROM stores WHERE id = ?').get(p.store_id);
    return { ok: false, reason: `${p.code} only works at ${s?.name || 'another store'}` };
  }
  if (p.expires_at && new Date(p.expires_at) < now) return { ok: false, reason: 'That code has expired' };
  if (!userId) return { ok: false, reason: 'Sign in to use a promo code' };
  if (subtotalCents < p.min_subtotal_cents) return { ok: false, reason: `Spend R${p.min_subtotal_cents / 100} or more to use ${p.code}` };
  if (p.first_order_only && !isFirstOrder(db, userId)) return { ok: false, reason: `${p.code} is for your first order` };
  if (uses(db, p.code, userId) >= p.per_user_limit) return { ok: false, reason: `You've already used ${p.code}${p.per_user_limit > 1 ? ` ${p.per_user_limit} times` : ''}` };
  let discount = 0;
  if (p.kind === 'percent') discount = Math.round((subtotalCents * p.value) / 100);
  if (p.kind === 'fixed') discount = p.value;
  if (p.kind === 'free_delivery') discount = deliveryFeeCents;
  if (p.max_discount_cents != null) discount = Math.min(discount, p.max_discount_cents);
  discount = Math.min(discount, subtotalCents);
  if (discount <= 0) return { ok: false, reason: p.kind === 'free_delivery' ? 'Delivery is already free on this order' : "That code doesn't apply to this order" };
  return { ok: true, discountCents: discount, storeFunded: !!p.store_id, promo: { code: p.code, description: p.description, store: !!p.store_id } };
}

// Codes a customer could use right now, to suggest at checkout.
function available(db, userId, storeId) {
  const list = db.prepare(`SELECT * FROM promos WHERE active = 1 AND public = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))
    AND (store_id IS NULL OR store_id = ?)`).all(storeId || null);
  return list
    .filter((p) => !userId || ((!p.first_order_only || isFirstOrder(db, userId)) && uses(db, p.code, userId) < p.per_user_limit))
    .map((p) => ({ code: p.code, description: p.description, minSubtotalCents: p.min_subtotal_cents, store: !!p.store_id }));
}

module.exports = { apply, available };

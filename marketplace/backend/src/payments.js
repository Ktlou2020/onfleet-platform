'use strict';
const crypto = require('crypto');

// Two providers behind one interface. "mock" settles instantly and is what
// local development and the tests use. "paystack" is wired for production —
// but confirm in writing that your merchant category is accepted before
// going live; card acquirers apply their own restricted-goods rules.

function provider() {
  return process.env.PAYMENT_PROVIDER === 'paystack' ? paystack : mock;
}

const mock = {
  name: 'mock',
  async start(order) {
    return { reference: `mock_${order.code}_${Date.now()}`, settleNow: true };
  },
  async verify(reference) {
    return { ok: reference.startsWith('mock_') };
  },
  async refund() {
    return { ok: true };
  },
  verifyWebhook() {
    return false;
  },
};

const PAYSTACK = 'https://api.paystack.co';

async function paystackCall(path, body) {
  const res = await fetch(PAYSTACK + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.status) throw new Error(json.message || `Paystack ${path} failed`);
  return json.data;
}

const paystack = {
  name: 'paystack',
  async start(order, customer) {
    const reference = `vd_${order.code}_${Date.now()}`;
    const data = await paystackCall('/transaction/initialize', {
      email: customer.email,
      amount: order.total_cents, // Paystack takes ZAR in cents
      currency: 'ZAR',
      reference,
      callback_url: `${process.env.PUBLIC_URL || 'http://localhost:5174'}/orders/${order.id}?ref=${reference}`,
      metadata: { order_id: order.id, order_code: order.code },
    });
    return { reference, redirectUrl: data.authorization_url, settleNow: false };
  },
  async verify(reference, expectedCents) {
    const data = await paystackCall(`/transaction/verify/${encodeURIComponent(reference)}`);
    return { ok: data.status === 'success' && data.amount === expectedCents && data.currency === 'ZAR' };
  },
  async refund(order) {
    if (!order.payment_ref) return { ok: false };
    await paystackCall('/refund', { transaction: order.payment_ref });
    return { ok: true };
  },
  verifyWebhook(rawBody, signature) {
    if (!signature || !process.env.PAYSTACK_SECRET_KEY) return false;
    const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
};

module.exports = { provider, mock, paystack };

'use strict';
const crypto = require('crypto');
const orders = require('./orders');
const team = require('./team');

// Transactional email through Brevo (https://developers.brevo.com).
//
//   BREVO_API_KEY  the API key (Brevo → SMTP & API → API keys). Without it
//                  emails are logged and skipped, so dev and tests send nothing.
//   EMAIL_FROM     sender, default "ClickNPuff <hello@clicknpuff.co.za>".
//                  Must be on a domain authenticated in Brevo.
//   EMAIL_REPLY_TO where replies go, default help@clicknpuff.co.za.
//   PUBLIC_URL     site address for links in emails.
//
// Every email is recorded in email_log. Ones tied to an event (an order
// confirmation, a delivery) carry a key so they're sent once even if the
// event fires twice.

const BRAND = 'ClickNPuff';
const GREEN = '#2f855a';

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_log (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id),
      to_email   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      dedupe     TEXT UNIQUE,
      subject    TEXT NOT NULL,
      status     TEXT NOT NULL,
      error      TEXT,
      message_id TEXT,
      at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      purpose    TEXT NOT NULL DEFAULT 'reset',
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function parseFrom(s) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s || '');
  return m ? { name: m[1] || BRAND, email: m[2] } : { name: BRAND, email: (s || '').trim() };
}

// The real sender: Brevo's transactional email API.
function brevoSender(apiKey) {
  return async (msg) => {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(msg),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${body.message || body.code || 'send failed'}`);
    return { messageId: body.messageId };
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rands = (c) => `R${(c / 100).toFixed(2)}`;

// One simple, mobile-friendly layout. Blocks: strings are paragraphs (already
// escaped by the caller via t``), {button}, {rows}, {note}.
function layout({ preheader = '', heading, blocks }) {
  const body = blocks.map((b) => {
    if (typeof b === 'string') return `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#33473c">${b}</p>`;
    if (b.button) return `<p style="margin:20px 0"><a href="${esc(b.href)}" style="background:${GREEN};color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">${esc(b.button)}</a></p>`;
    if (b.rows) {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 16px;font-size:14px">${b.rows.map(([l, r, strong]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e3e9e4;color:#33473c${strong ? ';font-weight:700' : ''}">${esc(l)}</td><td align="right" style="padding:6px 0;border-bottom:1px solid #e3e9e4;color:#0f2a1d${strong ? ';font-weight:700' : ''}">${esc(r)}</td></tr>`).join('')}</table>`;
    }
    if (b.note) return `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#6b7c72">${b.note}</p>`;
    return '';
  }).join('');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"></head>
<body style="margin:0;background:#f6f8f5;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e9e4;border-radius:16px">
<tr><td style="padding:22px 26px 0;font-size:20px;font-weight:800;color:#0f2a1d">💨 ${BRAND}</td></tr>
<tr><td style="padding:14px 26px 26px">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#0f2a1d">${esc(heading)}</h1>
${body}
</td></tr></table>
<p style="font-size:12px;color:#6b7c72;margin:14px 0 0">${BRAND} · 18+ only · ID checked on every delivery<br>Questions? Reply to this email or write to help@clicknpuff.co.za</p>
</td></tr></table></body></html>`;
}

function textOf({ heading, blocks }) {
  const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return [heading, '', ...blocks.map((b) => {
    if (typeof b === 'string') return strip(b);
    if (b.button) return `${b.button}: ${b.href}`;
    if (b.rows) return b.rows.map(([l, r]) => `${l}: ${r}`).join('\n');
    if (b.note) return strip(b.note);
    return '';
  }), '', `— ${BRAND}`].join('\n');
}

function createMailer(db, { send, log = console } = {}) {
  init(db);
  const key = process.env.BREVO_API_KEY;
  const sender = send || (key ? brevoSender(key) : null);
  const from = parseFrom(process.env.EMAIL_FROM || `${BRAND} <hello@clicknpuff.co.za>`);
  const replyTo = process.env.EMAIL_REPLY_TO || 'help@clicknpuff.co.za';
  const site = () => (process.env.PUBLIC_URL || 'https://www.clicknpuff.co.za').replace(/\/$/, '');

  // Returns 'sent' | 'skipped' | 'duplicate' | 'failed'.
  async function sendEmail({ to, name, userId, kind, dedupe, subject, heading, preheader, blocks }) {
    if (!to) return 'skipped';
    if (dedupe) {
      try {
        db.prepare("INSERT INTO email_log (user_id, to_email, kind, dedupe, subject, status) VALUES (?, ?, ?, ?, ?, 'queued')").run(userId || null, to, kind, dedupe, subject);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return 'duplicate';
        throw e;
      }
    } else {
      db.prepare("INSERT INTO email_log (user_id, to_email, kind, subject, status) VALUES (?, ?, ?, ?, 'queued')").run(userId || null, to, kind, subject);
    }
    const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    const set = (status, extra = {}) => db.prepare('UPDATE email_log SET status = ?, error = ?, message_id = ? WHERE id = ?').run(status, extra.error || null, extra.messageId || null, id);
    if (!sender) { set('skipped', { error: 'BREVO_API_KEY not set' }); return 'skipped'; }
    try {
      const r = await sender({
        sender: from, to: [{ email: to, ...(name ? { name } : {}) }], replyTo: { email: replyTo },
        subject, htmlContent: layout({ heading, preheader, blocks }), textContent: textOf({ heading, blocks }), tags: [kind],
      });
      set('sent', { messageId: r?.messageId });
      return 'sent';
    } catch (e) {
      set('failed', { error: String(e.message).slice(0, 300) });
      log.error?.(`email ${kind} to ${to} failed: ${e.message}`);
      return 'failed';
    }
  }

  const user = (id) => db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(id);
  const first = (n) => esc(String(n || '').split(' ')[0] || 'there');

  // ---- Password links (reset, and setting a password for invited staff) ----
  function makeLink(userId, purpose = 'reset', hours = 1) {
    const token = crypto.randomBytes(24).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare("INSERT INTO password_resets (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, datetime('now', ?))").run(hash, userId, purpose, `+${hours} hours`);
    return `${site()}/reset?token=${token}`;
  }
  // Returns the user id if the token is good, and spends it.
  function useLink(token) {
    const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
    const row = db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')").get(hash);
    if (!row) return null;
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?").run(hash);
    // One reset spends every other open link for that person.
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(row.user_id);
    return row.user_id;
  }

  const emails = {
    welcome: (u) => sendEmail({
      to: u.email, name: u.name, userId: u.id, kind: 'welcome', dedupe: `welcome:${u.id}`,
      subject: u.role === 'merchant' ? `Welcome to ${BRAND} — let's get your store live` : u.role === 'rider' ? `Welcome to ${BRAND} — next steps to start riding` : `Welcome to ${BRAND}`,
      heading: `Welcome, ${String(u.name || '').split(' ')[0] || 'there'}!`,
      blocks: u.role === 'merchant'
        ? ['Your account is ready. Set up your store, add your menu and we\'ll review your application within one working day.', { button: 'Open the store console', href: `${site()}/merchant` }]
        : u.role === 'rider'
          ? ['Your rider account is ready. Add your vehicle and documents in the rider app, and we\'ll be in touch to get you on the road.', { button: 'Open the rider app', href: `${site()}/rider` }]
          : ['Order from local stores and get it delivered in under an hour. Every delivery is checked for ID at the door, so keep yours handy.', { button: 'Start shopping', href: `${site()}/` }],
    }),

    passwordReset: (u, link) => sendEmail({
      to: u.email, name: u.name, userId: u.id, kind: 'password_reset',
      subject: `Reset your ${BRAND} password`, heading: 'Reset your password', preheader: 'This link works for one hour.',
      blocks: [`Hi ${first(u.name)}, someone (hopefully you) asked to reset the password for this account.`, { button: 'Choose a new password', href: link },
        { note: "The link works once, for one hour. If you didn't ask for this, ignore this email — your password stays the same." }],
    }),

    staffInvite: (u, storeName, role, link, invitedBy) => sendEmail({
      to: u.email, name: u.name, userId: u.id, kind: 'staff_invite',
      subject: `You've been added to ${storeName} on ${BRAND}`, heading: `Join ${storeName}`,
      blocks: [`Hi ${first(u.name)}, ${esc(invitedBy)} added you to <b>${esc(storeName)}</b> as a <b>${esc(role)}</b>.`,
        link ? { button: 'Set your password', href: link } : { button: 'Sign in', href: `${site()}/login` },
        { note: link ? 'The link works for 7 days. After that, ask the store owner for a new one, or use "Forgot password" on the sign-in page.' : 'Sign in with your existing password.' }],
    }),
  };

  // ---- Order emails ---------------------------------------------------------
  function orderData(orderId) {
    const o = db.prepare(`SELECT o.*, s.name AS store_name, s.slug AS store_slug, u.email, u.name AS customer_name FROM orders o
      JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.customer_id WHERE o.id = ?`).get(orderId);
    if (!o) return null;
    o.items = db.prepare('SELECT name, qty, price_cents, unavailable FROM order_items WHERE order_id = ?').all(orderId);
    return o;
  }
  const receiptRows = (o) => [
    ...o.items.filter((i) => !i.unavailable).map((i) => [`${i.qty}× ${i.name}`, rands(i.qty * i.price_cents)]),
    ['Delivery', o.delivery_fee_cents ? rands(o.delivery_fee_cents) : 'Free'],
    ['Service fee', rands(o.service_fee_cents)],
    ...(o.discount_cents ? [[`Promo ${o.promo_code || ''}`.trim(), `−${rands(o.discount_cents)}`]] : []),
    ...(o.tip_cents ? [['Rider tip', rands(o.tip_cents)]] : []),
    ['Total paid', rands(o.total_cents), true],
  ];

  async function onStatus(orderId, to) {
    const o = orderData(orderId);
    if (!o) return;
    const track = `${site()}/orders/${o.id}`;
    const base = { to: o.email, name: o.customer_name, userId: o.customer_id };
    const wasScheduled = !!db.prepare("SELECT 1 FROM order_events WHERE order_id = ? AND status = 'scheduled'").get(o.id);
    // A pre-order's time has come: the store is packing it now.
    if (to === 'placed' && wasScheduled) {
      return sendEmail({
        ...base, kind: 'preorder_started', dedupe: `preorder_started:${o.id}`,
        subject: `Your pre-order #${o.code} is being prepared`, heading: "Deliveries are open — we're on it",
        blocks: [`${esc(o.store_name)} is getting your order ready now. It should be with you in about ${o.eta_minutes} minutes.`, { button: 'Track your order', href: track },
          { note: 'Have your ID ready for the rider.' }],
      });
    }
    // Something in the order sold out: the customer has a few minutes to choose.
    if (to === 'item_unavailable') {
      const gone = o.items.filter((i) => i.unavailable).map((i) => i.name);
      return sendEmail({
        ...base, kind: 'item_unavailable', dedupe: `item_unavailable:${o.id}`,
        subject: `Action needed: ${gone[0] || 'an item'} is sold out (order #${o.code})`, heading: 'Something in your order sold out',
        blocks: [`${esc(o.store_name)} has run out of: <b>${esc(gone.join(', '))}</b>.`,
          "Choose whether to go ahead without it (you're refunded for it) or cancel the whole order. If we don't hear from you in 5 minutes, we'll go ahead without it.",
          { button: 'Choose now', href: track }],
      });
    }
    if (to === 'items_removed') {
      const back = db.prepare("SELECT note FROM order_events WHERE order_id = ? AND status = 'items_removed' ORDER BY id DESC LIMIT 1").get(o.id)?.note || '';
      return sendEmail({
        ...base, kind: 'items_removed', dedupe: `items_removed:${o.id}`,
        subject: `Order #${o.code} updated — sold-out items refunded`, heading: 'Your order is going ahead',
        blocks: [esc(back), "Here's your updated order:", { rows: receiptRows(o) }, 'Card refunds usually show within 3–7 working days, depending on your bank.', { button: 'Track your order', href: track }],
      });
    }
    if ((to === 'placed' || to === 'scheduled') && o.payment_status === 'paid') {
      const when = o.scheduled_for
        ? `We'll deliver from ${new Date(new Date(o.scheduled_for).getTime() + 2 * 3600e3).toISOString().slice(0, 16).replace('T', ' at ')} (SAST), when deliveries open.`
        : `${esc(o.store_name)} is getting it ready. It should be with you in about ${o.eta_minutes} minutes.`;
      return sendEmail({
        ...base, kind: 'order_confirmed', dedupe: `order_confirmed:${o.id}`,
        subject: `Order #${o.code} confirmed — ${o.store_name}`, heading: 'Thanks — your order is in', preheader: `Order #${o.code} from ${o.store_name}`,
        blocks: [when, { rows: receiptRows(o) }, `Delivering to: ${esc(o.address)}`, { button: 'Track your order', href: track },
          { note: 'Have your ID ready: the rider checks it at the door and can\'t hand over the order without it.' }],
      });
    }
    if (to === 'delivered') {
      return sendEmail({
        ...base, kind: 'order_delivered', dedupe: `order_delivered:${o.id}`,
        subject: `Delivered: order #${o.code}`, heading: 'Your order was delivered',
        blocks: [`Enjoy! Your order from ${esc(o.store_name)} has arrived.`, { rows: receiptRows(o) },
          { button: 'Rate your order', href: track }, `Need a tax invoice? <a href="${esc(`${site()}/orders/${o.id}/invoice`)}" style="color:${GREEN}">Download it here</a>.`],
      });
    }
    if (to === 'cancelled' && o.payment_status === 'unpaid') {
      // Never paid for: a gentle nudge, not a cancellation notice.
      return sendEmail({
        ...base, kind: 'order_unpaid', dedupe: `order_ended:${o.id}`,
        subject: `Your ${o.store_name} order wasn't completed`, heading: 'Still want it?',
        blocks: ["Your order wasn't paid for, so we didn't send it to the store. Nothing has been charged.", { rows: o.items.map((i) => [`${i.qty}× ${i.name}`, rands(i.qty * i.price_cents)]) },
          { button: `Back to ${o.store_name}`, href: `${site()}/store/${o.store_slug}` }],
      });
    }
    if (['cancelled', 'rejected', 'returned'].includes(to)) {
      const refunded = o.payment_status === 'refunded';
      const why = db.prepare("SELECT note FROM order_events WHERE order_id = ? AND status = ? ORDER BY id DESC LIMIT 1").get(o.id, to)?.note;
      return sendEmail({
        ...base, kind: `order_${to}`, dedupe: `order_ended:${o.id}`,
        subject: to === 'rejected' ? `${o.store_name} couldn't take order #${o.code}` : `Order #${o.code} ${to === 'returned' ? 'could not be delivered' : 'was cancelled'}`,
        heading: to === 'rejected' ? 'Sorry — the store couldn\'t take your order' : to === 'returned' ? 'We couldn\'t deliver your order' : 'Your order was cancelled',
        blocks: [why ? esc(why) : 'Your order did not go ahead.', refunded ? `You've been refunded ${rands(o.total_cents)}. Card refunds usually show within 3–7 working days, depending on your bank.` : 'You have not been charged.',
          { button: 'Find something else', href: `${site()}/` }],
      });
    }
    return undefined;
  }

  const listeners = [];
  // Events carry their database last; tests run many apps on one bus.
  const on = (event, fn) => {
    const h = (...a) => { if (a[a.length - 1] !== db) return; Promise.resolve(fn(...a)).catch((e) => log.error?.('email', e)); };
    orders.bus.on(event, h);
    listeners.push([event, h]);
  };

  on('status', (orderId, to) => onStatus(orderId, to));

  on('refund_after_delivery', async (orderId, amountCents, reason) => {
    const o = orderData(orderId);
    if (!o) return;
    await sendEmail({ to: o.email, name: o.customer_name, userId: o.customer_id, kind: 'refund', subject: `Refund of ${rands(amountCents)} for order #${o.code}`,
      heading: `We've refunded ${rands(amountCents)}`, blocks: [`For your order #${o.code} from ${esc(o.store_name)}: ${esc(reason)}.`, 'Card refunds usually show within 3–7 working days, depending on your bank.'] });
  });

  // ---- Store emails ---------------------------------------------------------------
  const storeEmail = async (storeId, need, msg) => {
    for (const id of team.memberIds(db, storeId, need)) {
      const u = user(id);
      if (!u) continue;
      const m = msg(u);
      await sendEmail({ ...m, dedupe: m.dedupe ? `${m.dedupe}:${u.id}` : null, to: u.email, name: u.name, userId: u.id });
    }
  };

  on('store_status', async (storeId, status) => {
    const s = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId);
    if (!s || !['approved', 'suspended'].includes(status)) return;
    await storeEmail(storeId, 'owner', () => (status === 'approved'
      ? { kind: 'store_approved', dedupe: `store_approved:${storeId}`, subject: `${s.name} is approved — you're live on ${BRAND}`, heading: "You're live! 🎉",
        blocks: [`${esc(s.name)} has been approved. Switch the store on, and customers nearby can start ordering.`, 'Tips for a strong start: add photos, mark a few store picks, and turn on order alerts on the device at your counter.', { button: 'Open the store console', href: `${site()}/merchant` }] }
      : { kind: 'store_suspended', subject: `${s.name} has been suspended`, heading: 'Your store has been suspended', blocks: [`${esc(s.name)} can't take orders for now. Reply to this email and our team will explain what's needed.`] }));
  });

  on('payout', async (storeId, amountCents) => {
    const p = db.prepare('SELECT p.reference, s.name FROM payouts p JOIN stores s ON s.id = p.store_id WHERE p.store_id = ? ORDER BY p.id DESC LIMIT 1').get(storeId);
    await storeEmail(storeId, 'owner', () => ({
      kind: 'payout', subject: `Payout sent: ${rands(amountCents)}`, heading: `We've paid you ${rands(amountCents)}`,
      blocks: [`An EFT of <b>${rands(amountCents)}</b> to ${esc(p?.name || 'your store')}'s bank account is on its way${p?.reference ? ` (reference ${esc(p.reference)})` : ''}. It usually clears in 1–2 working days.`,
        { button: 'See your statement', href: `${site()}/merchant?section=payouts` }],
    }));
  });

  on('licence', async (storeId, step, daysLeft) => {
    await storeEmail(storeId, 'owner', () => ({
      kind: 'licence', dedupe: `licence:${storeId}:${step}:${db.prepare('SELECT licence_expires_on AS d FROM stores WHERE id = ?').get(storeId)?.d}`,
      subject: step === 'expired' ? 'Your licence has expired — regulated products are hidden' : `Your licence expires in ${daysLeft} days`,
      heading: step === 'expired' ? 'Your licence has expired' : 'Time to renew your licence',
      blocks: [step === 'expired' ? 'Regulated products are hidden from customers until your renewed licence is uploaded and verified.' : `Renew it now and add the new expiry date in Store settings so nothing gets hidden.`,
        { button: 'Open Store settings', href: `${site()}/merchant?section=store` }],
    }));
  });

  on('low_rating', async (storeId, rating, comment) => {
    await storeEmail(storeId, 'manager', () => ({
      kind: 'low_rating', subject: `A ${rating}-star review needs a reply`, heading: 'A customer wasn\'t happy',
      blocks: [comment ? `“${esc(comment)}”` : `They gave ${rating} star${rating === 1 ? '' : 's'} without a comment.`, 'A quick, kind reply (and a fix) wins most customers back — and everyone else sees that you care.', { button: 'Reply now', href: `${site()}/merchant?section=reviews` }],
    }));
  });

  // ---- Admin: new store applications ----
  on('store_applied', async (storeId) => {
    const s = db.prepare('SELECT s.name, s.address, u.email FROM stores s JOIN users u ON u.id = s.owner_id WHERE s.id = ?').get(storeId);
    if (!s) return;
    await storeEmail(storeId, 'owner', () => ({
      kind: 'store_received', dedupe: `store_received:${storeId}`, subject: `We've received your application for ${s.name}`, heading: 'Application received',
      blocks: [`Thanks for applying to sell on ${BRAND}. We review stores within one working day and will email you as soon as <b>${esc(s.name)}</b> is approved.`,
        'While you wait: add your menu with photos, set your opening hours, and add your bank details under Money so payouts can start straight away.',
        { button: 'Set up your menu', href: `${site()}/merchant?section=menu` }],
    }));
    for (const a of db.prepare("SELECT id, email, name FROM users WHERE role = 'admin' AND suspended = 0").all()) {
      await sendEmail({ to: a.email, name: a.name, userId: a.id, kind: 'admin_store_applied', subject: `New store to review: ${s.name}`, heading: 'A store wants to join',
        blocks: [`<b>${esc(s.name)}</b> — ${esc(s.address)} (${esc(s.email)})`, { button: 'Review in Stores', href: `${site()}/admin` }] });
    }
  });


  // ---- Security notices --------------------------------------------------------
  on('password_changed', async (userId) => {
    const u = user(userId);
    if (!u) return;
    await sendEmail({ to: u.email, name: u.name, userId: u.id, kind: 'password_changed', subject: `Your ${BRAND} password was changed`, heading: 'Your password was changed',
      blocks: [`Hi ${first(u.name)}, the password for your ${BRAND} account was just changed.`, "If this was you, there's nothing to do.",
        { note: `If it wasn't you, <a href="${esc(`${site()}/forgot`)}" style="color:${GREEN}">reset your password now</a> and reply to this email so we can secure your account.` }] });
  });

  // Goes to the owner even when the owner made the change: that's the point.
  on('bank_changed', async (storeId, byUserId, summary) => {
    const s = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId);
    const by = user(byUserId);
    await storeEmail(storeId, 'owner', () => ({
      kind: 'bank_changed', subject: `Bank details changed for ${s?.name}`, heading: 'Your payout bank account was changed',
      blocks: [`The bank account for <b>${esc(s?.name)}</b> payouts was changed to <b>${esc(summary)}</b> by ${esc(by?.name || 'someone on your team')}.`, 'If this was you, nothing else is needed — our team will confirm the new details with you before the next payout.',
        { note: 'If you did NOT make this change, reply to this email immediately and change your password. We hold payouts to newly changed accounts until we have confirmed them with you.' }],
    }));
    for (const a of db.prepare("SELECT id, email, name FROM users WHERE role = 'admin' AND suspended = 0").all()) {
      await sendEmail({ to: a.email, name: a.name, userId: a.id, kind: 'admin_bank_changed', subject: `Bank details changed: ${s?.name}`, heading: 'A store changed its payout account',
        blocks: [`<b>${esc(s?.name)}</b> → ${esc(summary)} (by ${esc(by?.email || 'unknown')}).`, 'Confirm by phone, on the number you already have, before the next payout.', { button: 'Open Payouts', href: `${site()}/admin` }] });
    }
  });

  // ---- Help requests ----------------------------------------------------------------
  const helpRow = (id) => db.prepare(`SELECT h.*, o.code, o.id AS oid, s.name AS store_name, u.email, u.name FROM help_requests h
    JOIN orders o ON o.id = h.order_id JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = h.customer_id WHERE h.id = ?`).get(id);
  on('help_requested', async (id) => {
    const h = helpRow(id);
    if (!h) return;
    await sendEmail({ to: h.email, name: h.name, userId: h.customer_id, kind: 'help_received', dedupe: `help_received:${id}`, subject: `We're on it: order #${h.code}`,
      heading: "We've got your message", blocks: [`Thanks, ${first(h.name)}. Our team is looking into your order #${h.code} from ${esc(h.store_name)} and will get back to you soon — usually within a few hours.`,
        h.note ? `You told us: “${esc(h.note)}”` : '', { note: 'Reply to this email to add anything else, like a photo.' }].filter(Boolean) });
    for (const a of db.prepare("SELECT id, email, name FROM users WHERE role = 'admin' AND suspended = 0").all()) {
      await sendEmail({ to: a.email, name: a.name, userId: a.id, kind: 'admin_help', subject: `Help request: #${h.code} (${h.type.replace(/_/g, ' ')})`, heading: 'A customer needs help',
        blocks: [`<b>${esc(h.name)}</b> (${esc(h.email)}) · order #${h.code} from ${esc(h.store_name)}`, h.note ? `“${esc(h.note)}”` : 'No note.', { button: 'Open Incidents', href: `${site()}/admin` }] });
    }
  });
  on('help_resolved', async (id) => {
    const h = helpRow(id);
    if (!h) return;
    await sendEmail({ to: h.email, name: h.name, userId: h.customer_id, kind: 'help_resolved', dedupe: `help_resolved:${id}`, subject: `Update on order #${h.code}`,
      heading: 'Here\'s what we did', blocks: [esc(h.resolution), { button: 'View your order', href: `${site()}/orders/${h.oid}` }, { note: 'Not sorted? Just reply to this email.' }] });
  });

  // ---- Store: missed and urgent orders, applications, staff ----------------------------
  on('store_escalation', async (orderId, minutesLeft) => {
    const o = orderData(orderId);
    if (!o) return;
    await storeEmail(o.store_id, 'manager', () => ({
      kind: 'store_escalation', dedupe: null, subject: `⏰ Order #${o.code} is waiting — ${minutesLeft} min left`, heading: 'An order is waiting for you',
      blocks: [`Order #${o.code} (${rands(o.subtotal_cents)}) has been waiting. Accept it in the next <b>${minutesLeft} minutes</b> or it will be declined and refunded.`, { button: 'Open the order board', href: `${site()}/merchant` }],
    }));
  });
  on('store_missed', async (orderId) => {
    const o = orderData(orderId);
    if (!o) return;
    await storeEmail(o.store_id, 'manager', () => ({
      kind: 'store_missed', subject: `Missed order #${o.code} — declined automatically`, heading: 'You missed an order',
      blocks: [`Order #${o.code} for ${rands(o.subtotal_cents)} wasn't accepted in time, so it was declined and the customer refunded.`,
        'To avoid this: keep the console open on a device at the counter with alerts on, pause the store when you\'re too busy, or switch on auto-accept in Store settings.',
        { button: 'Open the store console', href: `${site()}/merchant` }],
    }));
  });
  on('licence_submitted', async (storeId) => {
    const s = db.prepare('SELECT name, licence_number, licence_expires_on FROM stores WHERE id = ?').get(storeId);
    for (const a of db.prepare("SELECT id, email, name FROM users WHERE role = 'admin' AND suspended = 0").all()) {
      await sendEmail({ to: a.email, name: a.name, userId: a.id, kind: 'admin_licence', subject: `Licence to verify: ${s.name}`, heading: 'A licence needs checking',
        blocks: [`<b>${esc(s.name)}</b> submitted licence ${esc(s.licence_number)}${s.licence_expires_on ? `, expiring ${esc(s.licence_expires_on)}` : ''}. Regulated products stay hidden until you verify it.`, { button: 'Review in Stores', href: `${site()}/admin` }] });
    }
  });
  on('staff_changed', async (storeId, userId, role) => {
    const u = user(userId);
    const s = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId);
    if (!u || !s) return;
    await sendEmail({ to: u.email, name: u.name, userId: u.id, kind: role ? 'staff_role' : 'staff_removed',
      subject: role ? `Your role at ${s.name} changed` : `You've been removed from ${s.name}`,
      heading: role ? `You're now a ${role}` : 'Your access was removed',
      blocks: [role ? `You're now a <b>${esc(role)}</b> at ${esc(s.name)}. ${role === 'manager' ? 'You can now manage the menu, promotions, reviews and settings.' : 'You can run the order board and stock.'}`
        : `You no longer have access to ${esc(s.name)} on ${BRAND}. If you think this is a mistake, speak to the store owner.`] });
  });

  // ---- Riders and payments: tell the admins ---------------------------------------
  on('incident', async (riderId, type, orderId, note) => {
    const r = user(riderId);
    const urgent = type === 'sos' || type === 'accident';
    for (const a of db.prepare("SELECT id, email, name FROM users WHERE role = 'admin' AND suspended = 0").all()) {
      await sendEmail({ to: a.email, name: a.name, userId: a.id, kind: `admin_incident_${type}`, subject: `${urgent ? '🚨 URGENT: ' : ''}${type === 'sos' ? 'SOS' : type.replace(/_/g, ' ')} from rider ${r?.name || ''}`.trim(),
        heading: urgent ? 'A rider needs help now' : 'A rider reported a problem',
        blocks: [`<b>${esc(r?.name)}</b>${r?.email ? ` (${esc(r.email)})` : ''}${orderId ? ` · order ${orderId}` : ''}`, note ? `“${esc(note)}”` : 'No note.', urgent ? 'Call the rider now, and emergency services if you can\'t reach them. Their last location is on the live map.' : '', { button: 'Open the live map', href: `${site()}/admin` }].filter(Boolean) });
    }
  });
  on('refund_failed', async (orderId, amountCents, error) => {
    const o = orderData(orderId);
    for (const a of db.prepare("SELECT id, email, name FROM users WHERE role = 'admin' AND suspended = 0").all()) {
      await sendEmail({ to: a.email, name: a.name, userId: a.id, kind: 'admin_refund_failed', subject: `Refund failed: order #${o?.code || orderId}`, heading: 'A refund did not go through',
        blocks: [`Refunding ${rands(amountCents || 0)} to ${esc(o?.customer_name || 'the customer')} for order #${esc(o?.code || orderId)} failed: ${esc(error)}.`, 'Refund it by hand in the payment provider\'s dashboard, then let the customer know.'] });
    }
  });

  // ---- Weekly summary for store owners (Mondays, from 08:00 SAST) ------------------------
  async function weeklySummaries(now = new Date()) {
    const sast = new Date(now.getTime() + 2 * 3600e3);
    if (sast.getUTCDay() !== 1 || sast.getUTCHours() < 8) return 0;
    const monday = sast.toISOString().slice(0, 10);
    const from = new Date(Date.parse(`${monday}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
    let n = 0;
    for (const st of db.prepare("SELECT * FROM stores WHERE status = 'approved'").all()) {
      const w = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal_cents - store_discount_cents - store_refund_cents), 0) AS earned
        FROM orders WHERE store_id = ? AND status = 'delivered' AND date(delivered_at, '+2 hours') >= ? AND date(delivered_at, '+2 hours') < ?`).get(st.id, from, monday);
      const missed = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND status = 'rejected' AND date(updated_at, '+2 hours') >= ? AND date(updated_at, '+2 hours') < ?`).get(st.id, from, monday).n;
      const top = db.prepare(`SELECT i.name, SUM(i.qty) AS q FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.store_id = ? AND o.status = 'delivered'
        AND date(o.delivered_at, '+2 hours') >= ? AND date(o.delivered_at, '+2 hours') < ? AND i.unavailable = 0 GROUP BY i.product_id ORDER BY q DESC LIMIT 3`).all(st.id, from, monday);
      const rating = st.rating_count ? (st.rating_sum / st.rating_count).toFixed(1) : null;
      const res = await (async () => {
        let sent = 0;
        await storeEmail(st.id, 'owner', () => ({
          kind: 'weekly_summary', dedupe: `weekly:${st.id}:${monday}`, subject: `${st.name}: your week — ${w.orders} order${w.orders === 1 ? '' : 's'}, ${rands(w.earned)}`,
          heading: 'Your week on ' + BRAND,
          blocks: [w.orders ? `Here's how ${esc(st.name)} did last week.` : `${esc(st.name)} had no deliveries last week. Is the store switched on, with photos and a few store picks? Those help customers find you.`,
            { rows: [['Orders delivered', String(w.orders)], ['You earned', rands(w.earned)], ['Declined or missed', String(missed)], ['Rating', rating ? `★ ${rating}` : '—']] },
            top.length ? `Best sellers: ${top.map((t) => `${esc(t.name)} (${t.q})`).join(', ')}.` : '',
            { button: 'See your insights', href: `${site()}/merchant?section=insights` }].filter(Boolean),
        }));
        sent++;
        return sent;
      })();
      n += res;
    }
    return n;
  }

  return { sendEmail, emails, makeLink, useLink, weeklySummaries, enabled: !!sender, close: () => listeners.forEach(([e, h]) => orders.bus.off(e, h)) };
}

module.exports = { createMailer, layout };

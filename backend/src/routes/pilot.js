const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');
const { sendEmail } = require('../services/notifier');

const router = express.Router();

const LEAD_STATUSES = ['new', 'contacted', 'demo_scheduled', 'trial_started', 'converted', 'archived'];
const PLAN_OPTIONS = ['trial', 'small', 'medium', 'large', 'enterprise'];

function readEnv(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '').trim();
}

function sanitizeNotes(notes) {
  return String(notes || '').trim().slice(0, 4000);
}

function leadRowSelect(whereClause = '', params = []) {
  return db.prepare(`SELECT * FROM fleet_owner_pilot_leads ${whereClause} ORDER BY created_at DESC`).all(...params);
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function passwordResetExpiryIso() {
  const ttlMinutes = Number(readEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60') || 60);
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function buildResetUrl(token) {
  const base = readEnv('FRONTEND_URL', 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

function issueFleetResetToken(userId, ip, ua) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`).run(userId);
  db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, user_agent) VALUES (?,?,?,?,?)`)
    .run(userId, tokenHash, passwordResetExpiryIso(), ip || null, ua || null);
  return buildResetUrl(rawToken);
}

function slugifyCompanyName(value) {
  const base = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `fleet-${Date.now()}`;
  let slug = base;
  let counter = 2;
  while (db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)) {
    slug = `${base}-${counter++}`;
  }
  return slug;
}

const FLEET_PLAN_ENTITLEMENTS = {
  trial: { max_bikes: 10, max_admin_users: 2 },
  small: { max_bikes: 20, max_admin_users: 3 },
  medium: { max_bikes: 60, max_admin_users: 5 },
  large: { max_bikes: 100, max_admin_users: 10 },
  enterprise: { max_bikes: 9999, max_admin_users: 50 },
};

router.get('/plans', (req, res) => {
  res.json({
    plans: [
      {
        key: 'trial',
        name: '1-month free trial',
        price_monthly: 0,
        price_per_bike: 0,
        bike_limit: 10,
        is_trial: true,
        features: ['Fleet dashboard', 'Bike and agreement tracking', 'Basic collections visibility', 'Free monthly basic service per bike', 'Up to 2 admin users']
      },
      {
        key: 'small',
        name: 'Small fleet',
        price_monthly: null,
        price_per_bike: 750,
        bike_limit: 20,
        features: ['Everything in trial', 'Free monthly basic service per bike', 'Bulk imports', 'Payment tracking', '3 admin users', 'Email support']
      },
      {
        key: 'medium',
        name: 'Medium fleet',
        price_monthly: null,
        price_per_bike: 750,
        bike_limit: 60,
        features: ['Everything in Small', 'Free monthly basic service per bike', 'Advanced filters', 'Bulk actions', 'Performance reporting', '5 admin users']
      },
      {
        key: 'large',
        name: 'Large fleet',
        price_monthly: null,
        price_per_bike: 750,
        bike_limit: 100,
        features: ['Everything in Medium', 'Free monthly basic service per bike', 'Priority onboarding', 'Multi-branch operations', 'Audit visibility', '10 admin users']
      },
      {
        key: 'enterprise',
        name: 'Enterprise+',
        price_monthly: null,
        price_per_bike: 750,
        bike_limit: null,
        features: ['100+ bikes', 'Free monthly basic service per bike', 'Custom onboarding', 'API and webhook options', 'Dedicated success support']
      }
    ]
  });
});

router.post('/leads', async (req, res) => {
  try {
    const company_name = String(req.body.company_name || '').trim();
    const contact_name = String(req.body.contact_name || '').trim();
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const city = String(req.body.city || '').trim();
    const fleet_size = Number(req.body.fleet_size || 0) || null;
    const plan_interest = String(req.body.plan_interest || 'trial').trim().toLowerCase();
    const wants_demo = req.body.wants_demo === undefined ? 1 : (req.body.wants_demo ? 1 : 0);
    const notes = sanitizeNotes(req.body.notes);
    const source = String(req.body.source || 'fleet_owner_pilot_page').trim().slice(0, 120) || 'fleet_owner_pilot_page';

    if (!company_name || !contact_name || !email) {
      return res.status(400).json({ error: 'Company name, contact name, and email are required' });
    }
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (fleet_size !== null && (!Number.isFinite(fleet_size) || fleet_size < 1 || fleet_size > 100000)) {
      return res.status(400).json({ error: 'Fleet size must be a number between 1 and 100000' });
    }
    if (!PLAN_OPTIONS.includes(plan_interest)) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    const duplicate = db.prepare(`SELECT id, status, created_at FROM fleet_owner_pilot_leads
      WHERE email = ? AND company_name = ? AND created_at >= datetime('now', '-30 days')
      ORDER BY id DESC LIMIT 1`).get(email, company_name);
    if (duplicate) {
      return res.status(409).json({ error: 'A pilot request for this company was already submitted recently' });
    }

    const info = db.prepare(`INSERT INTO fleet_owner_pilot_leads
      (company_name, contact_name, email, phone, city, fleet_size, plan_interest, wants_demo, notes, status, source)
      VALUES (?,?,?,?,?,?,?,?,?, 'new', ?)`)
      .run(company_name, contact_name, email, phone || null, city || null, fleet_size, plan_interest, wants_demo, notes || null, source);

    const lead = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(info.lastInsertRowid);

    const inbox = readEnv('PILOT_LEADS_EMAIL', readEnv('EMAIL_REPLY_TO', readEnv('EMAIL_FROM', '')));
    if (inbox) {
      const subject = `New fleet-owner pilot lead: ${company_name}`;
      const body = [
        `A new fleet-owner pilot request was submitted on the OnFleet website.`,
        '',
        `Company: ${company_name}`,
        `Contact: ${contact_name}`,
        `Email: ${email}`,
        `Phone: ${phone || '—'}`,
        `City: ${city || '—'}`,
        `Fleet size: ${fleet_size || '—'}`,
        `Plan interest: ${plan_interest}`,
        `Demo requested: ${wants_demo ? 'Yes' : 'No'}`,
        `Notes: ${notes || '—'}`,
        `Source: ${source}`
      ].join('\n');
      await sendEmail(inbox, subject, body);
    }

    // Confirmation email to the lead
    if (email) {
      const confirmSubject = 'Your OnFleet Fleet demo request';
      const confirmBody = [
        `Hi ${contact_name},`,
        '',
        `Thanks for getting in touch. We've received your demo request for OnFleet Fleet.`,
        '',
        `We'll give you a call within one business day to walk you through the platform.`,
        '',
        `If you'd like to chat in the meantime, WhatsApp us on 081 539 5612 — that's usually the quickest way to reach us.`,
        '',
        `We also do in-person demos at our Kya Sand workshop in Johannesburg. You're welcome to come in — just let us know when suits you.`,
        '',
        `The OnFleet Africa team`,
        `Kya Sand, Johannesburg`,
      ].join('\n');
      await sendEmail(email, confirmSubject, confirmBody).catch(() => {});
    }

    res.status(201).json({
      ok: true,
      lead: {
        id: lead.id,
        status: lead.status,
        created_at: lead.created_at,
        company_name: lead.company_name,
        plan_interest: lead.plan_interest
      }
    });
  } catch (error) {
    console.error('[pilot.leads.create]', error.message);
    res.status(500).json({ error: 'Could not submit pilot request' });
  }
});

router.get('/leads', authRequired, adminOnly, (req, res) => {
  const status = String(req.query.status || '').trim();
  const search = String(req.query.search || '').trim().toLowerCase();
  let rows = status && LEAD_STATUSES.includes(status)
    ? leadRowSelect('WHERE status = ?', [status])
    : leadRowSelect();

  if (search) {
    rows = rows.filter((row) => [
      row.company_name,
      row.contact_name,
      row.email,
      row.phone,
      row.city,
      row.plan_interest,
      row.notes,
      row.source,
      row.status,
      row.id
    ].some((value) => String(value || '').toLowerCase().includes(search)));
  }

  const stats = {
    total: db.prepare('SELECT COUNT(*) c FROM fleet_owner_pilot_leads').get().c,
    new: db.prepare(`SELECT COUNT(*) c FROM fleet_owner_pilot_leads WHERE status = 'new'`).get().c,
    demos: db.prepare(`SELECT COUNT(*) c FROM fleet_owner_pilot_leads WHERE status = 'demo_scheduled'`).get().c,
    trials: db.prepare(`SELECT COUNT(*) c FROM fleet_owner_pilot_leads WHERE status = 'trial_started'`).get().c,
    converted: db.prepare(`SELECT COUNT(*) c FROM fleet_owner_pilot_leads WHERE status = 'converted'`).get().c
  };

  res.json({ leads: rows, stats, statuses: LEAD_STATUSES });
});

router.get('/leads/:id', authRequired, adminOnly, (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });
  const lead = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const org = lead.converted_org_id
    ? db.prepare('SELECT id, name, slug, status, plan_key, created_at FROM organizations WHERE id = ?').get(lead.converted_org_id)
    : null;
  res.json({ lead, organization: org });
});

router.patch('/leads/:id', authRequired, adminOnly, (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });

  const existing = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  if (!existing) return res.status(404).json({ error: 'Lead not found' });

  const nextStatus = String(req.body.status || existing.status).trim();
  if (!LEAD_STATUSES.includes(nextStatus)) {
    return res.status(400).json({ error: 'Invalid lead status' });
  }

  const notes = req.body.notes === undefined ? existing.notes : sanitizeNotes(req.body.notes);
  const internal_notes = req.body.internal_notes === undefined ? existing.internal_notes : sanitizeNotes(req.body.internal_notes);

  db.prepare(`UPDATE fleet_owner_pilot_leads
    SET status = ?, notes = ?, internal_notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(nextStatus, notes || null, internal_notes || null, leadId);

  logAudit(req.user.id, 'pilot_lead.update', 'fleet_owner_pilot_leads', leadId, {
    from_status: existing.status,
    to_status: nextStatus
  }, req.ip);

  const lead = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  res.json({ ok: true, lead });
});

router.post('/leads/:id/contact', authRequired, adminOnly, async (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });

  const lead = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const message = String(req.body.message || '').trim().slice(0, 4000);
  const sendEmailToLead = req.body.send_email !== false;

  db.prepare(`UPDATE fleet_owner_pilot_leads
    SET status = 'contacted', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'new'`).run(leadId);

  logAudit(req.user.id, 'pilot_lead.contacted', 'fleet_owner_pilot_leads', leadId, { message: message.slice(0, 200) }, req.ip);

  if (sendEmailToLead && lead.email && message) {
    const body = [
      `Hi ${lead.contact_name},`,
      '',
      message,
      '',
      'The OnFleet Africa team',
      'Kya Sand, Johannesburg',
      'WhatsApp: 081 539 5612',
    ].join('\n');
    await sendEmail(lead.email, `OnFleet Fleet — following up on your request`, body).catch(() => {});
  }

  const updated = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  res.json({ ok: true, lead: updated });
});

router.post('/leads/:id/schedule-demo', authRequired, adminOnly, async (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });

  const lead = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const demo_at = String(req.body.demo_at || '').trim();
  if (!demo_at) return res.status(400).json({ error: 'demo_at (ISO date/time) is required' });

  const location = String(req.body.location || 'Kya Sand, Johannesburg').trim().slice(0, 300);
  const notes = String(req.body.notes || '').trim().slice(0, 2000);

  db.prepare(`UPDATE fleet_owner_pilot_leads
    SET status = 'demo_scheduled', demo_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(demo_at, leadId);

  logAudit(req.user.id, 'pilot_lead.demo_scheduled', 'fleet_owner_pilot_leads', leadId, { demo_at, location }, req.ip);

  if (lead.email) {
    const humanDate = new Date(demo_at).toLocaleString('en-ZA', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Johannesburg' }).replace(/,([^,]*)$/, ' at$1');
    const body = [
      `Hi ${lead.contact_name},`,
      '',
      `Your OnFleet Fleet demo is confirmed.`,
      '',
      `When: ${humanDate} (SA time)`,
      `Where: ${location}`,
      notes ? `Notes: ${notes}` : null,
      '',
      `If you need to reschedule, WhatsApp us on 081 539 5612 — that's the quickest way to reach us.`,
      '',
      `See you there.`,
      '',
      'The OnFleet Africa team',
      'Kya Sand, Johannesburg',
    ].filter((l) => l !== null).join('\n');
    await sendEmail(lead.email, `OnFleet demo confirmed — ${humanDate}`, body).catch(() => {});
  }

  const updated = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  res.json({ ok: true, lead: updated });
});

router.post('/leads/:id/convert', authRequired, adminOnly, async (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });

  const lead = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.converted_org_id) return res.status(409).json({ error: 'Lead already converted' });

  const plan_key = String(req.body.plan_key || lead.plan_interest || 'trial').trim().toLowerCase();
  if (!PLAN_OPTIONS.includes(plan_key)) return res.status(400).json({ error: 'Invalid plan' });

  const email = normalizeEmail(req.body.email || lead.email);
  const full_name = String(req.body.full_name || lead.contact_name || '').trim();
  const company_name = String(req.body.company_name || lead.company_name || '').trim();
  const phone = normalizePhone(req.body.phone || lead.phone || '');
  const city = String(req.body.city || lead.city || '').trim();
  const fleet_size = Number(req.body.fleet_size || lead.fleet_size || 0) || null;
  const welcome_message = String(req.body.welcome_message || '').trim().slice(0, 2000);

  if (!email || !full_name || !company_name) {
    return res.status(400).json({ error: 'email, full_name, and company_name are required' });
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
  if (existingUser) return res.status(409).json({ error: 'A user with this email already exists' });

  const entitlements = FLEET_PLAN_ENTITLEMENTS[plan_key] || FLEET_PLAN_ENTITLEMENTS.trial;
  const now = new Date();
  const trialEnds = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const tempPassword = crypto.randomBytes(8).toString('hex');
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const created = db.transaction(() => {
    const orgInfo = db.prepare(`INSERT INTO organizations
      (name, slug, contact_email, contact_phone, city, fleet_size, plan_key, status, trial_started_at, trial_ends_at, max_bikes, max_admin_users)
      VALUES (?,?,?,?,?,?,?,'trialing',?,?,?,?)`).run(
        company_name,
        slugifyCompanyName(company_name),
        email,
        phone || null,
        city || null,
        fleet_size,
        plan_key,
        now.toISOString(),
        trialEnds.toISOString(),
        entitlements.max_bikes,
        entitlements.max_admin_users
      );

    const userInfo = db.prepare(`INSERT INTO users
      (email, password_hash, full_name, phone, city, role, organization_id, status)
      VALUES (?,?,?,?,?,'fleet_owner_admin',?, 'active')`).run(
        email,
        passwordHash,
        full_name,
        phone || null,
        city || null,
        orgInfo.lastInsertRowid
      );

    db.prepare(`UPDATE fleet_owner_pilot_leads
      SET status = 'converted', converted_org_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(orgInfo.lastInsertRowid, leadId);

    return { organizationId: orgInfo.lastInsertRowid, userId: userInfo.lastInsertRowid };
  })();

  logAudit(req.user.id, 'pilot_lead.converted', 'fleet_owner_pilot_leads', leadId, {
    organization_id: created.organizationId,
    user_id: created.userId,
    plan_key,
  }, req.ip);

  const resetUrl = issueFleetResetToken(created.userId, req.ip, req.get('user-agent'));

  const intro = welcome_message ? `${welcome_message}\n\n` : '';
  const welcomeBody = [
    `Hi ${full_name},`,
    '',
    `${intro}Your OnFleet Fleet account is ready. Here are your login details:`,
    '',
    `Email: ${email}`,
    `Plan: ${plan_key} (14-day trial)`,
    '',
    `Set your password using the link below — it expires in 60 minutes:`,
    resetUrl,
    '',
    `Once you've logged in, head to the Fleet dashboard to add your first bike.`,
    '',
    `If you get stuck or have questions, WhatsApp us on 081 539 5612.`,
    '',
    'Welcome aboard.',
    '',
    'The OnFleet Africa team',
    'Kya Sand, Johannesburg',
  ].join('\n');

  await sendEmail(email, 'Your OnFleet Fleet account is ready', welcomeBody).catch(() => {});

  const updatedLead = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  const org = db.prepare('SELECT id, name, slug, status, plan_key, created_at FROM organizations WHERE id = ?').get(created.organizationId);

  res.status(201).json({ ok: true, lead: updatedLead, organization: org, reset_url: resetUrl });
});

module.exports = router;

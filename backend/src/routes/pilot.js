const express = require('express');
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

router.get('/plans', (req, res) => {
  res.json({
    plans: [
      {
        key: 'trial',
        name: '14-day trial',
        price_monthly: 0,
        bike_limit: 10,
        is_trial: true,
        features: ['Fleet dashboard', 'Bike and agreement tracking', 'Basic collections visibility', 'Up to 2 admin users']
      },
      {
        key: 'small',
        name: 'Small fleet',
        price_monthly: 1499,
        bike_limit: 20,
        features: ['Everything in trial', 'Bulk imports', 'Payment tracking', '3 admin users', 'Email support']
      },
      {
        key: 'medium',
        name: 'Medium fleet',
        price_monthly: 3999,
        bike_limit: 60,
        features: ['Everything in Small', 'Advanced filters', 'Bulk actions', 'Performance reporting', '5 admin users']
      },
      {
        key: 'large',
        name: 'Large fleet',
        price_monthly: 6999,
        bike_limit: 100,
        features: ['Everything in Medium', 'Priority onboarding', 'Multi-branch operations', 'Audit visibility', '10 admin users']
      },
      {
        key: 'enterprise',
        name: 'Enterprise+',
        price_monthly: null,
        bike_limit: null,
        features: ['100+ bikes', 'Custom onboarding', 'API and webhook options', 'Dedicated success support']
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
  db.prepare(`UPDATE fleet_owner_pilot_leads
    SET status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(nextStatus, notes || null, leadId);

  logAudit(req.user.id, 'pilot_lead.update', 'fleet_owner_pilot_leads', leadId, {
    from_status: existing.status,
    to_status: nextStatus
  }, req.ip);

  const lead = db.prepare('SELECT * FROM fleet_owner_pilot_leads WHERE id = ?').get(leadId);
  res.json({ ok: true, lead });
});

module.exports = router;

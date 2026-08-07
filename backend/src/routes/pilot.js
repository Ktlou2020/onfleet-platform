const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
// Postgres versions — see each *Pg module's header comment for why it's a
// separate file from the SQLite original (other, not-yet-migrated routes
// still depend on those).
const { logAudit } = require('../utils/helpersPg');
const { sendEmail } = require('../services/notifierPg');
const asyncRouter = require('../utils/asyncRouter');

const router = asyncRouter(express.Router());

const leadSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' }
});

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

async function leadRowSelect(whereClause = '', params = []) {
  const { rows } = await pgDb.query(`SELECT * FROM fleet_owner_pilot_leads ${whereClause} ORDER BY created_at DESC`, params);
  return rows;
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function passwordResetExpiryIso() {
  const ttlMinutes = Number(readEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60') || 60);
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
}

function buildResetUrl(token) {
  const base = readEnv('FRONTEND_URL', 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

async function issueFleetResetToken(userId, ip, ua) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  await pgDb.query(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await pgDb.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, user_agent) VALUES ($1,$2,$3,$4,$5)`,
    [userId, tokenHash, passwordResetExpiryIso(), ip || null, ua || null]);
  return buildResetUrl(rawToken);
}

async function slugifyCompanyName(value) {
  const base = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `fleet-${Date.now()}`;
  let slug = base;
  let counter = 2;
  while (true) {
    const { rows } = await pgDb.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
    if (!rows[0]) break;
    slug = `${base}-${counter++}`;
  }
  return slug;
}

const FLEET_PLAN_ENTITLEMENTS = {
  trial:  { max_bikes: 6,    max_admin_users: 2 },
  small:  { max_bikes: 6,    max_admin_users: 2 },
  medium: { max_bikes: 20,   max_admin_users: 3 },
  large:  { max_bikes: 35,   max_admin_users: 5 },
  empire: { max_bikes: 9999, max_admin_users: 20 },
};

router.get('/stats', async (req, res) => {
  const { rows: bikeRows } = await pgDb.query('SELECT COUNT(*) c FROM bikes');
  const bikes = Number(bikeRows[0].c);
  const { rows: collectedRows } = await pgDb.query(`SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount,0),amount)),0) c FROM payments WHERE status='success'`);
  const collected = Number(collectedRows[0].c);
  const { rows: cutRows } = await pgDb.query(`SELECT COUNT(*) c FROM tracking_commands WHERE command LIKE 'setdigout%1'`);
  const cutCount = Number(cutRows[0].c);
  const { rows: restoreRows } = await pgDb.query(`SELECT COUNT(*) c FROM tracking_commands WHERE command LIKE 'setdigout%0'`);
  const restoreCount = Number(restoreRows[0].c);
  const recoveredPct = cutCount > 0 ? Math.round((restoreCount / cutCount) * 100) : null;
  res.json({ bikes, collected, recovered_pct: recoveredPct });
});

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

router.post('/leads', leadSubmitLimiter, async (req, res) => {
  try {
    const company_name = String(req.body.company_name || '').trim();
    const contact_name = String(req.body.contact_name || '').trim();
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const city = String(req.body.city || '').trim();
    const fleet_size = Number(req.body.fleet_size || 0) || null;
    const plan_interest = String(req.body.plan_interest || 'trial').trim().toLowerCase();
    const wants_demo = req.body.wants_demo === undefined ? true : !!req.body.wants_demo;
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

    const { rows: duplicateRows } = await pgDb.query(`SELECT id, status, created_at FROM fleet_owner_pilot_leads
      WHERE email = $1 AND company_name = $2 AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY id DESC LIMIT 1`, [email, company_name]);
    if (duplicateRows[0]) {
      return res.status(409).json({ error: 'A pilot request for this company was already submitted recently' });
    }

    const { rows: insertRows } = await pgDb.query(`INSERT INTO fleet_owner_pilot_leads
      (company_name, contact_name, email, phone, city, fleet_size, plan_interest, wants_demo, notes, status, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, 'new', $10)
      RETURNING id`, [company_name, contact_name, email, phone || null, city || null, fleet_size, plan_interest, wants_demo, notes || null, source]);
    const leadId = insertRows[0].id;

    const { rows: leadRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
    const lead = leadRows[0];

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

router.get('/leads', authRequired, adminOnly, async (req, res) => {
  const status = String(req.query.status || '').trim();
  const search = String(req.query.search || '').trim().toLowerCase();
  let rows = status && LEAD_STATUSES.includes(status)
    ? await leadRowSelect('WHERE status = $1', [status])
    : await leadRowSelect();

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

  const [totalRows, newRows, demoRows, trialRows, convertedRows] = await Promise.all([
    pgDb.query('SELECT COUNT(*) c FROM fleet_owner_pilot_leads'),
    pgDb.query(`SELECT COUNT(*) c FROM fleet_owner_pilot_leads WHERE status = 'new'`),
    pgDb.query(`SELECT COUNT(*) c FROM fleet_owner_pilot_leads WHERE status = 'demo_scheduled'`),
    pgDb.query(`SELECT COUNT(*) c FROM fleet_owner_pilot_leads WHERE status = 'trial_started'`),
    pgDb.query(`SELECT COUNT(*) c FROM fleet_owner_pilot_leads WHERE status = 'converted'`)
  ]);
  const stats = {
    total: Number(totalRows.rows[0].c),
    new: Number(newRows.rows[0].c),
    demos: Number(demoRows.rows[0].c),
    trials: Number(trialRows.rows[0].c),
    converted: Number(convertedRows.rows[0].c)
  };

  res.json({ leads: rows, stats, statuses: LEAD_STATUSES });
});

router.get('/leads/:id', authRequired, adminOnly, async (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });
  const { rows: leadRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  const lead = leadRows[0];
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  let org = null;
  if (lead.converted_org_id) {
    const { rows: orgRows } = await pgDb.query('SELECT id, name, slug, status, plan_key, created_at FROM organizations WHERE id = $1', [lead.converted_org_id]);
    org = orgRows[0] || null;
  }
  res.json({ lead, organization: org });
});

router.patch('/leads/:id', authRequired, adminOnly, async (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });

  const { rows: existingRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Lead not found' });

  const nextStatus = String(req.body.status || existing.status).trim();
  if (!LEAD_STATUSES.includes(nextStatus)) {
    return res.status(400).json({ error: 'Invalid lead status' });
  }

  const notes = req.body.notes === undefined ? existing.notes : sanitizeNotes(req.body.notes);
  const internal_notes = req.body.internal_notes === undefined ? existing.internal_notes : sanitizeNotes(req.body.internal_notes);

  await pgDb.query(`UPDATE fleet_owner_pilot_leads
    SET status = $1, notes = $2, internal_notes = $3, updated_at = CURRENT_TIMESTAMP
    WHERE id = $4`, [nextStatus, notes || null, internal_notes || null, leadId]);

  await logAudit(req.user.id, 'pilot_lead.update', 'fleet_owner_pilot_leads', leadId, {
    from_status: existing.status,
    to_status: nextStatus
  }, req.ip);

  const { rows: leadRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  res.json({ ok: true, lead: leadRows[0] });
});

router.post('/leads/:id/contact', authRequired, adminOnly, async (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });

  const { rows: leadRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  const lead = leadRows[0];
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const message = String(req.body.message || '').trim().slice(0, 4000);
  const sendEmailToLead = req.body.send_email !== false;

  await pgDb.query(`UPDATE fleet_owner_pilot_leads
    SET status = 'contacted', updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND status = 'new'`, [leadId]);

  await logAudit(req.user.id, 'pilot_lead.contacted', 'fleet_owner_pilot_leads', leadId, { message: message.slice(0, 200) }, req.ip);

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

  const { rows: updatedRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  res.json({ ok: true, lead: updatedRows[0] });
});

router.post('/leads/:id/schedule-demo', authRequired, adminOnly, async (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });

  const { rows: leadRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  const lead = leadRows[0];
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const demo_at = String(req.body.demo_at || '').trim();
  if (!demo_at) return res.status(400).json({ error: 'demo_at (ISO date/time) is required' });

  const location = String(req.body.location || 'Kya Sand, Johannesburg').trim().slice(0, 300);
  const notes = String(req.body.notes || '').trim().slice(0, 2000);

  await pgDb.query(`UPDATE fleet_owner_pilot_leads
    SET status = 'demo_scheduled', demo_at = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2`, [demo_at, leadId]);

  await logAudit(req.user.id, 'pilot_lead.demo_scheduled', 'fleet_owner_pilot_leads', leadId, { demo_at, location }, req.ip);

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

  const { rows: updatedRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  res.json({ ok: true, lead: updatedRows[0] });
});

router.post('/leads/:id/convert', authRequired, adminOnly, async (req, res) => {
  const leadId = Number(req.params.id);
  if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Invalid lead id' });

  const { rows: leadRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  const lead = leadRows[0];
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

  const { rows: existingUserRows } = await pgDb.query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (existingUserRows[0]) return res.status(409).json({ error: 'A user with this email already exists' });

  const entitlements = FLEET_PLAN_ENTITLEMENTS[plan_key] || FLEET_PLAN_ENTITLEMENTS.trial;
  const now = new Date();
  const trialEnds = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const tempPassword = crypto.randomBytes(8).toString('hex');
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const slug = await slugifyCompanyName(company_name);

  const created = await pgDb.withTransaction(async (client) => {
    const { rows: orgRows } = await client.query(`INSERT INTO organizations
      (name, slug, contact_email, contact_phone, city, fleet_size, plan_key, status, trial_started_at, trial_ends_at, max_bikes, max_admin_users)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'trialing',$8,$9,$10,$11)
      RETURNING id`, [
        company_name,
        slug,
        email,
        phone || null,
        city || null,
        fleet_size,
        plan_key,
        now.toISOString(),
        trialEnds.toISOString(),
        entitlements.max_bikes,
        entitlements.max_admin_users
      ]);
    const organizationId = orgRows[0].id;

    const { rows: userRows } = await client.query(`INSERT INTO users
      (email, password_hash, full_name, phone, city, role, organization_id, status)
      VALUES ($1,$2,$3,$4,$5,'fleet_owner_admin',$6, 'active')
      RETURNING id`, [
        email,
        passwordHash,
        full_name,
        phone || null,
        city || null,
        organizationId
      ]);
    const userId = userRows[0].id;

    await client.query(`UPDATE fleet_owner_pilot_leads
      SET status = 'converted', converted_org_id = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`, [organizationId, leadId]);

    return { organizationId, userId };
  });

  await logAudit(req.user.id, 'pilot_lead.converted', 'fleet_owner_pilot_leads', leadId, {
    organization_id: created.organizationId,
    user_id: created.userId,
    plan_key,
  }, req.ip);

  const resetUrl = await issueFleetResetToken(created.userId, req.ip, req.get('user-agent'));

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

  const { rows: updatedLeadRows } = await pgDb.query('SELECT * FROM fleet_owner_pilot_leads WHERE id = $1', [leadId]);
  const { rows: orgRows } = await pgDb.query('SELECT id, name, slug, status, plan_key, created_at FROM organizations WHERE id = $1', [created.organizationId]);

  res.status(201).json({ ok: true, lead: updatedLeadRows[0], organization: orgRows[0], reset_url: resetUrl });
});

module.exports = router;

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const router = express.Router();

const WORKSHOP_ROLES = ['technician', 'admin', 'superadmin'];

function workshopOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (!WORKSHOP_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Workshop access required' });
  next();
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getJobCard(id) {
  const card = db.prepare(`
    SELECT jc.*,
      b.registration AS bike_registration, b.make AS bike_make, b.model AS bike_model,
      b.vin AS bike_vin, b.year AS bike_year, b.color AS bike_color,
      b.status AS bike_status, b.odometer_km AS bike_odometer_km,
      b.next_service_date AS bike_next_service_date, b.next_service_km AS bike_next_service_km,
      b.fleet AS bike_fleet, b.image_url AS bike_image_url,
      o.name AS bike_org_name, o.id AS bike_org_id,
      u.full_name AS technician_name,
      c.full_name AS created_by_name
    FROM job_cards jc
    LEFT JOIN bikes b ON b.id = jc.bike_id
    LEFT JOIN organizations o ON o.id = b.organization_id
    LEFT JOIN users u ON u.id = jc.technician_id
    LEFT JOIN users c ON c.id = jc.created_by
    WHERE jc.id = ?
  `).get(id);
  if (!card) return null;

  const items = db.prepare(`SELECT * FROM job_card_items WHERE job_card_id = ? ORDER BY id ASC`).all(id);
  const total_cost = items.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);
  return { ...card, items, total_cost: +total_cost.toFixed(2) };
}

// Dashboard
router.get('/dashboard', authRequired, workshopOnly, (req, res) => {
  try {
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
        SUM(CASE WHEN status = 'completed' AND date(completed_at) = date('now') THEN 1 ELSE 0 END) AS completed_today
      FROM job_cards
    `).get();

    const revenueRow = db.prepare(`
      SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) AS total_revenue,
        COALESCE(SUM(CASE WHEN date(jc.completed_at) = date('now') THEN i.quantity * i.unit_cost ELSE 0 END), 0) AS revenue_today
      FROM job_card_items i
      JOIN job_cards jc ON jc.id = i.job_card_id
      WHERE jc.status = 'completed'
    `).get();

    const activeJobs = db.prepare(`
      SELECT jc.*,
        COALESCE(b.registration, jc.registration) AS display_registration,
        COALESCE(b.make, jc.make) AS display_make,
        COALESCE(b.model, jc.model) AS display_model,
        u.full_name AS technician_name,
        COALESCE((SELECT SUM(quantity * unit_cost) FROM job_card_items WHERE job_card_id = jc.id), 0) AS total_cost
      FROM job_cards jc
      LEFT JOIN bikes b ON b.id = jc.bike_id
      LEFT JOIN users u ON u.id = jc.technician_id
      WHERE jc.status IN ('open', 'in_progress')
      ORDER BY
        CASE jc.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        jc.created_at DESC
      LIMIT 10
    `).all();

    const myJobs = db.prepare(`
      SELECT jc.*,
        COALESCE(b.registration, jc.registration) AS display_registration,
        COALESCE(b.make, jc.make) AS display_make,
        COALESCE(b.model, jc.model) AS display_model,
        COALESCE((SELECT SUM(quantity * unit_cost) FROM job_card_items WHERE job_card_id = jc.id), 0) AS total_cost
      FROM job_cards jc
      LEFT JOIN bikes b ON b.id = jc.bike_id
      WHERE jc.technician_id = ? AND jc.status IN ('open', 'in_progress')
      ORDER BY
        CASE jc.status WHEN 'in_progress' THEN 1 ELSE 2 END,
        CASE jc.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END
      LIMIT 8
    `).all(req.user.id);

    res.json({
      stats: {
        ...stats,
        total_revenue: +Number(revenueRow?.total_revenue || 0).toFixed(2),
        revenue_today: +Number(revenueRow?.revenue_today || 0).toFixed(2)
      },
      active_jobs: activeJobs,
      my_jobs: myJobs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List job cards
router.get('/job-cards', authRequired, workshopOnly, (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim();
    const where = [];
    const params = [];

    if (status) { where.push(`jc.status = ?`); params.push(status); }
    if (search) {
      const like = `%${search}%`;
      where.push(`(COALESCE(b.registration, jc.registration) LIKE ? OR COALESCE(b.vin, jc.vin) LIKE ? OR COALESCE(b.make, jc.make) LIKE ? OR COALESCE(b.model, jc.model) LIKE ? OR jc.description LIKE ? OR u.full_name LIKE ?)`);
      params.push(like, like, like, like, like, like);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const jobs = db.prepare(`
      SELECT jc.*,
        COALESCE(b.registration, jc.registration) AS display_registration,
        COALESCE(b.make, jc.make) AS display_make,
        COALESCE(b.model, jc.model) AS display_model,
        COALESCE(b.vin, jc.vin) AS display_vin,
        b.image_url AS bike_image_url,
        o.name AS fleet_org_name,
        u.full_name AS technician_name,
        COALESCE((SELECT SUM(quantity * unit_cost) FROM job_card_items WHERE job_card_id = jc.id), 0) AS total_cost
      FROM job_cards jc
      LEFT JOIN bikes b ON b.id = jc.bike_id
      LEFT JOIN organizations o ON o.id = COALESCE(b.organization_id, jc.fleet_org_id)
      LEFT JOIN users u ON u.id = jc.technician_id
      ${whereClause}
      ORDER BY
        CASE jc.status WHEN 'in_progress' THEN 1 WHEN 'open' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
        CASE jc.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        jc.created_at DESC
      LIMIT 300
    `).all(...params);

    res.json({ job_cards: jobs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create job card
router.post('/job-cards', authRequired, workshopOnly, (req, res) => {
  try {
    const { bike_id, vin, registration, make, model, year, color, engine_cc, fleet_owner_name, fleet_org_id, job_type, description, priority, technician_id } = req.body;

    if (!bike_id && (!vin || !make || !model)) {
      return res.status(400).json({ error: 'Link an existing bike or provide VIN, make, and model' });
    }
    if (bike_id && !db.prepare('SELECT id FROM bikes WHERE id = ?').get(toInt(bike_id))) {
      return res.status(404).json({ error: 'Bike not found' });
    }

    const result = db.prepare(`
      INSERT INTO job_cards (bike_id, vin, registration, make, model, year, color, engine_cc, fleet_owner_name, fleet_org_id, job_type, description, priority, technician_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bike_id ? toInt(bike_id) : null,
      vin || null, registration || null, make || null, model || null,
      year ? Number(year) : null, color || null,
      engine_cc ? Number(engine_cc) : null,
      fleet_owner_name || null,
      fleet_org_id ? toInt(fleet_org_id) : null,
      job_type || 'service',
      description || null,
      priority || 'normal',
      technician_id ? toInt(technician_id) : req.user.id,
      req.user.id
    );

    res.json({ ok: true, id: result.lastInsertRowid, job_card: getJobCard(result.lastInsertRowid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get job card detail
router.get('/job-cards/:id', authRequired, workshopOnly, (req, res) => {
  try {
    const card = getJobCard(toInt(req.params.id));
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    res.json({ job_card: card });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update job card
router.put('/job-cards/:id', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot edit a completed job' });

    const allowed = ['job_type', 'description', 'priority', 'technician_id'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) { sets.push(`${key} = ?`); vals.push(req.body[key] || null); }
    }
    if (sets.length) { vals.push(id); db.prepare(`UPDATE job_cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }

    res.json({ ok: true, job_card: getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start job
router.post('/job-cards/:id/start', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const card = db.prepare('SELECT status FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status !== 'open') return res.status(400).json({ error: 'Only open jobs can be started' });

    db.prepare(`UPDATE job_cards SET status = 'in_progress', started_at = CURRENT_TIMESTAMP, technician_id = COALESCE(technician_id, ?) WHERE id = ?`).run(req.user.id, id);
    res.json({ ok: true, job_card: getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Complete job
router.post('/job-cards/:id/complete', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (!['open', 'in_progress'].includes(card.status)) return res.status(400).json({ error: 'Job is already completed or cancelled' });

    const { completion_notes, odometer_km, next_service_date, next_service_km, bike_status_after } = req.body;
    const parsedOdometer = odometer_km ? Number(odometer_km) : null;
    const parsedNextKm = next_service_km ? Number(next_service_km) : null;

    db.prepare(`
      UPDATE job_cards SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        completion_notes = ?, odometer_km = ?, next_service_date = ?, next_service_km = ?, bike_status_after = ?
      WHERE id = ?
    `).run(completion_notes || null, parsedOdometer, next_service_date || null, parsedNextKm, bike_status_after || null, id);

    // Log to service_records and update bike if linked
    if (card.bike_id) {
      const items = db.prepare('SELECT * FROM job_card_items WHERE job_card_id = ?').all(id);
      const totalCost = items.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
      const descParts = [card.description, ...items.slice(0, 5).map((i) => `${i.description} (${i.quantity}x)`)]
        .filter(Boolean).join('; ').slice(0, 500);

      db.prepare(`
        INSERT INTO service_records (bike_id, service_date, service_type, description, cost, odometer_km, next_service_km, next_service_date, performed_by, job_card_id)
        VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(card.bike_id, card.job_type, descParts || null, totalCost || null, parsedOdometer, parsedNextKm, next_service_date || null, req.user.full_name || req.user.email, id);

      const bikeSets = [];
      const bikeVals = [];
      if (parsedOdometer) { bikeSets.push('odometer_km = ?'); bikeVals.push(parsedOdometer); }
      if (next_service_date) { bikeSets.push('next_service_date = ?'); bikeVals.push(next_service_date); }
      if (parsedNextKm) { bikeSets.push('next_service_km = ?'); bikeVals.push(parsedNextKm); }
      if (bike_status_after) { bikeSets.push('status = ?'); bikeVals.push(bike_status_after); }
      if (bikeSets.length) {
        bikeVals.push(card.bike_id);
        db.prepare(`UPDATE bikes SET ${bikeSets.join(', ')} WHERE id = ?`).run(...bikeVals);
      }
    }

    res.json({ ok: true, job_card: getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel job
router.delete('/job-cards/:id', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const card = db.prepare('SELECT status FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot cancel a completed job' });
    db.prepare(`UPDATE job_cards SET status = 'cancelled' WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add line item
router.post('/job-cards/:id/items', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const card = db.prepare('SELECT status FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot add items to a completed job' });
    if (!req.body.description) return res.status(400).json({ error: 'Description is required' });

    db.prepare(`INSERT INTO job_card_items (job_card_id, item_type, description, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)`).run(
      id, req.body.item_type || 'labor', req.body.description,
      Number(req.body.quantity) || 1, Number(req.body.unit_cost) || 0
    );

    res.json({ ok: true, job_card: getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit line item
router.put('/job-cards/:id/items/:itemId', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const itemId = toInt(req.params.itemId);
    const card = db.prepare('SELECT status FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot edit items on a completed job' });

    db.prepare(`UPDATE job_card_items SET item_type = ?, description = ?, quantity = ?, unit_cost = ? WHERE id = ? AND job_card_id = ?`).run(
      req.body.item_type || 'labor', req.body.description || '',
      Number(req.body.quantity) || 1, Number(req.body.unit_cost) || 0,
      itemId, id
    );

    res.json({ ok: true, job_card: getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete line item
router.delete('/job-cards/:id/items/:itemId', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const card = db.prepare('SELECT status FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot delete items on a completed job' });
    db.prepare('DELETE FROM job_card_items WHERE id = ? AND job_card_id = ?').run(toInt(req.params.itemId), id);
    res.json({ ok: true, job_card: getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search existing bikes
router.get('/bikes/search', authRequired, workshopOnly, (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ bikes: [] });
    const like = `%${q}%`;
    const bikes = db.prepare(`
      SELECT b.id, b.vin, b.registration, b.make, b.model, b.year, b.color, b.engine_cc,
        b.status, b.fleet, b.organization_id, o.name AS org_name,
        b.next_service_date, b.next_service_km, b.odometer_km, b.image_url
      FROM bikes b
      LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE b.registration LIKE ? OR b.vin LIKE ? OR b.make LIKE ? OR b.model LIKE ?
      ORDER BY b.registration, b.make
      LIMIT 10
    `).all(like, like, like, like);
    res.json({ bikes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new bike (bikes brought in that are not yet on the platform)
router.post('/bikes', authRequired, workshopOnly, (req, res) => {
  try {
    const { vin, registration, make, model, year, color, engine_cc, fleet_owner_name } = req.body;
    if (!vin || !make || !model) return res.status(400).json({ error: 'VIN, make, and model are required' });

    const existing = db.prepare('SELECT id, registration FROM bikes WHERE vin = ?').get(vin);
    if (existing) return res.status(409).json({ error: `A bike with VIN ${vin} already exists`, existing_id: existing.id });

    const result = db.prepare(`
      INSERT INTO bikes (vin, registration, make, model, year, color, engine_cc, fleet, rental_weekly, total_weeks, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'not_available', ?)
    `).run(
      vin, registration || null, make, model,
      year ? Number(year) : null, color || null,
      engine_cc ? Number(engine_cc) : null,
      fleet_owner_name || null,
      fleet_owner_name ? `Registered via workshop — fleet owner: ${fleet_owner_name}` : 'Registered via workshop'
    );

    res.json({ ok: true, bike: db.prepare('SELECT * FROM bikes WHERE id = ?').get(result.lastInsertRowid) });
  } catch (error) {
    if (error.message?.includes('UNIQUE')) return res.status(409).json({ error: 'A bike with this VIN or registration already exists' });
    res.status(500).json({ error: error.message });
  }
});

// List technicians (for assignment dropdown)
router.get('/technicians', authRequired, workshopOnly, (req, res) => {
  try {
    const technicians = db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE role IN ('technician', 'admin', 'superadmin') AND status = 'active' AND deleted_at IS NULL
      ORDER BY full_name
    `).all();
    res.json({ technicians });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bike service history for job card context
router.get('/job-cards/:id/bike-history', authRequired, workshopOnly, (req, res) => {
  try {
    const card = db.prepare('SELECT bike_id FROM job_cards WHERE id = ?').get(toInt(req.params.id));
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (!card.bike_id) return res.json({ records: [] });
    const records = db.prepare(`
      SELECT sr.id, sr.service_date, sr.service_type, sr.description, sr.cost,
        sr.odometer_km, sr.next_service_km, sr.next_service_date, sr.performed_by, sr.job_card_id
      FROM service_records sr
      WHERE sr.bike_id = ?
      ORDER BY sr.service_date DESC, sr.id DESC
      LIMIT 20
    `).all(card.bike_id);
    res.json({ records });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Parts/labour suggestions from historical usage
router.get('/parts-suggestions', authRequired, workshopOnly, (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const suggestions = db.prepare(`
      SELECT description, item_type,
        ROUND(AVG(unit_cost), 2) AS avg_unit_cost,
        COUNT(*) AS usage_count
      FROM job_card_items
      ${q ? 'WHERE LOWER(description) LIKE ?' : ''}
      GROUP BY LOWER(TRIM(description)), item_type
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `).all(...(q ? [`%${q.toLowerCase()}%`] : []));
    res.json({ suggestions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upcoming service schedule — bikes due within N days
router.get('/upcoming-services', authRequired, workshopOnly, (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const bikes = db.prepare(`
      SELECT b.id, b.registration, b.vin, b.make, b.model, b.next_service_date, b.next_service_km,
        b.odometer_km, b.status, o.name AS org_name,
        CASE WHEN b.next_service_date < date('now') THEN 'overdue' ELSE 'upcoming' END AS urgency,
        (SELECT id FROM job_cards WHERE bike_id = b.id AND status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1) AS active_job_id
      FROM bikes b
      LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE b.next_service_date IS NOT NULL
        AND b.next_service_date <= date('now', '+' || ? || ' days')
        AND b.status NOT IN ('sold','paid_off','written_off')
      ORDER BY b.next_service_date ASC
      LIMIT 30
    `).all(days);
    res.json({ bikes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Job card templates — list
router.get('/templates', authRequired, workshopOnly, (req, res) => {
  try {
    const templates = db.prepare('SELECT * FROM job_card_templates ORDER BY name ASC').all();
    res.json({ templates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Job card templates — create from current job items or manual
router.post('/templates', authRequired, workshopOnly, (req, res) => {
  try {
    const { name, job_type, description, items } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Template name is required' });
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Items must be an array' });
    const result = db.prepare(`
      INSERT INTO job_card_templates (name, job_type, description, items, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(name.trim(), job_type || 'service', description || null, JSON.stringify(items), req.user.id);
    res.json({ ok: true, template: db.prepare('SELECT * FROM job_card_templates WHERE id = ?').get(result.lastInsertRowid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Job card templates — delete
router.delete('/templates/:id', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!db.prepare('SELECT id FROM job_card_templates WHERE id = ?').get(id)) return res.status(404).json({ error: 'Template not found' });
    db.prepare('DELETE FROM job_card_templates WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apply template to job card — adds template items to existing job
router.post('/job-cards/:id/apply-template/:templateId', authRequired, workshopOnly, (req, res) => {
  try {
    const id = toInt(req.params.id);
    const templateId = toInt(req.params.templateId);
    const card = db.prepare('SELECT status FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot modify a completed job' });
    const template = db.prepare('SELECT * FROM job_card_templates WHERE id = ?').get(templateId);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const items = JSON.parse(template.items || '[]');
    const insertItem = db.prepare(`INSERT INTO job_card_items (job_card_id, item_type, description, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)`);
    for (const item of items) {
      insertItem.run(id, item.item_type || 'labor', item.description, Number(item.quantity) || 1, Number(item.unit_cost) || 0);
    }
    res.json({ ok: true, job_card: getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Admin endpoints ---

// Admin stats endpoint — wider stats for the admin console overview
router.get('/admin/stats', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });

    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total_jobs,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_jobs,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_jobs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs
      FROM job_cards
    `).get();

    const revenueRow = db.prepare(`
      SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) AS total_revenue
      FROM job_card_items i
      JOIN job_cards jc ON jc.id = i.job_card_id
      WHERE jc.status = 'completed'
    `).get();

    const recentJobs = db.prepare(`
      SELECT jc.id, jc.status, jc.job_type, jc.priority, jc.created_at, jc.completed_at,
        COALESCE(b.registration, jc.registration) AS display_registration,
        COALESCE(b.make, jc.make) AS display_make,
        COALESCE(b.model, jc.model) AS display_model,
        u.full_name AS technician_name,
        COALESCE((SELECT SUM(quantity * unit_cost) FROM job_card_items WHERE job_card_id = jc.id), 0) AS total_cost
      FROM job_cards jc
      LEFT JOIN bikes b ON b.id = jc.bike_id
      LEFT JOIN users u ON u.id = jc.technician_id
      ORDER BY jc.created_at DESC
      LIMIT 10
    `).all();

    res.json({ stats: { ...stats, total_revenue: +Number(revenueRow?.total_revenue || 0).toFixed(2) }, recent_jobs: recentJobs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: full paginated job list
router.get('/admin/jobs', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim();
    const techId = String(req.query.technician_id || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = [];
    const params = [];
    if (status) { where.push('jc.status = ?'); params.push(status); }
    if (techId) { where.push('jc.technician_id = ?'); params.push(Number(techId)); }
    if (search) {
      const like = `%${search}%`;
      where.push(`(COALESCE(b.registration, jc.registration) LIKE ? OR COALESCE(b.vin, jc.vin) LIKE ? OR COALESCE(b.make, jc.make) LIKE ? OR jc.description LIKE ? OR u.full_name LIKE ?)`);
      params.push(like, like, like, like, like);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM job_cards jc LEFT JOIN bikes b ON b.id = jc.bike_id LEFT JOIN users u ON u.id = jc.technician_id ${whereClause}`).get(...params).count;
    const jobs = db.prepare(`
      SELECT jc.*,
        COALESCE(b.registration, jc.registration) AS display_registration,
        COALESCE(b.make, jc.make) AS display_make,
        COALESCE(b.model, jc.model) AS display_model,
        o.name AS fleet_org_name,
        u.full_name AS technician_name,
        COALESCE((SELECT SUM(quantity * unit_cost) FROM job_card_items WHERE job_card_id = jc.id), 0) AS total_cost
      FROM job_cards jc
      LEFT JOIN bikes b ON b.id = jc.bike_id
      LEFT JOIN organizations o ON o.id = COALESCE(b.organization_id, jc.fleet_org_id)
      LEFT JOIN users u ON u.id = jc.technician_id
      ${whereClause}
      ORDER BY
        CASE jc.status WHEN 'in_progress' THEN 1 WHEN 'open' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
        CASE jc.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
        jc.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({ jobs, total, limit, offset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: update any job (reassign, reprioritize, cancel)
router.put('/admin/jobs/:id', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    const sets = [];
    const vals = [];
    const editable = ['priority', 'technician_id', 'description'];
    for (const key of editable) {
      if (req.body[key] !== undefined) { sets.push(`${key} = ?`); vals.push(req.body[key] || null); }
    }
    if (req.body.status === 'cancelled' && !['completed', 'cancelled'].includes(card.status)) {
      sets.push('status = ?'); vals.push('cancelled');
    }
    if (sets.length) { vals.push(id); db.prepare(`UPDATE job_cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
    res.json({ ok: true, job_card: getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: hard-delete job card
router.delete('/admin/jobs/:id', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    if (!db.prepare('SELECT id FROM job_cards WHERE id = ?').get(id)) return res.status(404).json({ error: 'Job card not found' });
    db.prepare('DELETE FROM job_cards WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: per-technician performance
router.get('/admin/technician-stats', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const technicians = db.prepare(`
      SELECT u.id, u.full_name, u.email, u.role,
        COUNT(jc.id) AS total_jobs,
        SUM(CASE WHEN jc.status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
        SUM(CASE WHEN jc.status = 'in_progress' THEN 1 ELSE 0 END) AS active_jobs,
        SUM(CASE WHEN jc.status = 'open' THEN 1 ELSE 0 END) AS open_jobs,
        COALESCE(SUM(CASE WHEN jc.status = 'completed' THEN
          (SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM job_card_items WHERE job_card_id = jc.id)
          ELSE 0 END), 0) AS total_revenue,
        ROUND(AVG(CASE WHEN jc.started_at IS NOT NULL AND jc.completed_at IS NOT NULL
          THEN (julianday(jc.completed_at) - julianday(jc.started_at)) * 24 END), 1) AS avg_hours
      FROM users u
      LEFT JOIN job_cards jc ON jc.technician_id = u.id
      WHERE u.role IN ('technician', 'admin', 'superadmin') AND u.status = 'active' AND u.deleted_at IS NULL
      GROUP BY u.id
      ORDER BY completed_jobs DESC, total_revenue DESC
    `).all();
    res.json({ technicians });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: fleet health — bikes with overdue/upcoming service or in workshop
router.get('/admin/fleet-health', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const bikes = db.prepare(`
      SELECT b.id, b.registration, b.vin, b.make, b.model, b.year, b.status,
        b.odometer_km, b.next_service_date, b.next_service_km,
        o.name AS org_name,
        CASE
          WHEN b.next_service_date IS NOT NULL AND b.next_service_date < date('now') THEN 'overdue'
          WHEN b.next_service_date IS NOT NULL AND b.next_service_date <= date('now', '+30 days') THEN 'due_soon'
          WHEN b.next_service_km IS NOT NULL AND b.odometer_km IS NOT NULL AND b.odometer_km >= b.next_service_km THEN 'overdue'
          ELSE 'ok'
        END AS service_health,
        (SELECT id FROM job_cards WHERE bike_id = b.id AND status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1) AS active_job_id,
        (SELECT status FROM job_cards WHERE bike_id = b.id AND status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1) AS active_job_status,
        (SELECT service_date FROM service_records WHERE bike_id = b.id ORDER BY service_date DESC, id DESC LIMIT 1) AS last_service_date
      FROM bikes b
      LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE b.status NOT IN ('sold','paid_off','written_off')
      ORDER BY
        CASE
          WHEN b.next_service_date IS NOT NULL AND b.next_service_date < date('now') THEN 1
          WHEN b.next_service_km IS NOT NULL AND b.odometer_km IS NOT NULL AND b.odometer_km >= b.next_service_km THEN 1
          WHEN b.next_service_date IS NOT NULL AND b.next_service_date <= date('now', '+30 days') THEN 2
          WHEN (SELECT id FROM job_cards WHERE bike_id = b.id AND status NOT IN ('completed','cancelled') LIMIT 1) IS NOT NULL THEN 3
          ELSE 4
        END,
        b.next_service_date ASC NULLS LAST
      LIMIT 300
    `).all();
    res.json({ bikes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: revenue breakdown by month and by job type
router.get('/admin/revenue-by-month', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const months = db.prepare(`
      SELECT strftime('%Y-%m', jc.completed_at) AS month,
        COUNT(*) AS jobs_completed,
        COALESCE(SUM(i.quantity * i.unit_cost), 0) AS revenue
      FROM job_cards jc
      LEFT JOIN job_card_items i ON i.job_card_id = jc.id
      WHERE jc.status = 'completed' AND jc.completed_at IS NOT NULL
      GROUP BY strftime('%Y-%m', jc.completed_at)
      ORDER BY month DESC
      LIMIT 12
    `).all();
    const byType = db.prepare(`
      SELECT jc.job_type,
        COUNT(*) AS job_count,
        COALESCE(SUM(i.quantity * i.unit_cost), 0) AS revenue
      FROM job_cards jc
      LEFT JOIN job_card_items i ON i.job_card_id = jc.id
      WHERE jc.status = 'completed'
      GROUP BY jc.job_type
      ORDER BY revenue DESC
    `).all();
    const overdueJobs = db.prepare(`
      SELECT COUNT(*) AS count FROM job_cards
      WHERE status IN ('open','in_progress')
        AND created_at < datetime('now', '-2 days')
    `).get();
    res.json({ months: months.reverse(), by_type: byType, overdue_jobs: overdueJobs.count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: list workshop staff (technicians)
router.get('/admin/staff', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const staff = db.prepare(`
      SELECT u.id, u.full_name, u.email, u.phone, u.role, u.status, u.created_at,
        COUNT(jc.id) AS total_jobs,
        SUM(CASE WHEN jc.status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
        SUM(CASE WHEN jc.status IN ('open','in_progress') THEN 1 ELSE 0 END) AS active_jobs
      FROM users u
      LEFT JOIN job_cards jc ON jc.technician_id = u.id
      WHERE u.role = 'technician' AND u.deleted_at IS NULL
      GROUP BY u.id
      ORDER BY u.full_name
    `).all();
    res.json({ staff });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: create technician user
router.post('/admin/staff', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const { full_name, email, phone, password } = req.body;
    if (!full_name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare(`
      INSERT INTO users (full_name, email, phone, password_hash, role, status)
      VALUES (?, ?, ?, ?, 'technician', 'active')
    `).run(full_name.trim(), email.toLowerCase().trim(), phone || null, hash);
    const user = db.prepare('SELECT id, full_name, email, phone, role, status, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ok: true, user });
  } catch (error) {
    if (error.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: error.message });
  }
});

// Admin: update technician (status toggle)
router.put('/admin/staff/:id', authRequired, (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    const user = db.prepare('SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'technician') return res.status(400).json({ error: 'Can only manage technician accounts here' });
    const allowed = ['status', 'full_name', 'phone'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) { sets.push(`${key} = ?`); vals.push(req.body[key]); }
    }
    if (sets.length) { vals.push(id); db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
    res.json({ ok: true, user: db.prepare('SELECT id, full_name, email, phone, role, status FROM users WHERE id = ?').get(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

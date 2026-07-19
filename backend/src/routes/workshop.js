const express = require('express');
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

    res.json({
      stats: {
        ...stats,
        total_revenue: +Number(revenueRow?.total_revenue || 0).toFixed(2),
        revenue_today: +Number(revenueRow?.revenue_today || 0).toFixed(2)
      },
      active_jobs: activeJobs
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

module.exports = router;

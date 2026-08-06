const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pgDb = require('../pgDb');
const { authRequired } = require('../middleware/auth');
const { sendEmail } = require('../services/notifier');
const { sendNotification } = require('../services/notifierPg');
const UPLOAD_DIRS = require('../uploadPaths');
const asyncRouter = require('../utils/asyncRouter');
const router = asyncRouter(express.Router());

function photoUrl(filePath) {
  const rel = path.relative(UPLOAD_DIRS.base, filePath);
  return `/uploads/${rel.replace(/\\/g, '/')}`;
}

const photoStorage = multer.diskStorage({
  destination: UPLOAD_DIRS.jobPhotos,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `job-${req.params.id || 'x'}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

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

async function logAudit(actorId, action, entityId, metadata) {
  try {
    await pgDb.query(`INSERT INTO audit_logs (actor_id, action, entity, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)`,
      [actorId, action, 'job_card', entityId, JSON.stringify(metadata || {})]);
  } catch (e) {
    console.error('[workshop:audit]', e.message);
  }
}

async function getJobCard(id) {
  const { rows: cardRows } = await pgDb.query(`
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
    WHERE jc.id = $1
  `, [id]);
  const card = cardRows[0];
  if (!card) return null;

  const { rows: items } = await pgDb.query(`SELECT * FROM job_card_items WHERE job_card_id = $1 ORDER BY id ASC`, [id]);
  const total_cost = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_cost), 0);
  return { ...card, items, total_cost: +total_cost.toFixed(2) };
}

// Dashboard
router.get('/dashboard', authRequired, workshopOnly, async (req, res) => {
  try {
    const { rows: statsRows } = await pgDb.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
        SUM(CASE WHEN status = 'completed' AND completed_at::date = CURRENT_DATE THEN 1 ELSE 0 END) AS completed_today
      FROM job_cards
    `);
    const stats = statsRows[0];

    const { rows: revenueRows } = await pgDb.query(`
      SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) AS total_revenue,
        COALESCE(SUM(CASE WHEN jc.completed_at::date = CURRENT_DATE THEN i.quantity * i.unit_cost ELSE 0 END), 0) AS revenue_today
      FROM job_card_items i
      JOIN job_cards jc ON jc.id = i.job_card_id
      WHERE jc.status = 'completed'
    `);
    const revenueRow = revenueRows[0];

    const { rows: activeJobs } = await pgDb.query(`
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
    `);

    const { rows: myJobs } = await pgDb.query(`
      SELECT jc.*,
        COALESCE(b.registration, jc.registration) AS display_registration,
        COALESCE(b.make, jc.make) AS display_make,
        COALESCE(b.model, jc.model) AS display_model,
        COALESCE((SELECT SUM(quantity * unit_cost) FROM job_card_items WHERE job_card_id = jc.id), 0) AS total_cost
      FROM job_cards jc
      LEFT JOIN bikes b ON b.id = jc.bike_id
      WHERE jc.technician_id = $1 AND jc.status IN ('open', 'in_progress')
      ORDER BY
        CASE jc.status WHEN 'in_progress' THEN 1 ELSE 2 END,
        CASE jc.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END
      LIMIT 8
    `, [req.user.id]);

    res.json({
      stats: {
        total: Number(stats.total) || 0,
        open_count: Number(stats.open_count) || 0,
        in_progress_count: Number(stats.in_progress_count) || 0,
        completed_count: Number(stats.completed_count) || 0,
        cancelled_count: Number(stats.cancelled_count) || 0,
        completed_today: Number(stats.completed_today) || 0,
        total_revenue: +Number(revenueRow?.total_revenue || 0).toFixed(2),
        revenue_today: +Number(revenueRow?.revenue_today || 0).toFixed(2)
      },
      active_jobs: activeJobs.map((j) => ({ ...j, total_cost: Number(j.total_cost) || 0 })),
      my_jobs: myJobs.map((j) => ({ ...j, total_cost: Number(j.total_cost) || 0 }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List job cards
router.get('/job-cards', authRequired, workshopOnly, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim();
    const where = [];
    const params = [];

    if (status) { where.push(`jc.status = $${params.length + 1}`); params.push(status); }
    if (search) {
      const like = `%${search}%`;
      where.push(`(COALESCE(b.registration, jc.registration) ILIKE $${params.length + 1} OR COALESCE(b.vin, jc.vin) ILIKE $${params.length + 1} OR COALESCE(b.make, jc.make) ILIKE $${params.length + 1} OR COALESCE(b.model, jc.model) ILIKE $${params.length + 1} OR jc.description ILIKE $${params.length + 1} OR u.full_name ILIKE $${params.length + 1})`);
      params.push(like);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows: jobs } = await pgDb.query(`
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
    `, params);

    res.json({ job_cards: jobs.map((j) => ({ ...j, total_cost: Number(j.total_cost) || 0 })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create job card
router.post('/job-cards', authRequired, workshopOnly, async (req, res) => {
  try {
    const { bike_id, vin, registration, make, model, year, color, engine_cc, fleet_owner_name, fleet_org_id, job_type, description, priority, technician_id } = req.body;

    if (!bike_id && (!vin || !make || !model)) {
      return res.status(400).json({ error: 'Link an existing bike or provide VIN, make, and model' });
    }
    if (bike_id) {
      const { rows: bikeRows } = await pgDb.query('SELECT id FROM bikes WHERE id = $1', [toInt(bike_id)]);
      if (!bikeRows[0]) return res.status(404).json({ error: 'Bike not found' });
    }

    const { rows: insertedRows } = await pgDb.query(`
      INSERT INTO job_cards (bike_id, vin, registration, make, model, year, color, engine_cc, fleet_owner_name, fleet_org_id, job_type, description, priority, technician_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id
    `, [
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
    ]);
    const newId = insertedRows[0].id;

    const newCard = await getJobCard(newId);
    res.json({ ok: true, id: newId, job_card: newCard });
    await logAudit(req.user.id, 'job_card.created', newId, { actor: req.user.full_name || req.user.email, job_type: job_type || 'service' });
    const { rows: createAdmins } = await pgDb.query(`SELECT id FROM users WHERE role IN ('admin','superadmin') AND status='active' AND deleted_at IS NULL`);
    const createDisplayReg = newCard.bike_registration || newCard.registration || newCard.bike_make || newCard.make || 'Unknown bike';
    for (const admin of createAdmins) {
      sendNotification({ userId: admin.id, channel: 'in_app', type: 'job_card_created', title: `New job card: ${createDisplayReg}`, message: `Job #${newId} (${job_type || 'service'}) created by ${req.user.full_name || req.user.email}.`, throwOnError: false }).catch(() => {});
    }
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Get job card detail
router.get('/job-cards/:id', authRequired, workshopOnly, async (req, res) => {
  try {
    const card = await getJobCard(toInt(req.params.id));
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    res.json({ job_card: card });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update job card
router.put('/job-cards/:id', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT * FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot edit a completed job' });

    const allowed = ['job_type', 'description', 'priority', 'technician_id', 'technician_notes'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) { sets.push(key); vals.push(req.body[key] || null); }
    }
    if (sets.length) {
      const setClause = sets.map((col, i) => `${col} = $${i + 1}`).join(', ');
      vals.push(id);
      await pgDb.query(`UPDATE job_cards SET ${setClause} WHERE id = $${vals.length}`, vals);
    }

    res.json({ ok: true, job_card: await getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start job
router.post('/job-cards/:id/start', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT status FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (!['open', 'quoted'].includes(card.status)) return res.status(400).json({ error: 'Only open or quoted jobs can be started' });

    await pgDb.query(`UPDATE job_cards SET status = 'in_progress', started_at = NOW(), technician_id = COALESCE(technician_id, $1) WHERE id = $2`, [req.user.id, id]);
    res.json({ ok: true, job_card: await getJobCard(id) });
    await logAudit(req.user.id, 'job_card.started', id, { actor: req.user.full_name || req.user.email });
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Complete job
router.post('/job-cards/:id/complete', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT * FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (!['open', 'in_progress'].includes(card.status)) return res.status(400).json({ error: 'Job is already completed or cancelled' });

    const { completion_notes, odometer_km, next_service_date, next_service_km, bike_status_after } = req.body;
    const parsedOdometer = odometer_km ? Number(odometer_km) : null;
    if (card.bike_id && (!Number.isFinite(parsedOdometer) || parsedOdometer <= 0)) {
      return res.status(400).json({ error: 'Odometer reading is required to complete a job on a bike — it calibrates the bike\'s tracked odometer and sets the next service due date.' });
    }
    // Default the next-service trigger to 3,000 km after this reading (the
    // platform's standard service interval) unless the technician overrode
    // it — keeps the rule enforced server-side, not just as a frontend default.
    const parsedNextKm = next_service_km ? Number(next_service_km) : (parsedOdometer ? parsedOdometer + 3000 : null);

    await pgDb.query(`
      UPDATE job_cards SET status = 'completed', completed_at = NOW(),
        started_at = COALESCE(started_at, NOW()),
        completion_notes = $1, odometer_km = $2, next_service_date = $3, next_service_km = $4, bike_status_after = $5
      WHERE id = $6
    `, [completion_notes || null, parsedOdometer, next_service_date || null, parsedNextKm, bike_status_after || null, id]);

    // Log to service_records and update bike if linked
    if (card.bike_id) {
      const { rows: items } = await pgDb.query('SELECT * FROM job_card_items WHERE job_card_id = $1', [id]);
      const totalCost = items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unit_cost), 0);
      const descParts = [card.description, ...items.slice(0, 5).map((i) => `${i.description} (${i.quantity}x)`)]
        .filter(Boolean).join('; ').slice(0, 500);

      await pgDb.query(`
        INSERT INTO service_records (bike_id, service_date, service_type, description, cost, odometer_km, next_service_km, next_service_date, performed_by, job_card_id)
        VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [card.bike_id, card.job_type, descParts || null, totalCost || null, parsedOdometer, parsedNextKm, next_service_date || null, req.user.full_name || req.user.email, id]);

      const bikeSets = [];
      const bikeVals = [];
      if (parsedOdometer) { bikeSets.push('odometer_km'); bikeVals.push(parsedOdometer); }
      if (next_service_date) { bikeSets.push('next_service_date'); bikeVals.push(next_service_date); }
      if (parsedNextKm) { bikeSets.push('next_service_km'); bikeVals.push(parsedNextKm); }
      if (bike_status_after) { bikeSets.push('status'); bikeVals.push(bike_status_after); }
      if (bikeSets.length) {
        const setClause = bikeSets.map((col, i) => `${col} = $${i + 1}`).join(', ');
        bikeVals.push(card.bike_id);
        await pgDb.query(`UPDATE bikes SET ${setClause} WHERE id = $${bikeVals.length}`, bikeVals);
      }
    }

    res.json({ ok: true, job_card: await getJobCard(id) });
    await logAudit(req.user.id, 'job_card.completed', id, { actor: req.user.full_name || req.user.email, completion_notes: completion_notes || null });
    const { rows: completeItems } = await pgDb.query('SELECT quantity, unit_cost FROM job_card_items WHERE job_card_id = $1', [id]);
    const completeCost = completeItems.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_cost), 0);
    const completeReg = card.registration || card.vin || card.make || `Job #${id}`;
    const completeTech = req.user.full_name || req.user.email;
    const { rows: completeAdmins } = await pgDb.query(`SELECT id FROM users WHERE role IN ('admin','superadmin') AND status='active' AND deleted_at IS NULL`);
    const completeTitle = `Job completed: ${completeReg}`;
    const completeMsg = `Job #${id} (${card.job_type}) for ${completeReg} was completed by ${completeTech}. Total: R${completeCost.toFixed(2)}.`;
    for (const admin of completeAdmins) {
      sendNotification({ userId: admin.id, channel: 'in_app', type: 'job_card_completed', title: completeTitle, message: completeMsg, throwOnError: false }).catch(() => {});
      sendNotification({ userId: admin.id, channel: 'email', type: 'job_card_completed', title: completeTitle, message: completeMsg, throwOnError: false }).catch(() => {});
    }
    // Email fleet org contact if job is linked to a bike with an org
    if (card.bike_id) {
      const { rows: orgRows } = await pgDb.query(`SELECT o.contact_email, o.name FROM bikes b JOIN organizations o ON o.id = b.organization_id WHERE b.id = $1`, [card.bike_id]);
      const orgRow = orgRows[0];
      if (orgRow?.contact_email) {
        const itemLines = completeItems.map((i, idx) => `${idx + 1}. ${i.quantity}x item = R${(Number(i.quantity) * Number(i.unit_cost)).toFixed(2)}`).join('\n') || 'No line items recorded.';
        const emailBody = `Hi ${orgRow.name},\n\nYour vehicle ${completeReg} has been serviced and is ready.\n\nJob #${id} — ${card.job_type}\nTechnician: ${completeTech}\nTotal: R${completeCost.toFixed(2)}\n\n${completion_notes ? `Notes: ${completion_notes}\n\n` : ''}Thank you for using OnFleet Africa Workshop.`;
        sendEmail(orgRow.contact_email, completeTitle, emailBody).catch(() => {});
      }
    }
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Cancel job
router.delete('/job-cards/:id', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT status FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot cancel a completed job' });
    await pgDb.query(`UPDATE job_cards SET status = 'cancelled' WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add line item
router.post('/job-cards/:id/items', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT status FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot add items to a completed job' });
    if (!req.body.description) return res.status(400).json({ error: 'Description is required' });

    await pgDb.query(`INSERT INTO job_card_items (job_card_id, item_type, description, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
      [id, req.body.item_type || 'labor', req.body.description, Number(req.body.quantity) || 1, Number(req.body.unit_cost) || 0]);

    res.json({ ok: true, job_card: await getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit line item
router.put('/job-cards/:id/items/:itemId', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const itemId = toInt(req.params.itemId);
    const { rows: cardRows } = await pgDb.query('SELECT status FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot edit items on a completed job' });

    await pgDb.query(`UPDATE job_card_items SET item_type = $1, description = $2, quantity = $3, unit_cost = $4 WHERE id = $5 AND job_card_id = $6`,
      [req.body.item_type || 'labor', req.body.description || '', Number(req.body.quantity) || 1, Number(req.body.unit_cost) || 0, itemId, id]);

    res.json({ ok: true, job_card: await getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete line item
router.delete('/job-cards/:id/items/:itemId', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT status FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot delete items on a completed job' });
    await pgDb.query('DELETE FROM job_card_items WHERE id = $1 AND job_card_id = $2', [toInt(req.params.itemId), id]);
    res.json({ ok: true, job_card: await getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search existing bikes
router.get('/bikes/search', authRequired, workshopOnly, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ bikes: [] });
    const like = `%${q}%`;
    const { rows: bikes } = await pgDb.query(`
      SELECT b.id, b.vin, b.registration, b.make, b.model, b.year, b.color, b.engine_cc,
        b.status, b.fleet, b.organization_id, o.name AS org_name,
        b.next_service_date, b.next_service_km, b.odometer_km, b.image_url
      FROM bikes b
      LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE b.registration ILIKE $1 OR b.vin ILIKE $1 OR b.make ILIKE $1 OR b.model ILIKE $1
      ORDER BY b.registration, b.make
      LIMIT 10
    `, [like]);
    res.json({ bikes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new bike (bikes brought in that are not yet on the platform)
router.post('/bikes', authRequired, workshopOnly, async (req, res) => {
  try {
    const { vin, registration, make, model, year, color, engine_cc, fleet_owner_name } = req.body;
    if (!vin || !make || !model) return res.status(400).json({ error: 'VIN, make, and model are required' });

    const { rows: existingRows } = await pgDb.query('SELECT id, registration FROM bikes WHERE vin = $1', [vin]);
    const existing = existingRows[0];
    if (existing) return res.status(409).json({ error: `A bike with VIN ${vin} already exists`, existing_id: existing.id });

    const { rows: insertedRows } = await pgDb.query(`
      INSERT INTO bikes (vin, registration, make, model, year, color, engine_cc, fleet, rental_weekly, total_weeks, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, 0, 0, 'not_available', $9) RETURNING id
    `, [
      vin, registration || null, make, model,
      year ? Number(year) : null, color || null,
      engine_cc ? Number(engine_cc) : null,
      fleet_owner_name || null,
      fleet_owner_name ? `Registered via workshop — fleet owner: ${fleet_owner_name}` : 'Registered via workshop'
    ]);

    const { rows: bikeRows } = await pgDb.query('SELECT * FROM bikes WHERE id = $1', [insertedRows[0].id]);
    res.json({ ok: true, bike: bikeRows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A bike with this VIN or registration already exists' });
    res.status(500).json({ error: error.message });
  }
});

// List technicians (for assignment dropdown)
router.get('/technicians', authRequired, workshopOnly, async (req, res) => {
  try {
    const { rows: technicians } = await pgDb.query(`
      SELECT id, full_name, email FROM users
      WHERE role IN ('technician', 'admin', 'superadmin') AND status = 'active' AND deleted_at IS NULL
      ORDER BY full_name
    `);
    res.json({ technicians });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bike service history for job card context
router.get('/job-cards/:id/bike-history', authRequired, workshopOnly, async (req, res) => {
  try {
    const { rows: cardRows } = await pgDb.query('SELECT bike_id FROM job_cards WHERE id = $1', [toInt(req.params.id)]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (!card.bike_id) return res.json({ records: [] });
    const { rows: records } = await pgDb.query(`
      SELECT sr.id, sr.service_date, sr.service_type, sr.description, sr.cost,
        sr.odometer_km, sr.next_service_km, sr.next_service_date, sr.performed_by, sr.job_card_id
      FROM service_records sr
      WHERE sr.bike_id = $1
      ORDER BY sr.service_date DESC, sr.id DESC
      LIMIT 20
    `, [card.bike_id]);
    res.json({ records });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Parts/labour suggestions from historical usage
router.get('/parts-suggestions', authRequired, workshopOnly, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const { rows: suggestions } = await pgDb.query(`
      SELECT description, item_type,
        ROUND(AVG(unit_cost), 2) AS avg_unit_cost,
        COUNT(*) AS usage_count
      FROM job_card_items
      ${q ? 'WHERE LOWER(description) LIKE $1' : ''}
      GROUP BY LOWER(TRIM(description)), item_type
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `, q ? [`%${q.toLowerCase()}%`] : []);
    res.json({ suggestions: suggestions.map((s) => ({ ...s, avg_unit_cost: Number(s.avg_unit_cost) || 0, usage_count: Number(s.usage_count) || 0 })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upcoming service schedule — bikes due within N days
router.get('/upcoming-services', authRequired, workshopOnly, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const { rows: bikes } = await pgDb.query(`
      SELECT b.id, b.registration, b.vin, b.make, b.model, b.next_service_date, b.next_service_km,
        b.odometer_km, b.status, o.name AS org_name,
        CASE WHEN b.next_service_date < CURRENT_DATE THEN 'overdue' ELSE 'upcoming' END AS urgency,
        (SELECT id FROM job_cards WHERE bike_id = b.id AND status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1) AS active_job_id
      FROM bikes b
      LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE b.next_service_date IS NOT NULL
        AND b.next_service_date <= (CURRENT_DATE + $1)
        AND b.status NOT IN ('sold','paid_off','written_off')
      ORDER BY b.next_service_date ASC
      LIMIT 30
    `, [days]);
    res.json({ bikes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Job card templates — list
router.get('/templates', authRequired, workshopOnly, async (req, res) => {
  try {
    const { rows: templates } = await pgDb.query('SELECT * FROM job_card_templates ORDER BY name ASC');
    res.json({ templates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Job card templates — create from current job items or manual
router.post('/templates', authRequired, workshopOnly, async (req, res) => {
  try {
    const { name, job_type, description, items } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Template name is required' });
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Items must be an array' });
    const { rows: insertedRows } = await pgDb.query(`
      INSERT INTO job_card_templates (name, job_type, description, items, created_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [name.trim(), job_type || 'service', description || null, JSON.stringify(items), req.user.id]);
    const { rows: templateRows } = await pgDb.query('SELECT * FROM job_card_templates WHERE id = $1', [insertedRows[0].id]);
    res.json({ ok: true, template: templateRows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Job card templates — delete
router.delete('/templates/:id', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: existingRows } = await pgDb.query('SELECT id FROM job_card_templates WHERE id = $1', [id]);
    if (!existingRows[0]) return res.status(404).json({ error: 'Template not found' });
    await pgDb.query('DELETE FROM job_card_templates WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apply template to job card — adds template items to existing job
router.post('/job-cards/:id/apply-template/:templateId', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const templateId = toInt(req.params.templateId);
    const { rows: cardRows } = await pgDb.query('SELECT status FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status === 'completed') return res.status(400).json({ error: 'Cannot modify a completed job' });
    const { rows: templateRows } = await pgDb.query('SELECT * FROM job_card_templates WHERE id = $1', [templateId]);
    const template = templateRows[0];
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const items = JSON.parse(template.items || '[]');
    for (const item of items) {
      await pgDb.query(`INSERT INTO job_card_items (job_card_id, item_type, description, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
        [id, item.item_type || 'labor', item.description, Number(item.quantity) || 1, Number(item.unit_cost) || 0]);
    }
    res.json({ ok: true, job_card: await getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Admin endpoints ---

// Admin stats endpoint — wider stats for the admin console overview
router.get('/admin/stats', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });

    const { rows: statsRows } = await pgDb.query(`
      SELECT
        COUNT(*) AS total_jobs,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_jobs,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_jobs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs
      FROM job_cards
    `);
    const stats = statsRows[0];

    const { rows: revenueRows } = await pgDb.query(`
      SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) AS total_revenue
      FROM job_card_items i
      JOIN job_cards jc ON jc.id = i.job_card_id
      WHERE jc.status = 'completed'
    `);
    const revenueRow = revenueRows[0];

    const { rows: recentJobs } = await pgDb.query(`
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
    `);

    res.json({
      stats: {
        total_jobs: Number(stats.total_jobs) || 0,
        open_jobs: Number(stats.open_jobs) || 0,
        in_progress_jobs: Number(stats.in_progress_jobs) || 0,
        completed_jobs: Number(stats.completed_jobs) || 0,
        total_revenue: +Number(revenueRow?.total_revenue || 0).toFixed(2)
      },
      recent_jobs: recentJobs.map((j) => ({ ...j, total_cost: Number(j.total_cost) || 0 }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: full paginated job list
router.get('/admin/jobs', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim();
    const techId = String(req.query.technician_id || '').trim();
    const dateFrom = String(req.query.date_from || '').trim();
    const dateTo = String(req.query.date_to || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const SORT_COLS = { created_at: 'jc.created_at', completed_at: 'jc.completed_at', priority: 'jc.priority', total_cost: 'total_cost' };
    const sortBy = SORT_COLS[req.query.sort_by] || null;
    const sortDir = req.query.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const where = [];
    const params = [];
    if (status) { where.push(`jc.status = $${params.length + 1}`); params.push(status); }
    if (techId) { where.push(`jc.technician_id = $${params.length + 1}`); params.push(Number(techId)); }
    if (dateFrom) { where.push(`jc.created_at::date >= $${params.length + 1}`); params.push(dateFrom); }
    if (dateTo) { where.push(`jc.created_at::date <= $${params.length + 1}`); params.push(dateTo); }
    if (search) {
      const like = `%${search}%`;
      where.push(`(COALESCE(b.registration, jc.registration) ILIKE $${params.length + 1} OR COALESCE(b.vin, jc.vin) ILIKE $${params.length + 1} OR COALESCE(b.make, jc.make) ILIKE $${params.length + 1} OR jc.description ILIKE $${params.length + 1} OR u.full_name ILIKE $${params.length + 1})`);
      params.push(like);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows: totalRows } = await pgDb.query(`SELECT COUNT(*) AS count FROM job_cards jc LEFT JOIN bikes b ON b.id = jc.bike_id LEFT JOIN users u ON u.id = jc.technician_id ${whereClause}`, params);
    const total = Number(totalRows[0].count) || 0;
    const orderBy = sortBy
      ? `ORDER BY ${sortBy} ${sortDir}`
      : `ORDER BY CASE jc.status WHEN 'in_progress' THEN 1 WHEN 'open' THEN 2 WHEN 'quoted' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END, CASE jc.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, jc.created_at DESC`;
    const { rows: jobs } = await pgDb.query(`
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
      ${orderBy}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);
    res.json({ jobs: jobs.map((j) => ({ ...j, total_cost: Number(j.total_cost) || 0 })), total, limit, offset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: get full job card detail with line items and audit trail
router.get('/admin/jobs/:id', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const card = await getJobCard(id);
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    const { rows: audit } = await pgDb.query(`
      SELECT al.id, al.action, al.metadata, al.created_at,
        u.full_name AS actor_name, u.email AS actor_email, u.role AS actor_role
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.entity = 'job_card' AND al.entity_id = $1
      ORDER BY al.created_at ASC
    `, [id]);
    res.json({ job_card: card, audit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: add a note to a job card (logged in audit trail)
router.post('/admin/jobs/:id/notes', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    if (!id) return res.status(404).json({ error: 'Job card not found' });
    const { rows: cardRows } = await pgDb.query('SELECT id FROM job_cards WHERE id = $1', [id]);
    if (!cardRows[0]) return res.status(404).json({ error: 'Job card not found' });
    const note = String(req.body.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Note is required' });
    await logAudit(req.user.id, 'job_card.note', id, { note, actor: req.user.full_name || req.user.email });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: update any job (reassign, reprioritize, cancel)
router.put('/admin/jobs/:id', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT * FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    const sets = [];
    const vals = [];
    const editable = ['priority', 'technician_id', 'description'];
    for (const key of editable) {
      if (req.body[key] !== undefined) { sets.push(key); vals.push(req.body[key] || null); }
    }
    if (req.body.status === 'cancelled' && !['completed', 'cancelled'].includes(card.status)) {
      sets.push('status'); vals.push('cancelled');
    }
    if (req.body.status === 'quoted' && card.status === 'open') {
      sets.push('status'); vals.push('quoted');
    }
    let alsoSetStartedAt = false;
    if (req.body.status === 'in_progress' && ['open', 'quoted'].includes(card.status)) {
      sets.push('status'); vals.push('in_progress');
      if (!card.started_at) alsoSetStartedAt = true;
    }
    if (sets.length) {
      const setClause = sets.map((col, i) => `${col} = $${i + 1}`).join(', ') + (alsoSetStartedAt ? ', started_at = NOW()' : '');
      vals.push(id);
      await pgDb.query(`UPDATE job_cards SET ${setClause} WHERE id = $${vals.length}`, vals);
    }
    const changes = {};
    if (req.body.priority !== undefined && req.body.priority !== card.priority) changes.priority = { from: card.priority, to: req.body.priority };
    if (req.body.technician_id !== undefined && (req.body.technician_id || null) != card.technician_id) changes.technician_id = { from: card.technician_id, to: req.body.technician_id || null };
    if (req.body.description !== undefined && req.body.description !== card.description) changes.description = 'updated';
    if (req.body.status === 'cancelled' && card.status !== 'cancelled') changes.status = { from: card.status, to: 'cancelled' };
    if (Object.keys(changes).length) await logAudit(req.user.id, 'job_card.admin_edit', id, { changes, actor: req.user.full_name || req.user.email });
    res.json({ ok: true, job_card: await getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: hard-delete job card
router.delete('/admin/jobs/:id', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    const { rows: existingRows } = await pgDb.query('SELECT id FROM job_cards WHERE id = $1', [id]);
    if (!existingRows[0]) return res.status(404).json({ error: 'Job card not found' });
    await pgDb.query('DELETE FROM job_cards WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: per-technician performance
router.get('/admin/technician-stats', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const { rows: technicians } = await pgDb.query(`
      SELECT u.id, u.full_name, u.email, u.role,
        COUNT(jc.id) AS total_jobs,
        SUM(CASE WHEN jc.status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
        SUM(CASE WHEN jc.status = 'in_progress' THEN 1 ELSE 0 END) AS active_jobs,
        SUM(CASE WHEN jc.status = 'open' THEN 1 ELSE 0 END) AS open_jobs,
        COALESCE(SUM(CASE WHEN jc.status = 'completed' THEN
          (SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM job_card_items WHERE job_card_id = jc.id)
          ELSE 0 END), 0) AS total_revenue,
        ROUND(AVG(CASE WHEN jc.started_at IS NOT NULL AND jc.completed_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (jc.completed_at - jc.started_at)) / 3600 END)::numeric, 1) AS avg_hours
      FROM users u
      LEFT JOIN job_cards jc ON jc.technician_id = u.id
      WHERE u.role IN ('technician', 'admin', 'superadmin') AND u.status = 'active' AND u.deleted_at IS NULL
      GROUP BY u.id
      ORDER BY completed_jobs DESC, total_revenue DESC
    `);
    res.json({ technicians: technicians.map((t) => ({
      ...t,
      total_jobs: Number(t.total_jobs) || 0,
      completed_jobs: Number(t.completed_jobs) || 0,
      active_jobs: Number(t.active_jobs) || 0,
      open_jobs: Number(t.open_jobs) || 0,
      total_revenue: Number(t.total_revenue) || 0,
      avg_hours: t.avg_hours === null ? null : Number(t.avg_hours)
    })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: fleet health — bikes with overdue/upcoming service or in workshop
router.get('/admin/fleet-health', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const healthFilter = String(req.query.health || '').trim();
    const healthWhere = healthFilter === 'overdue'
      ? `AND (b.next_service_date < CURRENT_DATE OR (b.next_service_km IS NOT NULL AND b.odometer_km >= b.next_service_km))`
      : healthFilter === 'due_soon'
      ? `AND b.next_service_date IS NOT NULL AND b.next_service_date >= CURRENT_DATE AND b.next_service_date <= (CURRENT_DATE + 30)`
      : '';
    const { rows: totalRows } = await pgDb.query(`SELECT COUNT(*) AS count FROM bikes b WHERE b.status NOT IN ('sold','paid_off','written_off') ${healthWhere}`);
    const total = Number(totalRows[0].count) || 0;
    const { rows: bikes } = await pgDb.query(`
      SELECT b.id, b.registration, b.vin, b.make, b.model, b.year, b.status,
        b.odometer_km, b.next_service_date, b.next_service_km,
        o.name AS org_name,
        CASE
          WHEN b.next_service_date IS NOT NULL AND b.next_service_date < CURRENT_DATE THEN 'overdue'
          WHEN b.next_service_km IS NOT NULL AND b.odometer_km IS NOT NULL AND b.odometer_km >= b.next_service_km THEN 'overdue'
          WHEN b.next_service_date IS NOT NULL AND b.next_service_date <= (CURRENT_DATE + 30) THEN 'due_soon'
          ELSE 'ok'
        END AS service_health,
        (SELECT id FROM job_cards WHERE bike_id = b.id AND status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1) AS active_job_id,
        (SELECT status FROM job_cards WHERE bike_id = b.id AND status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1) AS active_job_status,
        (SELECT service_date FROM service_records WHERE bike_id = b.id ORDER BY service_date DESC, id DESC LIMIT 1) AS last_service_date
      FROM bikes b
      LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE b.status NOT IN ('sold','paid_off','written_off') ${healthWhere}
      ORDER BY
        CASE
          WHEN b.next_service_date IS NOT NULL AND b.next_service_date < CURRENT_DATE THEN 1
          WHEN b.next_service_km IS NOT NULL AND b.odometer_km IS NOT NULL AND b.odometer_km >= b.next_service_km THEN 1
          WHEN b.next_service_date IS NOT NULL AND b.next_service_date <= (CURRENT_DATE + 30) THEN 2
          WHEN (SELECT id FROM job_cards WHERE bike_id = b.id AND status NOT IN ('completed','cancelled') LIMIT 1) IS NOT NULL THEN 3
          ELSE 4
        END,
        b.next_service_date ASC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json({ bikes, total, limit, offset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: revenue breakdown by month and by job type
router.get('/admin/revenue-by-month', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const { rows: months } = await pgDb.query(`
      SELECT TO_CHAR(jc.completed_at, 'YYYY-MM') AS month,
        COUNT(*) AS jobs_completed,
        COALESCE(SUM(i.quantity * i.unit_cost), 0) AS revenue
      FROM job_cards jc
      LEFT JOIN job_card_items i ON i.job_card_id = jc.id
      WHERE jc.status = 'completed' AND jc.completed_at IS NOT NULL
      GROUP BY TO_CHAR(jc.completed_at, 'YYYY-MM')
      ORDER BY month DESC
      LIMIT 12
    `);
    const { rows: byType } = await pgDb.query(`
      SELECT jc.job_type,
        COUNT(*) AS job_count,
        COALESCE(SUM(i.quantity * i.unit_cost), 0) AS revenue
      FROM job_cards jc
      LEFT JOIN job_card_items i ON i.job_card_id = jc.id
      WHERE jc.status = 'completed'
      GROUP BY jc.job_type
      ORDER BY revenue DESC
    `);
    const { rows: overdueJobsRows } = await pgDb.query(`
      SELECT COUNT(*) AS count FROM job_cards
      WHERE status IN ('open','in_progress')
        AND created_at < NOW() - INTERVAL '2 days'
    `);
    res.json({
      months: months.reverse().map((m) => ({ month: m.month, jobs_completed: Number(m.jobs_completed) || 0, revenue: Number(m.revenue) || 0 })),
      by_type: byType.map((t) => ({ job_type: t.job_type, job_count: Number(t.job_count) || 0, revenue: Number(t.revenue) || 0 })),
      overdue_jobs: Number(overdueJobsRows[0].count) || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Technician notes — any workshop user can add a note to their own job
router.post('/job-cards/:id/notes', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT id, technician_id FROM job_cards WHERE id = $1', [id]);
    if (!cardRows[0]) return res.status(404).json({ error: 'Job card not found' });
    const note = String(req.body.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Note is required' });
    await logAudit(req.user.id, 'job_card.technician_note', id, { note, actor: req.user.full_name || req.user.email });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pause timer
router.post('/job-cards/:id/pause', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT status, paused_at FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (card.status !== 'in_progress') return res.status(400).json({ error: 'Only in-progress jobs can be paused' });
    if (card.paused_at) return res.status(400).json({ error: 'Job is already paused' });
    await pgDb.query(`UPDATE job_cards SET paused_at = NOW() WHERE id = $1`, [id]);
    await logAudit(req.user.id, 'job_card.paused', id, { actor: req.user.full_name || req.user.email });
    res.json({ ok: true, job_card: await getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Resume timer
router.post('/job-cards/:id/resume', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT status, paused_at, total_paused_seconds FROM job_cards WHERE id = $1', [id]);
    const card = cardRows[0];
    if (!card) return res.status(404).json({ error: 'Job card not found' });
    if (!card.paused_at) return res.status(400).json({ error: 'Job is not paused' });
    const pausedSecs = Math.floor((Date.now() - new Date(card.paused_at).getTime()) / 1000);
    const newTotal = (card.total_paused_seconds || 0) + pausedSecs;
    await pgDb.query(`UPDATE job_cards SET paused_at = NULL, total_paused_seconds = $1 WHERE id = $2`, [newTotal, id]);
    await logAudit(req.user.id, 'job_card.resumed', id, { actor: req.user.full_name || req.user.email, paused_seconds: pausedSecs });
    res.json({ ok: true, job_card: await getJobCard(id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Photo upload
router.post('/job-cards/:id/photos', authRequired, workshopOnly, photoUpload.single('photo'), async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT id FROM job_cards WHERE id = $1', [id]);
    if (!cardRows[0]) { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} return res.status(404).json({ error: 'Job card not found' }); }
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
    const caption = String(req.body.caption || '').trim();
    const { rows: insertedRows } = await pgDb.query(`INSERT INTO job_card_photos (job_card_id, file_path, original_name, caption, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [id, req.file.path, req.file.originalname, caption || null, req.user.id]);
    const { rows: photoRows } = await pgDb.query('SELECT * FROM job_card_photos WHERE id = $1', [insertedRows[0].id]);
    const photo = photoRows[0];
    res.json({ ok: true, photo: { ...photo, url: photoUrl(photo.file_path) } });
  } catch (error) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: error.message });
  }
});

// List photos
router.get('/job-cards/:id/photos', authRequired, workshopOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { rows: cardRows } = await pgDb.query('SELECT id FROM job_cards WHERE id = $1', [id]);
    if (!cardRows[0]) return res.status(404).json({ error: 'Job card not found' });
    const { rows: photos } = await pgDb.query('SELECT * FROM job_card_photos WHERE job_card_id = $1 ORDER BY created_at ASC', [id]);
    res.json({ photos: photos.map((p) => ({ ...p, url: photoUrl(p.file_path) })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve photo image
router.get('/job-cards/:id/photos/:photoId/image', authRequired, workshopOnly, async (req, res) => {
  try {
    const { rows: photoRows } = await pgDb.query('SELECT * FROM job_card_photos WHERE id = $1 AND job_card_id = $2', [toInt(req.params.photoId), toInt(req.params.id)]);
    const photo = photoRows[0];
    if (!photo || !fs.existsSync(photo.file_path)) return res.status(404).json({ error: 'Photo not found' });
    res.sendFile(photo.file_path);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete photo
router.delete('/job-cards/:id/photos/:photoId', authRequired, workshopOnly, async (req, res) => {
  try {
    const { rows: photoRows } = await pgDb.query('SELECT * FROM job_card_photos WHERE id = $1 AND job_card_id = $2', [toInt(req.params.photoId), toInt(req.params.id)]);
    const photo = photoRows[0];
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    try { fs.unlinkSync(photo.file_path); } catch {}
    await pgDb.query('DELETE FROM job_card_photos WHERE id = $1', [photo.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Labour rates — list
router.get('/labour-rates', authRequired, workshopOnly, async (req, res) => {
  try {
    const { rows: rates } = await pgDb.query('SELECT * FROM labour_rates WHERE active = TRUE ORDER BY item_type, name');
    res.json({ rates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Labour rates — create (admin)
router.post('/labour-rates', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const { name, description, item_type, unit_cost } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!Number.isFinite(Number(unit_cost)) || Number(unit_cost) < 0) return res.status(400).json({ error: 'Unit cost must be a non-negative number' });
    const { rows: insertedRows } = await pgDb.query(`INSERT INTO labour_rates (name, description, item_type, unit_cost, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name.trim(), description || null, item_type || 'labor', Number(unit_cost), req.user.id]);
    const { rows: rateRows } = await pgDb.query('SELECT * FROM labour_rates WHERE id = $1', [insertedRows[0].id]);
    res.json({ ok: true, rate: rateRows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Labour rates — update (admin)
router.put('/labour-rates/:id', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    const { rows: existingRows } = await pgDb.query('SELECT id FROM labour_rates WHERE id = $1', [id]);
    if (!existingRows[0]) return res.status(404).json({ error: 'Rate not found' });
    const { name, description, item_type, unit_cost, active } = req.body;
    const sets = []; const vals = [];
    if (name !== undefined) { sets.push('name'); vals.push(String(name).trim()); }
    if (description !== undefined) { sets.push('description'); vals.push(description || null); }
    if (item_type !== undefined) { sets.push('item_type'); vals.push(item_type); }
    if (unit_cost !== undefined) { sets.push('unit_cost'); vals.push(Number(unit_cost)); }
    if (active !== undefined) { sets.push('active'); vals.push(!!active); }
    if (sets.length) {
      const setClause = sets.map((col, i) => `${col} = $${i + 1}`).join(', ') + ', updated_at = NOW()';
      vals.push(id);
      await pgDb.query(`UPDATE labour_rates SET ${setClause} WHERE id = $${vals.length}`, vals);
    }
    const { rows: rateRows } = await pgDb.query('SELECT * FROM labour_rates WHERE id = $1', [id]);
    res.json({ ok: true, rate: rateRows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Labour rates — delete (admin)
router.delete('/labour-rates/:id', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    const { rows: existingRows } = await pgDb.query('SELECT id FROM labour_rates WHERE id = $1', [id]);
    if (!existingRows[0]) return res.status(404).json({ error: 'Rate not found' });
    await pgDb.query('UPDATE labour_rates SET active = FALSE WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: revenue breakdown by fleet org
router.get('/admin/revenue-by-org', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const { rows: byOrg } = await pgDb.query(`
      SELECT COALESCE(o.name, 'Walk-in / External') AS org_name,
        COUNT(DISTINCT jc.id) AS job_count,
        COALESCE(SUM(i.quantity * i.unit_cost), 0) AS revenue
      FROM job_cards jc
      LEFT JOIN bikes b ON b.id = jc.bike_id
      LEFT JOIN organizations o ON o.id = COALESCE(b.organization_id, jc.fleet_org_id)
      LEFT JOIN job_card_items i ON i.job_card_id = jc.id
      WHERE jc.status = 'completed'
      GROUP BY COALESCE(o.id, -1), COALESCE(o.name, 'Walk-in / External')
      ORDER BY revenue DESC
      LIMIT 20
    `);
    res.json({ by_org: byOrg.map((r) => ({ org_name: r.org_name, job_count: Number(r.job_count) || 0, revenue: Number(r.revenue) || 0 })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: list workshop staff (technicians)
router.get('/admin/staff', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const { rows: staff } = await pgDb.query(`
      SELECT u.id, u.full_name, u.email, u.phone, u.role, u.status, u.created_at,
        COUNT(jc.id) AS total_jobs,
        SUM(CASE WHEN jc.status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
        SUM(CASE WHEN jc.status IN ('open','in_progress') THEN 1 ELSE 0 END) AS active_jobs
      FROM users u
      LEFT JOIN job_cards jc ON jc.technician_id = u.id
      WHERE u.role = 'technician' AND u.deleted_at IS NULL
      GROUP BY u.id
      ORDER BY u.full_name
    `);
    res.json({ staff: staff.map((s) => ({ ...s, total_jobs: Number(s.total_jobs) || 0, completed_jobs: Number(s.completed_jobs) || 0, active_jobs: Number(s.active_jobs) || 0 })) });
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
    const { rows: insertedRows } = await pgDb.query(`
      INSERT INTO users (full_name, email, phone, password_hash, role, status)
      VALUES ($1,$2,$3,$4, 'technician', 'active') RETURNING id
    `, [full_name.trim(), email.toLowerCase().trim(), phone || null, hash]);
    const { rows: userRows } = await pgDb.query('SELECT id, full_name, email, phone, role, status, created_at FROM users WHERE id = $1', [insertedRows[0].id]);
    res.json({ ok: true, user: userRows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: error.message });
  }
});

// Admin: update technician (status toggle)
router.put('/admin/staff/:id', authRequired, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
    const id = toInt(req.params.id);
    const { rows: userRows } = await pgDb.query('SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'technician') return res.status(400).json({ error: 'Can only manage technician accounts here' });
    const allowed = ['status', 'full_name', 'phone'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) { sets.push(key); vals.push(req.body[key]); }
    }
    if (sets.length) {
      const setClause = sets.map((col, i) => `${col} = $${i + 1}`).join(', ');
      vals.push(id);
      await pgDb.query(`UPDATE users SET ${setClause} WHERE id = $${vals.length}`, vals);
    }
    const { rows: updatedRows } = await pgDb.query('SELECT id, full_name, email, phone, role, status FROM users WHERE id = $1', [id]);
    res.json({ ok: true, user: updatedRows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

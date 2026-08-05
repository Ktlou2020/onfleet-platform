const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
// Postgres versions — see each *Pg module's header comment for why it's a
// separate file from the SQLite original (other, not-yet-migrated routes
// still depend on those).
const { logAudit, generateAgreementNo, buildPaymentSchedule, addDays } = require('../utils/helpersPg');
const { setBikeStatus } = require('../utils/bikeStatusPg');
const { discontinueAgreementForStolenBike, discontinueAgreement } = require('../services/agreementLifecyclePg');
const { extractLicenseDiscInsights } = require('../services/documentInsights');
const { requireValidMime } = require('../utils/validateUpload');
const { writeContractSnapshot } = require('../services/contracts');
const asyncRouter = require('../utils/asyncRouter');

const router = asyncRouter(express.Router());
const { bikes: bikeUploadDir, serviceInvoices: invoiceUploadDir, bikeDocuments: bikeDocumentUploadDir } = require('../uploadPaths');

const bikeImageUpload = multer({
  storage: multer.diskStorage({
    destination: bikeUploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const invoiceUpload = multer({
  storage: multer.diskStorage({
    destination: invoiceUploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  fileFilter: (req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype)),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const bikeDocumentUpload = multer({
  storage: multer.diskStorage({
    destination: bikeDocumentUploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  fileFilter: (req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const OPEN_AGREEMENT_STATUSES_SQL = "('active','paused','defaulted')";
const ALLOCATION_ELIGIBLE_BIKE_STATUSES = ['ready_to_go', 'active'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function getSetting(key) {
  const { rows } = await pgDb.query('SELECT setting_value FROM app_settings WHERE setting_key = $1', [key]);
  return rows[0]?.setting_value || null;
}

async function computeBikeRoi(bikeId) {
  const { rows: revenueRows } = await pgDb.query(`SELECT COALESCE(SUM(COALESCE(NULLIF(p.net_amount,0), p.amount)),0) total FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    WHERE a.bike_id = $1 AND p.status = 'success'`, [bikeId]);
  const revenue = Number(revenueRows[0]?.total) || 0;
  const { rows: serviceRows } = await pgDb.query(`SELECT COALESCE(SUM(cost),0) total FROM service_records WHERE bike_id = $1`, [bikeId]);
  const serviceCost = Number(serviceRows[0]?.total) || 0;
  const { rows: bikeRows } = await pgDb.query(`SELECT purchase_price FROM bikes WHERE id = $1`, [bikeId]);
  const purchasePrice = Number(bikeRows[0]?.purchase_price || 0);
  const net = +(revenue - purchasePrice - serviceCost).toFixed(2);
  const roiPct = purchasePrice ? +((net / purchasePrice) * 100).toFixed(1) : null;
  return {
    revenue_total: +Number(revenue).toFixed(2),
    purchase_price: purchasePrice,
    service_cost_total: +Number(serviceCost).toFixed(2),
    net_roi: net,
    roi_pct: roiPct
  };
}

const bikeSelectSql = `SELECT b.*,
  (
    SELECT u.full_name FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_name,
  (
    SELECT u.phone FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_phone,
  (
    SELECT u.email FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_email,
  (
    SELECT u.id_number FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_id_number,
  (
    SELECT u.address FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_address,
  (
    SELECT u.city FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_city,
  (
    SELECT u.province FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_province,
  (
    SELECT u.avatar_url FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_avatar_url,
  (
    SELECT ap.payout_preference FROM agreements a
    LEFT JOIN applications ap ON ap.id = a.application_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_payout_preference,
  (
    SELECT ap.ewallet_number FROM agreements a
    LEFT JOIN applications ap ON ap.id = a.application_id
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_ewallet_number,
  (
    SELECT a.id FROM agreements a
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_agreement_id,
  (
    SELECT a.agreement_no FROM agreements a
    WHERE a.bike_id = b.id
      AND a.status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_agreement_no
FROM bikes b`;

async function listCatalogValues(column, whereClauses = [], params = []) {
  const sql = `SELECT DISTINCT b.${column} AS value
    FROM bikes b
    WHERE b.status = 'ready_to_go'
      AND ${adminVisibleBikeClause('b')}
      ${whereClauses.length ? `AND ${whereClauses.join(' AND ')}` : ''}
      AND COALESCE(TRIM(b.${column}), '') <> ''
    ORDER BY b.${column}`;
  const { rows } = await pgDb.query(sql, params);
  return rows.map((row) => row.value);
}

function adminVisibleBikeClause(alias = 'b') {
  return `${alias}.organization_id IS NULL AND NOT EXISTS (
    SELECT 1
    FROM organizations o
    WHERE LOWER(TRIM(COALESCE(${alias}.fleet, ''))) <> ''
      AND LOWER(TRIM(COALESCE(${alias}.fleet, ''))) IN (
        LOWER(TRIM(COALESCE(o.name, ''))),
        LOWER(TRIM(COALESCE(o.slug, '')))
      )
  )`;
}

async function getAdminVisibleBike(bikeId) {
  const { rows } = await pgDb.query(`${bikeSelectSql} WHERE b.id = $1 AND ${adminVisibleBikeClause('b')}`, [bikeId]);
  return rows[0];
}

async function getAdminVisibleRider(riderId) {
  const { rows } = await pgDb.query(`SELECT *
    FROM users
    WHERE id = $1
      AND role = 'rider'
      AND deleted_at IS NULL
      AND organization_id IS NULL`, [riderId]);
  return rows[0];
}

async function getOpenAgreementForBike(bikeId) {
  const { rows } = await pgDb.query(`SELECT *
    FROM agreements
    WHERE bike_id = $1 AND status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1`, [bikeId]);
  return rows[0];
}

async function getOpenAgreementForRider(riderId) {
  const { rows } = await pgDb.query(`SELECT *
    FROM agreements
    WHERE user_id = $1 AND status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1`, [riderId]);
  return rows[0];
}

router.get('/catalog', async (req, res) => {
  const make = String(req.query.make || '').trim();
  const model = String(req.query.model || '').trim();
  const condition = String(req.query.condition || '').trim();
  const whereClauses = [`b.status = 'ready_to_go'`, adminVisibleBikeClause('b')];
  const params = [];

  if (make) {
    params.push(make);
    whereClauses.push(`b.make = $${params.length}`);
  }
  if (model) {
    params.push(model);
    whereClauses.push(`b.model = $${params.length}`);
  }
  if (condition) {
    params.push(condition);
    whereClauses.push(`b.condition = $${params.length}`);
  }

  const { rows: bikes } = await pgDb.query(`SELECT b.id, b.make, b.model, b.year, b.engine_cc, b.condition, b.rental_weekly, b.total_weeks, b.image_url, b.status, b.registration
    FROM bikes b
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY b.make, b.model, b.year DESC, b.id DESC`, params);

  const modelWhereClauses = [];
  const modelParams = [];
  if (make) {
    modelParams.push(make);
    modelWhereClauses.push(`make = $${modelParams.length}`);
  }

  const conditionWhereClauses = [];
  const conditionParams = [];
  if (make) {
    conditionParams.push(make);
    conditionWhereClauses.push(`make = $${conditionParams.length}`);
  }
  if (model) {
    conditionParams.push(model);
    conditionWhereClauses.push(`model = $${conditionParams.length}`);
  }

  const [makes, models, conditions, heroImageUrl] = await Promise.all([
    listCatalogValues('make'),
    listCatalogValues('model', modelWhereClauses, modelParams),
    listCatalogValues('condition', conditionWhereClauses, conditionParams),
    getSetting('landing_hero_image_url')
  ]);

  res.json({
    bikes,
    filters: { makes, models, conditions },
    hero_image_url: heroImageUrl
  });
});

router.get('/', authRequired, adminOnly, async (req, res) => {
  const status = String(req.query.status || '').trim();
  const fleet = String(req.query.fleet || '').trim();
  const clauses = [adminVisibleBikeClause('b')];
  const params = [];

  if (status) {
    params.push(status);
    clauses.push(`b.status = $${params.length}`);
  }
  if (fleet) {
    params.push(fleet);
    clauses.push(`COALESCE(TRIM(b.fleet), '') = $${params.length}`);
  }

  const sql = `${bikeSelectSql} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY b.id DESC`;
  const { rows: bikes } = await pgDb.query(sql, params);
  res.json({ bikes });
});

router.post('/document-insights/license-disc', authRequired, adminOnly, bikeDocumentUpload.single('file'), requireValidMime(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A document file is required' });
  try {
    const extracted = await extractLicenseDiscInsights(req.file.path, req.file.mimetype);
    fs.unlink(req.file.path, () => {});
    res.json({
      ok: true,
      license_disc_no: extracted.license_disc_no || null,
      license_disc_expiry: extracted.license_disc_expiry || null,
      extraction_error: extracted.extraction_error || null
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    console.error('[license-disc-insights]', err.message);
    res.status(500).json({ error: err.message || 'Document insight extraction failed' });
  }
});

router.get('/:id', authRequired, async (req, res) => {
  const isAdminPortalUser = ['admin', 'superadmin'].includes(req.user.role);
  const { rows: bikeRows } = await pgDb.query(`${bikeSelectSql} WHERE b.id = $1${isAdminPortalUser ? ` AND ${adminVisibleBikeClause('b')}` : ''}`, [req.params.id]);
  const bike = bikeRows[0];
  if (!bike) return res.status(404).json({ error: 'Not found' });

  if (!isAdminPortalUser) {
    const { rows: ownRows } = await pgDb.query(`SELECT 1 FROM agreements WHERE bike_id = $1 AND user_id = $2 AND status = 'active'`, [req.params.id, req.user.id]);
    if (!ownRows[0]) return res.status(403).json({ error: 'Forbidden' });
  }

  const { rows: services } = await pgDb.query(`SELECT * FROM service_records WHERE bike_id = $1 ORDER BY service_date DESC LIMIT 50`, [req.params.id]);
  const { rows: lastPings } = await pgDb.query(`SELECT lat, lng, speed_kmh, recorded_at FROM gps_pings WHERE bike_id = $1 ORDER BY recorded_at DESC LIMIT 50`, [req.params.id]);
  const payload = { bike, services, gps_history: lastPings };
  if (isAdminPortalUser) payload.roi = await computeBikeRoi(req.params.id);
  res.json(payload);
});

router.post('/', authRequired, adminOnly, async (req, res) => {
  const b = req.body;
  const { rows } = await pgDb.query(`INSERT INTO bikes
    (vin, registration, make, model, fleet, organization_id, year, engine_cc, color, condition, purchase_price,
     rental_weekly, total_weeks, status, gps_device_id, odometer_km, insurance_provider,
     insurance_policy_no, insurance_expiry, license_disc_no, license_disc_expiry, image_url, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    RETURNING id`, [
      b.vin,
      b.registration || null,
      b.make,
      b.model,
      b.fleet || null,
      b.organization_id || null,
      b.year || null,
      b.engine_cc || null,
      b.color || null,
      b.condition || 'new',
      b.purchase_price || null,
      b.rental_weekly,
      b.total_weeks || 78,
      b.status || 'ready_to_go',
      b.gps_device_id || null,
      b.odometer_km || 0,
      b.insurance_provider || null,
      b.insurance_policy_no || null,
      b.insurance_expiry || null,
      b.license_disc_no || null,
      b.license_disc_expiry || null,
      b.image_url || null,
      b.notes || null
    ]);
  const id = rows[0].id;
  await logAudit(req.user.id, 'bike.create', 'bikes', id);
  res.json({ id });
});

router.put('/:id', authRequired, adminOnly, async (req, res) => {
  const allowed = ['registration', 'make', 'model', 'fleet', 'organization_id', 'year', 'engine_cc', 'color', 'condition', 'purchase_price', 'rental_weekly', 'total_weeks', 'gps_device_id', 'odometer_km', 'next_service_km', 'next_service_date', 'insurance_provider', 'insurance_policy_no', 'insurance_expiry', 'license_disc_no', 'license_disc_expiry', 'image_url', 'notes'];
  const sets = [];
  const vals = [];
  let statusMeta = null;

  if (req.body.status !== undefined) {
    try {
      statusMeta = await setBikeStatus(req.params.id, req.body.status);
      if (statusMeta?.next_status === 'stolen') {
        const discontinued = await discontinueAgreementForStolenBike({ bikeId: Number(req.params.id), actorId: req.user.id, ip: req.ip });
        statusMeta.discontinued_agreement_id = discontinued.agreement?.id || null;
        statusMeta.discontinued_agreement_no = discontinued.agreement?.agreement_no || null;
        statusMeta.waived_schedule_rows = discontinued.waived_rows || 0;
      }
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      vals.push(['fleet', 'organization_id'].includes(key) ? (req.body[key] || null) : req.body[key]);
      sets.push(`${key} = $${vals.length}`);
    }
  }

  if (sets.length) {
    vals.push(req.params.id);
    await pgDb.query(`UPDATE bikes SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }

  if (!sets.length && !statusMeta) return res.json({ ok: true });
  await logAudit(req.user.id, 'bike.update', 'bikes', Number(req.params.id), { ...req.body, ...(statusMeta || {}) });
  res.json({ ok: true, ...(statusMeta || {}) });
});


router.post('/:id/allocate', authRequired, adminOnly, async (req, res) => {
  try {
    const bikeId = Number(req.params.id);
    const riderId = Number(req.body.rider_id);
    const startDate = String(req.body.start_date || todayIso()).slice(0, 10);
    const note = String(req.body.notes || '').trim() || null;

    if (!Number.isInteger(bikeId) || bikeId <= 0 || !Number.isInteger(riderId) || riderId <= 0) {
      return res.status(400).json({ error: 'Bike and rider are required' });
    }

    const bike = await getAdminVisibleBike(bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found' });
    if (!ALLOCATION_ELIGIBLE_BIKE_STATUSES.includes(String(bike.status || ''))) {
      return res.status(400).json({ error: 'Bike must be active or ready to go before allocation' });
    }
    const { rows: existingOpenRows } = await pgDb.query(`SELECT id FROM agreements WHERE bike_id = $1 AND status IN ('active','paused') LIMIT 1`, [bikeId]);
    if (existingOpenRows[0]) {
      return res.status(400).json({ error: 'This bike already has an allocated rider' });
    }

    const rider = await getAdminVisibleRider(riderId);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    if (await getOpenAgreementForRider(riderId)) {
      return res.status(400).json({ error: 'This rider already has an open agreement' });
    }

    const weeklyAmount = Number(req.body.weekly_amount || bike.rental_weekly || 0);
    const totalWeeks = Number(req.body.total_weeks || bike.total_weeks || 78);
    if (!Number.isFinite(weeklyAmount) || weeklyAmount <= 0) {
      return res.status(400).json({ error: 'Weekly amount must be greater than zero' });
    }
    if (!Number.isFinite(totalWeeks) || totalWeeks <= 0) {
      return res.status(400).json({ error: 'Total weeks must be greater than zero' });
    }

    const { rows: matchingApplicationRows } = await pgDb.query(`SELECT ap.*
      FROM applications ap
      LEFT JOIN bikes pref ON pref.id = ap.preferred_bike_id
      WHERE ap.user_id = $1
        AND ap.status IN ('approved', 'submitted', 'under_review')
        AND (ap.preferred_bike_id = $2 OR ap.preferred_bike_id IS NULL OR pref.organization_id IS NULL)
      ORDER BY CASE WHEN ap.preferred_bike_id = $2 THEN 0 ELSE 1 END, ap.submitted_at DESC, ap.id DESC
      LIMIT 1`, [riderId, bikeId]);
    const matchingApplication = matchingApplicationRows[0];

    const totalAmount = +(weeklyAmount * totalWeeks).toFixed(2);
    const endDate = addDays(startDate, totalWeeks * 7);
    const agreementNo = generateAgreementNo();

    const agreementId = await pgDb.withTransaction(async (client) => {
      if (matchingApplication?.id) {
        await client.query(`UPDATE applications
          SET status = 'approved', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = NULL
          WHERE id = $2`, [req.user.id, matchingApplication.id]);
      }
      const { rows: insertRows } = await client.query(`INSERT INTO agreements
        (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, 'active', $10, $11)
        RETURNING id`, [
          agreementNo,
          riderId,
          bikeId,
          matchingApplication?.id || null,
          weeklyAmount,
          totalWeeks,
          totalAmount,
          startDate,
          endDate,
          note,
          req.user.id
        ]);
      const newAgreementId = insertRows[0].id;
      await buildPaymentSchedule(newAgreementId, weeklyAmount, totalWeeks, startDate, client);
      await client.query(`UPDATE bikes SET status = 'active' WHERE id = $1`, [bikeId]);
      return newAgreementId;
    });

    const { rows: agreementRows } = await pgDb.query('SELECT * FROM agreements WHERE id = $1', [agreementId]);
    const agreement = agreementRows[0];
    const contractPath = writeContractSnapshot({ agreement, rider, bike, application: matchingApplication || null, kind: 'unsigned' });
    await pgDb.query(`UPDATE agreements SET contract_file_path = $1, contract_pdf_path = $2 WHERE id = $3`, [contractPath, contractPath, agreementId]);

    if (matchingApplication?.id) {
      await pgDb.query(`INSERT INTO application_documents
        (application_id, user_id, doc_type, file_path, original_name, mime_type, status, uploaded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          matchingApplication.id,
          riderId,
          'unsigned_contract',
          contractPath,
          `${agreementNo}-contract.html`,
          'text/html',
          'verified',
          req.user.id
        ]);
    }

    await logAudit(req.user.id, 'bike.allocate_rider', 'agreements', agreementId, {
      bike_id: bikeId,
      rider_id: riderId,
      weekly_amount: weeklyAmount,
      total_weeks: totalWeeks,
      start_date: startDate
    }, req.ip);

    res.status(201).json({ ok: true, agreement_id: agreementId, agreement_no: agreementNo, contract_file_path: contractPath });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not allocate rider' });
  }
});

router.patch('/:id/allocated-rider', authRequired, adminOnly, async (req, res) => {
  const bikeId = Number(req.params.id);
  if (!Number.isInteger(bikeId) || bikeId <= 0) {
    return res.status(400).json({ error: 'Invalid bike id' });
  }

  const bike = await getAdminVisibleBike(bikeId);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  const agreement = await getOpenAgreementForBike(bikeId);
  if (!agreement) return res.status(400).json({ error: 'No allocated rider found for this bike' });

  const rider = await getAdminVisibleRider(agreement.user_id);
  if (!rider) return res.status(404).json({ error: 'Allocated rider not found' });

  const updates = [];
  const values = [];

  if (req.body.full_name !== undefined) {
    const fullName = String(req.body.full_name || '').trim();
    if (!fullName) return res.status(400).json({ error: 'Full name is required' });
    values.push(fullName);
    updates.push(`full_name = $${values.length}`);
  }

  if (req.body.email !== undefined) {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    const { rows: conflictRows } = await pgDb.query('SELECT id FROM users WHERE email = $1 AND id != $2 AND deleted_at IS NULL', [email, rider.id]);
    if (conflictRows[0]) return res.status(409).json({ error: 'Email already exists for another user' });
    values.push(email);
    updates.push(`email = $${values.length}`);
  }

  for (const field of ['phone', 'id_number', 'address', 'city', 'province']) {
    if (req.body[field] !== undefined) {
      values.push(String(req.body[field] || '').trim() || null);
      updates.push(`${field} = $${values.length}`);
    }
  }

  if (!updates.length) return res.json({ ok: true });

  values.push(rider.id);
  await pgDb.query(`UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length}`, values);
  await logAudit(req.user.id, 'bike.allocated_rider_update', 'users', rider.id, { bike_id: bikeId, agreement_id: agreement.id }, req.ip);
  res.json({ ok: true });
});

router.post('/:id/terminate-contract', authRequired, adminOnly, async (req, res) => {
  try {
    const bikeId = Number(req.params.id);
    if (!Number.isInteger(bikeId) || bikeId <= 0) {
      return res.status(400).json({ error: 'Invalid bike id' });
    }

    const bike = await getAdminVisibleBike(bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found' });

    const agreement = await getOpenAgreementForBike(bikeId);
    if (!agreement) return res.status(400).json({ error: 'This bike has no open contract to terminate' });

    const result = await discontinueAgreement({
      agreementId: agreement.id,
      reason: String(req.body.reason || 'manual_bike_contract_termination').trim() || 'manual_bike_contract_termination',
      actorId: req.user.id,
      ip: req.ip,
      auditAction: 'agreement.terminated_from_bike'
    });

    await pgDb.query(`UPDATE bikes SET status = 'active' WHERE id = $1`, [bikeId]);
    await logAudit(req.user.id, 'bike.terminate_contract', 'bikes', bikeId, {
      agreement_id: agreement.id,
      agreement_no: agreement.agreement_no,
      waived_schedule_rows: result.waived_rows || 0
    }, req.ip);

    res.json({ ok: true, agreement_id: agreement.id, agreement_no: agreement.agreement_no, waived_schedule_rows: result.waived_rows || 0 });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not terminate contract' });
  }
});

router.delete('/:id', authRequired, adminOnly, async (req, res) => {
  const bikeId = Number(req.params.id);
  if (!Number.isInteger(bikeId) || bikeId <= 0) {
    return res.status(400).json({ error: 'Invalid bike id' });
  }

  const bike = await getAdminVisibleBike(bikeId);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });
  if (await getOpenAgreementForBike(bikeId)) {
    return res.status(400).json({ error: 'Terminate the current contract before deleting this bike' });
  }

  const { rows: countRows } = await pgDb.query('SELECT COUNT(*) c FROM agreements WHERE bike_id = $1', [bikeId]);
  const agreementCount = Number(countRows[0]?.c) || 0;
  if (agreementCount > 0) {
    return res.status(400).json({ error: 'Bikes with agreement history cannot be deleted' });
  }

  await pgDb.withTransaction(async (client) => {
    await client.query('UPDATE applications SET preferred_bike_id = NULL WHERE preferred_bike_id = $1', [bikeId]);
    await client.query('DELETE FROM service_records WHERE bike_id = $1', [bikeId]);
    await client.query('DELETE FROM gps_pings WHERE bike_id = $1', [bikeId]);
    await client.query('DELETE FROM bikes WHERE id = $1', [bikeId]);
  });

  await logAudit(req.user.id, 'bike.delete', 'bikes', bikeId, { registration: bike.registration || null, vin: bike.vin }, req.ip);
  res.json({ ok: true });
});

router.post('/:id/image', authRequired, adminOnly, bikeImageUpload.single('image'), requireValidMime(['image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image file is required' });
  const publicPath = `/uploads/bikes/${req.file.filename}`;
  await pgDb.query('UPDATE bikes SET image_url = $1 WHERE id = $2', [publicPath, req.params.id]);
  await logAudit(req.user.id, 'bike.image_upload', 'bikes', Number(req.params.id), { image_url: publicPath });
  res.json({ image_url: publicPath });
});

router.post('/:id/documents/:documentType', authRequired, adminOnly, bikeDocumentUpload.single('file'), requireValidMime(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A document file is required' });
  const { rows: bikeRows } = await pgDb.query('SELECT id FROM bikes WHERE id = $1', [req.params.id]);
  if (!bikeRows[0]) return res.status(404).json({ error: 'Bike not found' });

  const documentType = String(req.params.documentType || '').trim().toLowerCase();
  const publicPath = `/uploads/bike-documents/${req.file.filename}`;

  if (documentType === 'rc1') {
    await pgDb.query('UPDATE bikes SET rc1_file_path = $1, rc1_original_name = $2 WHERE id = $3', [publicPath, req.file.originalname, req.params.id]);
    await logAudit(req.user.id, 'bike.rc1_upload', 'bikes', Number(req.params.id), { rc1_file_path: publicPath });
    return res.json({ ok: true, rc1_file_path: publicPath, rc1_original_name: req.file.originalname });
  }

  if (documentType === 'license_disc') {
    const extracted = await extractLicenseDiscInsights(req.file.path, req.file.mimetype);
    await pgDb.query(`UPDATE bikes
      SET license_disc_file_path = $1,
          license_disc_original_name = $2,
          license_disc_no = COALESCE($3, license_disc_no),
          license_disc_expiry = COALESCE($4, license_disc_expiry)
      WHERE id = $5`, [
      publicPath,
      req.file.originalname,
      extracted.license_disc_no || null,
      extracted.license_disc_expiry || null,
      req.params.id
    ]);
    await logAudit(req.user.id, 'bike.license_disc_upload', 'bikes', Number(req.params.id), {
      license_disc_file_path: publicPath,
      extracted_license_disc_no: extracted.license_disc_no || null,
      extracted_license_disc_expiry: extracted.license_disc_expiry || null
    });
    return res.json({
      ok: true,
      license_disc_file_path: publicPath,
      license_disc_original_name: req.file.originalname,
      license_disc_no: extracted.license_disc_no || null,
      license_disc_expiry: extracted.license_disc_expiry || null,
      extraction_error: extracted.extraction_error || null
    });
  }

  if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  return res.status(400).json({ error: 'Unsupported document type' });
});

router.post('/:id/ping', authRequired, adminOnly, async (req, res) => {
  const { lat, lng, speed_kmh, heading } = req.body;
  const { rows: bikeRows } = await pgDb.query('SELECT id FROM bikes WHERE id = $1', [req.params.id]);
  const bike = bikeRows[0];
  if (!bike) return res.status(404).end();
  await pgDb.query(`INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, heading) VALUES ($1,$2,$3,$4,$5)`, [bike.id, lat, lng, speed_kmh || null, heading || null]);
  await pgDb.query(`UPDATE bikes SET last_known_lat = $1, last_known_lng = $2, last_location_at = CURRENT_TIMESTAMP WHERE id = $3`, [lat, lng, bike.id]);
  res.json({ ok: true });
});

router.post('/:id/service', authRequired, adminOnly, invoiceUpload.single('invoice'), async (req, res) => {
  const b = req.body;
  const publicInvoice = req.file ? `/uploads/service-invoices/${req.file.filename}` : null;
  const { rows } = await pgDb.query(`INSERT INTO service_records
    (bike_id, agreement_id, service_date, odometer_km, service_type, description, cost, next_service_km, next_service_date, performed_by, invoice_file_path, invoice_original_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id`, [
      req.params.id,
      b.agreement_id || null,
      b.service_date,
      b.odometer_km || null,
      b.service_type,
      b.description || null,
      b.cost || 0,
      b.next_service_km || null,
      b.next_service_date || null,
      b.performed_by || null,
      publicInvoice,
      req.file?.originalname || null
    ]);
  const id = rows[0].id;

  await pgDb.query(`UPDATE bikes SET next_service_km = COALESCE($1, next_service_km), next_service_date = COALESCE($2, next_service_date), odometer_km = COALESCE($3, odometer_km) WHERE id = $4`,
    [b.next_service_km || null, b.next_service_date || null, b.odometer_km || null, req.params.id]);

  await logAudit(req.user.id, 'bike.service', 'service_records', id, { bike_id: Number(req.params.id), invoice: publicInvoice });
  res.json({ id, invoice_file_path: publicInvoice });
});

router.delete('/:id/service/:serviceId', authRequired, adminOnly, async (req, res) => {
  const { rows: serviceRows } = await pgDb.query('SELECT id, bike_id FROM service_records WHERE id = $1', [req.params.serviceId]);
  const service = serviceRows[0];
  if (!service || Number(service.bike_id) !== Number(req.params.id)) {
    return res.status(404).json({ error: 'Service record not found' });
  }
  await pgDb.query('DELETE FROM service_records WHERE id = $1', [req.params.serviceId]);
  await logAudit(req.user.id, 'bike.service_delete', 'service_records', Number(req.params.serviceId), { bike_id: Number(req.params.id) });
  res.json({ ok: true });
});

module.exports = router;

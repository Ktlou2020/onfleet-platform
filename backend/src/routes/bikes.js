const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, generateAgreementNo, buildPaymentSchedule, addDays } = require('../utils/helpers');
const { setBikeStatus } = require('../utils/bikeStatus');
const { discontinueAgreementForStolenBike, discontinueAgreement } = require('../services/agreementLifecycle');
const { extractLicenseDiscInsights } = require('../services/documentInsights');
const { writeContractSnapshot } = require('../services/contracts');

const router = express.Router();
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

const OPEN_AGREEMENT_STATUSES = ['active', 'paused', 'defaulted'];
const OPEN_AGREEMENT_STATUSES_SQL = "('active','paused','defaulted')";
const ALLOCATION_ELIGIBLE_BIKE_STATUSES = ['ready_to_go', 'active'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function superadminOnly(req, res, next) {
  if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function getSetting(key) {
  return db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(key)?.setting_value || null;
}

function computeBikeRoi(bikeId) {
  const revenue = db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(p.net_amount,0), p.amount)),0) total FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    WHERE a.bike_id = ? AND p.status = 'success'`).get(bikeId).total || 0;
  const serviceCost = db.prepare(`SELECT COALESCE(SUM(cost),0) total FROM service_records WHERE bike_id = ?`).get(bikeId).total || 0;
  const bike = db.prepare(`SELECT purchase_price FROM bikes WHERE id = ?`).get(bikeId);
  const purchasePrice = Number(bike?.purchase_price || 0);
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

function listCatalogValues(column, whereClauses = [], params = []) {
  const sql = `SELECT DISTINCT b.${column} AS value
    FROM bikes b
    WHERE b.status = 'ready_to_go'
      AND ${adminVisibleBikeClause('b')}
      ${whereClauses.length ? `AND ${whereClauses.join(' AND ')}` : ''}
      AND COALESCE(TRIM(b.${column}), '') <> ''
    ORDER BY b.${column}`;
  return db.prepare(sql).all(...params).map((row) => row.value);
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

function getAdminVisibleBike(bikeId) {
  return db.prepare(`${bikeSelectSql} WHERE b.id = ? AND ${adminVisibleBikeClause('b')}`).get(bikeId);
}

function getAdminVisibleRider(riderId) {
  return db.prepare(`SELECT *
    FROM users
    WHERE id = ?
      AND role = 'rider'
      AND deleted_at IS NULL
      AND organization_id IS NULL`).get(riderId);
}

function getOpenAgreementForBike(bikeId) {
  return db.prepare(`SELECT *
    FROM agreements
    WHERE bike_id = ? AND status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1`).get(bikeId);
}

function getOpenAgreementForRider(riderId) {
  return db.prepare(`SELECT *
    FROM agreements
    WHERE user_id = ? AND status IN ${OPEN_AGREEMENT_STATUSES_SQL}
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1`).get(riderId);
}

router.get('/catalog', (req, res) => {
  const make = String(req.query.make || '').trim();
  const model = String(req.query.model || '').trim();
  const condition = String(req.query.condition || '').trim();
  const whereClauses = [`b.status = 'ready_to_go'`, adminVisibleBikeClause('b')];
  const params = [];

  if (make) {
    whereClauses.push('b.make = ?');
    params.push(make);
  }
  if (model) {
    whereClauses.push('b.model = ?');
    params.push(model);
  }
  if (condition) {
    whereClauses.push('b.condition = ?');
    params.push(condition);
  }

  const bikes = db.prepare(`SELECT b.id, b.make, b.model, b.year, b.engine_cc, b.condition, b.rental_weekly, b.total_weeks, b.image_url, b.status, b.registration
    FROM bikes b
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY b.make, b.model, b.year DESC, b.id DESC`).all(...params);

  const modelWhereClauses = [];
  const modelParams = [];
  if (make) {
    modelWhereClauses.push('make = ?');
    modelParams.push(make);
  }

  const conditionWhereClauses = [];
  const conditionParams = [];
  if (make) {
    conditionWhereClauses.push('make = ?');
    conditionParams.push(make);
  }
  if (model) {
    conditionWhereClauses.push('model = ?');
    conditionParams.push(model);
  }

  res.json({
    bikes,
    filters: {
      makes: listCatalogValues('make'),
      models: listCatalogValues('model', modelWhereClauses, modelParams),
      conditions: listCatalogValues('condition', conditionWhereClauses, conditionParams)
    },
    hero_image_url: getSetting('landing_hero_image_url')
  });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const status = String(req.query.status || '').trim();
  const fleet = String(req.query.fleet || '').trim();
  const clauses = [adminVisibleBikeClause('b')];
  const params = [];

  if (status) {
    clauses.push('b.status = ?');
    params.push(status);
  }
  if (fleet) {
    clauses.push('COALESCE(TRIM(b.fleet), \'\') = ?');
    params.push(fleet);
  }

  const sql = `${bikeSelectSql} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY b.id DESC`;
  const bikes = db.prepare(sql).all(...params);
  res.json({ bikes });
});

router.post('/document-insights/license-disc', authRequired, adminOnly, bikeDocumentUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A document file is required' });
  const extracted = await extractLicenseDiscInsights(req.file.path, req.file.mimetype);
  fs.unlink(req.file.path, () => {});
  res.json({
    ok: true,
    license_disc_no: extracted.license_disc_no || null,
    license_disc_expiry: extracted.license_disc_expiry || null,
    extraction_error: extracted.extraction_error || null
  });
});

router.get('/:id', authRequired, (req, res) => {
  const isAdminPortalUser = ['admin', 'superadmin'].includes(req.user.role);
  const bike = db.prepare(`${bikeSelectSql} WHERE b.id = ?${isAdminPortalUser ? ` AND ${adminVisibleBikeClause('b')}` : ''}`).get(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Not found' });

  if (!isAdminPortalUser) {
    const owns = db.prepare(`SELECT 1 FROM agreements WHERE bike_id = ? AND user_id = ? AND status = 'active'`).get(req.params.id, req.user.id);
    if (!owns) return res.status(403).json({ error: 'Forbidden' });
  }

  const services = db.prepare(`SELECT * FROM service_records WHERE bike_id = ? ORDER BY service_date DESC LIMIT 50`).all(req.params.id);
  const lastPings = db.prepare(`SELECT lat, lng, speed_kmh, recorded_at FROM gps_pings WHERE bike_id = ? ORDER BY recorded_at DESC LIMIT 50`).all(req.params.id);
  const payload = { bike, services, gps_history: lastPings };
  if (isAdminPortalUser) payload.roi = computeBikeRoi(req.params.id);
  res.json(payload);
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO bikes
    (vin, registration, make, model, fleet, organization_id, year, engine_cc, color, condition, purchase_price,
     rental_weekly, total_weeks, status, gps_device_id, odometer_km, insurance_provider,
     insurance_policy_no, insurance_expiry, license_disc_no, license_disc_expiry, image_url, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
    );
  logAudit(req.user.id, 'bike.create', 'bikes', info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid });
});

router.put('/:id', authRequired, adminOnly, (req, res) => {
  const allowed = ['registration', 'make', 'model', 'fleet', 'organization_id', 'year', 'engine_cc', 'color', 'condition', 'purchase_price', 'rental_weekly', 'total_weeks', 'gps_device_id', 'odometer_km', 'next_service_km', 'next_service_date', 'insurance_provider', 'insurance_policy_no', 'insurance_expiry', 'license_disc_no', 'license_disc_expiry', 'image_url', 'notes'];
  const sets = [];
  const vals = [];
  let statusMeta = null;

  if (req.body.status !== undefined) {
    try {
      statusMeta = setBikeStatus(req.params.id, req.body.status);
      if (statusMeta?.next_status === 'stolen') {
        const discontinued = discontinueAgreementForStolenBike({ bikeId: Number(req.params.id), actorId: req.user.id, ip: req.ip });
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
      sets.push(`${key} = ?`);
      vals.push(['fleet', 'organization_id'].includes(key) ? (req.body[key] || null) : req.body[key]);
    }
  }

  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE bikes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  if (!sets.length && !statusMeta) return res.json({ ok: true });
  logAudit(req.user.id, 'bike.update', 'bikes', Number(req.params.id), { ...req.body, ...(statusMeta || {}) });
  res.json({ ok: true, ...(statusMeta || {}) });
});


router.post('/:id/allocate', authRequired, adminOnly, (req, res) => {
  try {
    const bikeId = Number(req.params.id);
    const riderId = Number(req.body.rider_id);
    const startDate = String(req.body.start_date || todayIso()).slice(0, 10);
    const note = String(req.body.notes || '').trim() || null;

    if (!Number.isInteger(bikeId) || bikeId <= 0 || !Number.isInteger(riderId) || riderId <= 0) {
      return res.status(400).json({ error: 'Bike and rider are required' });
    }

    const bike = getAdminVisibleBike(bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found' });
    if (!ALLOCATION_ELIGIBLE_BIKE_STATUSES.includes(String(bike.status || ''))) {
      return res.status(400).json({ error: 'Bike must be active or ready to go before allocation' });
    }
    if (getOpenAgreementForBike(bikeId)) {
      return res.status(400).json({ error: 'This bike already has an allocated rider' });
    }

    const rider = getAdminVisibleRider(riderId);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    if (getOpenAgreementForRider(riderId)) {
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

    const matchingApplication = db.prepare(`SELECT ap.*
      FROM applications ap
      LEFT JOIN bikes pref ON pref.id = ap.preferred_bike_id
      WHERE ap.user_id = ?
        AND ap.status IN ('approved', 'submitted', 'under_review')
        AND (ap.preferred_bike_id = ? OR ap.preferred_bike_id IS NULL OR pref.organization_id IS NULL)
      ORDER BY CASE WHEN ap.preferred_bike_id = ? THEN 0 ELSE 1 END, ap.submitted_at DESC, ap.id DESC
      LIMIT 1`).get(riderId, bikeId, bikeId);

    const totalAmount = +(weeklyAmount * totalWeeks).toFixed(2);
    const endDate = addDays(startDate, totalWeeks * 7);
    const agreementNo = generateAgreementNo();

    const agreementId = db.transaction(() => {
      if (matchingApplication?.id) {
        db.prepare(`UPDATE applications
          SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = NULL
          WHERE id = ?`).run(req.user.id, matchingApplication.id);
      }
      const info = db.prepare(`INSERT INTO agreements
        (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, notes, created_by)
        VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, ?)`).run(
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
        );
      buildPaymentSchedule(info.lastInsertRowid, weeklyAmount, totalWeeks, startDate);
      db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(bikeId);
      return info.lastInsertRowid;
    })();

    const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreementId);
    const contractPath = writeContractSnapshot({ agreement, rider, bike, application: matchingApplication || null, kind: 'unsigned' });
    db.prepare(`UPDATE agreements SET contract_file_path = ?, contract_pdf_path = ? WHERE id = ?`).run(contractPath, contractPath, agreementId);

    if (matchingApplication?.id) {
      db.prepare(`INSERT INTO application_documents
        (application_id, user_id, doc_type, file_path, original_name, mime_type, status, uploaded_by)
        VALUES (?,?,?,?,?,?,?,?)`).run(
          matchingApplication.id,
          riderId,
          'unsigned_contract',
          contractPath,
          `${agreementNo}-contract.html`,
          'text/html',
          'verified',
          req.user.id
        );
    }

    logAudit(req.user.id, 'bike.allocate_rider', 'agreements', agreementId, {
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

router.patch('/:id/allocated-rider', authRequired, adminOnly, (req, res) => {
  const bikeId = Number(req.params.id);
  if (!Number.isInteger(bikeId) || bikeId <= 0) {
    return res.status(400).json({ error: 'Invalid bike id' });
  }

  const bike = getAdminVisibleBike(bikeId);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  const agreement = getOpenAgreementForBike(bikeId);
  if (!agreement) return res.status(400).json({ error: 'No allocated rider found for this bike' });

  const rider = getAdminVisibleRider(agreement.user_id);
  if (!rider) return res.status(404).json({ error: 'Allocated rider not found' });

  const updates = [];
  const values = [];

  if (req.body.full_name !== undefined) {
    const fullName = String(req.body.full_name || '').trim();
    if (!fullName) return res.status(400).json({ error: 'Full name is required' });
    updates.push('full_name = ?');
    values.push(fullName);
  }

  if (req.body.email !== undefined) {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ? AND deleted_at IS NULL').get(email, rider.id);
    if (conflict) return res.status(409).json({ error: 'Email already exists for another user' });
    updates.push('email = ?');
    values.push(email);
  }

  for (const field of ['phone', 'id_number', 'address', 'city', 'province']) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(String(req.body[field] || '').trim() || null);
    }
  }

  if (!updates.length) return res.json({ ok: true });

  db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, rider.id);
  logAudit(req.user.id, 'bike.allocated_rider_update', 'users', rider.id, { bike_id: bikeId, agreement_id: agreement.id }, req.ip);
  res.json({ ok: true });
});

router.post('/:id/terminate-contract', authRequired, adminOnly, (req, res) => {
  try {
    const bikeId = Number(req.params.id);
    if (!Number.isInteger(bikeId) || bikeId <= 0) {
      return res.status(400).json({ error: 'Invalid bike id' });
    }

    const bike = getAdminVisibleBike(bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found' });

    const agreement = getOpenAgreementForBike(bikeId);
    if (!agreement) return res.status(400).json({ error: 'This bike has no open contract to terminate' });

    const result = discontinueAgreement({
      agreementId: agreement.id,
      reason: String(req.body.reason || 'manual_bike_contract_termination').trim() || 'manual_bike_contract_termination',
      actorId: req.user.id,
      ip: req.ip,
      auditAction: 'agreement.terminated_from_bike'
    });

    db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(bikeId);
    logAudit(req.user.id, 'bike.terminate_contract', 'bikes', bikeId, {
      agreement_id: agreement.id,
      agreement_no: agreement.agreement_no,
      waived_schedule_rows: result.waived_rows || 0
    }, req.ip);

    res.json({ ok: true, agreement_id: agreement.id, agreement_no: agreement.agreement_no, waived_schedule_rows: result.waived_rows || 0 });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not terminate contract' });
  }
});

router.delete('/:id', authRequired, adminOnly, (req, res) => {
  const bikeId = Number(req.params.id);
  if (!Number.isInteger(bikeId) || bikeId <= 0) {
    return res.status(400).json({ error: 'Invalid bike id' });
  }

  const bike = getAdminVisibleBike(bikeId);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });
  if (getOpenAgreementForBike(bikeId)) {
    return res.status(400).json({ error: 'Terminate the current contract before deleting this bike' });
  }

  const agreementCount = db.prepare('SELECT COUNT(*) c FROM agreements WHERE bike_id = ?').get(bikeId).c || 0;
  if (agreementCount > 0) {
    return res.status(400).json({ error: 'Bikes with agreement history cannot be deleted' });
  }

  db.transaction(() => {
    db.prepare('UPDATE applications SET preferred_bike_id = NULL WHERE preferred_bike_id = ?').run(bikeId);
    db.prepare('DELETE FROM service_records WHERE bike_id = ?').run(bikeId);
    db.prepare('DELETE FROM gps_pings WHERE bike_id = ?').run(bikeId);
    db.prepare('DELETE FROM bikes WHERE id = ?').run(bikeId);
  })();

  logAudit(req.user.id, 'bike.delete', 'bikes', bikeId, { registration: bike.registration || null, vin: bike.vin }, req.ip);
  res.json({ ok: true });
});

router.post('/:id/image', authRequired, adminOnly, bikeImageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image file is required' });
  const publicPath = `/uploads/bikes/${req.file.filename}`;
  db.prepare('UPDATE bikes SET image_url = ? WHERE id = ?').run(publicPath, req.params.id);
  logAudit(req.user.id, 'bike.image_upload', 'bikes', Number(req.params.id), { image_url: publicPath });
  res.json({ image_url: publicPath });
});

router.post('/:id/documents/:documentType', authRequired, adminOnly, bikeDocumentUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A document file is required' });
  const bike = db.prepare('SELECT id FROM bikes WHERE id = ?').get(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  const documentType = String(req.params.documentType || '').trim().toLowerCase();
  const publicPath = `/uploads/bike-documents/${req.file.filename}`;

  if (documentType === 'rc1') {
    db.prepare('UPDATE bikes SET rc1_file_path = ?, rc1_original_name = ? WHERE id = ?').run(publicPath, req.file.originalname, req.params.id);
    logAudit(req.user.id, 'bike.rc1_upload', 'bikes', Number(req.params.id), { rc1_file_path: publicPath });
    return res.json({ ok: true, rc1_file_path: publicPath, rc1_original_name: req.file.originalname });
  }

  if (documentType === 'license_disc') {
    const extracted = await extractLicenseDiscInsights(req.file.path, req.file.mimetype);
    db.prepare(`UPDATE bikes
      SET license_disc_file_path = ?,
          license_disc_original_name = ?,
          license_disc_no = COALESCE(?, license_disc_no),
          license_disc_expiry = COALESCE(?, license_disc_expiry)
      WHERE id = ?`).run(
      publicPath,
      req.file.originalname,
      extracted.license_disc_no || null,
      extracted.license_disc_expiry || null,
      req.params.id
    );
    logAudit(req.user.id, 'bike.license_disc_upload', 'bikes', Number(req.params.id), {
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

router.post('/:id/ping', (req, res) => {
  const { lat, lng, speed_kmh, heading } = req.body;
  const bike = db.prepare('SELECT id FROM bikes WHERE id = ?').get(req.params.id);
  if (!bike) return res.status(404).end();
  db.prepare(`INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, heading) VALUES (?,?,?,?,?)`).run(bike.id, lat, lng, speed_kmh || null, heading || null);
  db.prepare(`UPDATE bikes SET last_known_lat = ?, last_known_lng = ?, last_location_at = CURRENT_TIMESTAMP WHERE id = ?`).run(lat, lng, bike.id);
  res.json({ ok: true });
});

router.post('/:id/service', authRequired, adminOnly, invoiceUpload.single('invoice'), (req, res) => {
  const b = req.body;
  const publicInvoice = req.file ? `/uploads/service-invoices/${req.file.filename}` : null;
  const info = db.prepare(`INSERT INTO service_records
    (bike_id, agreement_id, service_date, odometer_km, service_type, description, cost, next_service_km, next_service_date, performed_by, invoice_file_path, invoice_original_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
    );

  db.prepare(`UPDATE bikes SET next_service_km = COALESCE(?, next_service_km), next_service_date = COALESCE(?, next_service_date), odometer_km = COALESCE(?, odometer_km) WHERE id = ?`)
    .run(b.next_service_km || null, b.next_service_date || null, b.odometer_km || null, req.params.id);

  logAudit(req.user.id, 'bike.service', 'service_records', info.lastInsertRowid, { bike_id: Number(req.params.id), invoice: publicInvoice });
  res.json({ id: info.lastInsertRowid, invoice_file_path: publicInvoice });
});

router.delete('/:id/service/:serviceId', authRequired, adminOnly, (req, res) => {
  const service = db.prepare('SELECT id, bike_id FROM service_records WHERE id = ?').get(req.params.serviceId);
  if (!service || Number(service.bike_id) !== Number(req.params.id)) {
    return res.status(404).json({ error: 'Service record not found' });
  }
  db.prepare('DELETE FROM service_records WHERE id = ?').run(req.params.serviceId);
  logAudit(req.user.id, 'bike.service_delete', 'service_records', Number(req.params.serviceId), { bike_id: Number(req.params.id) });
  res.json({ ok: true });
});

module.exports = router;

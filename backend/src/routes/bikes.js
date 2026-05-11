const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');
const { setBikeStatus } = require('../utils/bikeStatus');
const { extractLicenseDiscInsights } = require('../services/documentInsights');

const router = express.Router();
const bikeUploadDir = path.join(__dirname, '../../uploads/bikes');
const invoiceUploadDir = path.join(__dirname, '../../uploads/service-invoices');
const bikeDocumentUploadDir = path.join(__dirname, '../../uploads/bike-documents');
fs.mkdirSync(bikeUploadDir, { recursive: true });
fs.mkdirSync(invoiceUploadDir, { recursive: true });
fs.mkdirSync(bikeDocumentUploadDir, { recursive: true });

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
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function superadminOnly(req, res, next) {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });
  next();
}

function getSetting(key) {
  return db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(key)?.setting_value || null;
}

function computeBikeRoi(bikeId) {
  const revenue = db.prepare(`SELECT COALESCE(SUM(COALESCE(p.net_amount, p.amount)),0) total FROM payments p
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
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_name,
  (
    SELECT u.phone FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_phone,
  (
    SELECT u.avatar_url FROM agreements a
    JOIN users u ON u.id = a.user_id
    WHERE a.bike_id = b.id
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_rider_avatar_url,
  (
    SELECT a.agreement_no FROM agreements a
    WHERE a.bike_id = b.id
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.created_at DESC
    LIMIT 1
  ) AS allocated_agreement_no
FROM bikes b`;

function listCatalogValues(column, whereClauses = [], params = []) {
  const sql = `SELECT DISTINCT ${column} AS value
    FROM bikes
    WHERE status = 'ready_to_go'
      ${whereClauses.length ? `AND ${whereClauses.join(' AND ')}` : ''}
      AND COALESCE(TRIM(${column}), '') <> ''
    ORDER BY ${column}`;
  return db.prepare(sql).all(...params).map((row) => row.value);
}

router.get('/catalog', (req, res) => {
  const make = String(req.query.make || '').trim();
  const model = String(req.query.model || '').trim();
  const condition = String(req.query.condition || '').trim();
  const whereClauses = [`status = 'ready_to_go'`];
  const params = [];

  if (make) {
    whereClauses.push('make = ?');
    params.push(make);
  }
  if (model) {
    whereClauses.push('model = ?');
    params.push(model);
  }
  if (condition) {
    whereClauses.push('condition = ?');
    params.push(condition);
  }

  const bikes = db.prepare(`SELECT id, make, model, year, engine_cc, condition, rental_weekly, total_weeks, image_url, status, registration
    FROM bikes
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY make, model, year DESC, id DESC`).all(...params);

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
  const status = req.query.status;
  const sql = `${bikeSelectSql} ${status ? 'WHERE b.status = ?' : ''} ORDER BY b.id DESC`;
  const bikes = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  res.json({ bikes });
});

router.post('/document-insights/license-disc', authRequired, superadminOnly, bikeDocumentUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file is required' });
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
  const bike = db.prepare(`${bikeSelectSql} WHERE b.id = ?`).get(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Not found' });

  if (!['admin', 'superadmin'].includes(req.user.role)) {
    const owns = db.prepare(`SELECT 1 FROM agreements WHERE bike_id = ? AND user_id = ? AND status = 'active'`).get(req.params.id, req.user.id);
    if (!owns) return res.status(403).json({ error: 'Forbidden' });
  }

  const services = db.prepare(`SELECT * FROM service_records WHERE bike_id = ? ORDER BY service_date DESC LIMIT 50`).all(req.params.id);
  const lastPings = db.prepare(`SELECT lat, lng, speed_kmh, recorded_at FROM gps_pings WHERE bike_id = ? ORDER BY recorded_at DESC LIMIT 50`).all(req.params.id);
  const payload = { bike, services, gps_history: lastPings };
  if (['admin', 'superadmin'].includes(req.user.role)) payload.roi = computeBikeRoi(req.params.id);
  res.json(payload);
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO bikes
    (vin, registration, make, model, year, engine_cc, color, condition, purchase_price,
     rental_weekly, total_weeks, status, gps_device_id, odometer_km, insurance_provider,
     insurance_policy_no, insurance_expiry, license_disc_no, license_disc_expiry, image_url, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      b.vin,
      b.registration || null,
      b.make,
      b.model,
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
  const allowed = ['registration', 'make', 'model', 'year', 'engine_cc', 'color', 'condition', 'purchase_price', 'rental_weekly', 'total_weeks', 'gps_device_id', 'odometer_km', 'next_service_km', 'next_service_date', 'insurance_provider', 'insurance_policy_no', 'insurance_expiry', 'license_disc_no', 'license_disc_expiry', 'image_url', 'notes'];
  const sets = [];
  const vals = [];
  let statusMeta = null;

  if (req.body.status !== undefined) {
    try {
      statusMeta = setBikeStatus(req.params.id, req.body.status);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(req.body[key]);
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

router.post('/:id/image', authRequired, adminOnly, bikeImageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image file is required' });
  const publicPath = `/uploads/bikes/${req.file.filename}`;
  db.prepare('UPDATE bikes SET image_url = ? WHERE id = ?').run(publicPath, req.params.id);
  logAudit(req.user.id, 'bike.image_upload', 'bikes', Number(req.params.id), { image_url: publicPath });
  res.json({ image_url: publicPath });
});

router.post('/:id/documents/:documentType', authRequired, superadminOnly, bikeDocumentUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file is required' });
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

  fs.unlinkSync(req.file.path);
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

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');

const router = express.Router();
const bikeUploadDir = path.join(__dirname, '../../uploads/bikes');
const invoiceUploadDir = path.join(__dirname, '../../uploads/service-invoices');
fs.mkdirSync(bikeUploadDir, { recursive: true });
fs.mkdirSync(invoiceUploadDir, { recursive: true });

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

function computeBikeRoi(bikeId) {
  const revenue = db.prepare(`SELECT COALESCE(SUM(p.amount),0) total FROM payments p
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

router.get('/catalog', (req, res) => {
  const bikes = db.prepare(`SELECT id, make, model, year, engine_cc, condition, rental_weekly, total_weeks, image_url
    FROM bikes WHERE status = 'available' ORDER BY make, model`).all();
  res.json({ bikes });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const status = req.query.status;
  const bikes = status ? db.prepare('SELECT * FROM bikes WHERE status = ? ORDER BY id DESC').all(status) : db.prepare('SELECT * FROM bikes ORDER BY id DESC').all();
  res.json({ bikes });
});

router.get('/:id', authRequired, (req, res) => {
  const bike = db.prepare('SELECT * FROM bikes WHERE id = ?').get(req.params.id);
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
     insurance_policy_no, insurance_expiry, image_url, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
      b.status || 'available',
      b.gps_device_id || null,
      b.odometer_km || 0,
      b.insurance_provider || null,
      b.insurance_policy_no || null,
      b.insurance_expiry || null,
      b.image_url || null,
      b.notes || null
    );
  logAudit(req.user.id, 'bike.create', 'bikes', info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid });
});

router.put('/:id', authRequired, adminOnly, (req, res) => {
  const allowed = ['registration','make','model','year','engine_cc','color','condition','purchase_price','rental_weekly','total_weeks','status','gps_device_id','odometer_km','next_service_km','next_service_date','insurance_provider','insurance_policy_no','insurance_expiry','image_url','notes'];
  const sets = [];
  const vals = [];
  for (const key of allowed) if (req.body[key] !== undefined) { sets.push(`${key} = ?`); vals.push(req.body[key]); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE bikes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  logAudit(req.user.id, 'bike.update', 'bikes', Number(req.params.id), req.body);
  res.json({ ok: true });
});

router.post('/:id/image', authRequired, adminOnly, bikeImageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image file is required' });
  const publicPath = `/uploads/bikes/${req.file.filename}`;
  db.prepare('UPDATE bikes SET image_url = ? WHERE id = ?').run(publicPath, req.params.id);
  logAudit(req.user.id, 'bike.image_upload', 'bikes', Number(req.params.id), { image_url: publicPath });
  res.json({ image_url: publicPath });
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

module.exports = router;

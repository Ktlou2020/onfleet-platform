const express = require('express');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');

const router = express.Router();

// Public list of available bikes (for signup catalog)
router.get('/catalog', (req, res) => {
  const bikes = db.prepare(`SELECT id, make, model, year, engine_cc, condition, rental_weekly,
                            total_weeks, image_url FROM bikes
                            WHERE status = 'available' ORDER BY make, model`).all();
  res.json({ bikes });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const status = req.query.status;
  const bikes = status
    ? db.prepare('SELECT * FROM bikes WHERE status = ? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM bikes ORDER BY id DESC').all();
  res.json({ bikes });
});

router.get('/:id', authRequired, (req, res) => {
  const bike = db.prepare('SELECT * FROM bikes WHERE id = ?').get(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Not found' });

  // Riders can only view their assigned bike
  if (!['admin','superadmin'].includes(req.user.role)) {
    const owns = db.prepare(`SELECT 1 FROM agreements WHERE bike_id = ? AND user_id = ? AND status = 'active'`)
                    .get(req.params.id, req.user.id);
    if (!owns) return res.status(403).json({ error: 'Forbidden' });
  }

  const services = db.prepare(`SELECT * FROM service_records WHERE bike_id = ? ORDER BY service_date DESC LIMIT 20`)
                      .all(req.params.id);
  const lastPings = db.prepare(`SELECT lat,lng,speed_kmh,recorded_at FROM gps_pings
                                WHERE bike_id = ? ORDER BY recorded_at DESC LIMIT 50`).all(req.params.id);
  res.json({ bike, services, gps_history: lastPings });
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO bikes
    (vin, registration, make, model, year, engine_cc, color, condition, purchase_price,
     rental_weekly, total_weeks, status, gps_device_id, odometer_km,
     insurance_provider, insurance_policy_no, insurance_expiry, image_url, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      b.vin, b.registration || null, b.make, b.model, b.year || null, b.engine_cc || null,
      b.color || null, b.condition || 'new', b.purchase_price || null,
      b.rental_weekly, b.total_weeks || 78, b.status || 'available', b.gps_device_id || null,
      b.odometer_km || 0, b.insurance_provider || null, b.insurance_policy_no || null,
      b.insurance_expiry || null, b.image_url || null, b.notes || null);
  logAudit(req.user.id, 'bike.create', 'bikes', info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid });
});

router.put('/:id', authRequired, adminOnly, (req, res) => {
  const allowed = ['registration','make','model','year','engine_cc','color','condition','purchase_price',
                   'rental_weekly','total_weeks','status','gps_device_id','odometer_km',
                   'next_service_km','next_service_date','insurance_provider','insurance_policy_no',
                   'insurance_expiry','image_url','notes'];
  const sets = [], vals = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.body[k]); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE bikes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  logAudit(req.user.id, 'bike.update', 'bikes', +req.params.id, req.body);
  res.json({ ok: true });
});

// GPS ping ingest (from device or simulator)
router.post('/:id/ping', (req, res) => {
  const { lat, lng, speed_kmh, heading, device_token } = req.body;
  // In production validate device_token
  const bike = db.prepare('SELECT id, gps_device_id FROM bikes WHERE id = ?').get(req.params.id);
  if (!bike) return res.status(404).end();
  db.prepare(`INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, heading) VALUES (?,?,?,?,?)`)
    .run(bike.id, lat, lng, speed_kmh || null, heading || null);
  db.prepare(`UPDATE bikes SET last_known_lat = ?, last_known_lng = ?, last_location_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(lat, lng, bike.id);
  res.json({ ok: true });
});

// Service records
router.post('/:id/service', authRequired, adminOnly, (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO service_records
    (bike_id, agreement_id, service_date, odometer_km, service_type, description, cost,
     next_service_km, next_service_date, performed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      req.params.id, b.agreement_id || null, b.service_date, b.odometer_km || null,
      b.service_type, b.description || null, b.cost || 0, b.next_service_km || null,
      b.next_service_date || null, b.performed_by || null);

  if (b.next_service_km || b.next_service_date) {
    db.prepare(`UPDATE bikes SET next_service_km = COALESCE(?, next_service_km),
                next_service_date = COALESCE(?, next_service_date), odometer_km = COALESCE(?, odometer_km)
                WHERE id = ?`).run(b.next_service_km || null, b.next_service_date || null,
                                   b.odometer_km || null, req.params.id);
  }
  logAudit(req.user.id, 'bike.service', 'service_records', info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid });
});

module.exports = router;

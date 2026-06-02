const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

function apiKeyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const rawKey = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!rawKey) return res.status(401).json({ error: 'Missing API key' });
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const key = db.prepare(`SELECT ak.*, o.id AS org_id FROM api_keys ak JOIN organizations o ON o.id = ak.organization_id WHERE ak.key_hash = ? AND ak.revoked_at IS NULL`).get(keyHash);
  if (!key) return res.status(401).json({ error: 'Invalid or revoked API key' });
  db.prepare(`UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(key.id);
  req.apiKey = key;
  req.orgId = key.org_id;
  next();
}

router.use(apiKeyAuth);

router.get('/bikes', (req, res) => {
  try {
    const bikes = db.prepare(`SELECT b.id, b.registration, b.make, b.model, b.year, b.fleet, b.status, b.rental_weekly, b.total_weeks, b.odometer_km, b.next_service_date, b.hub_id, b.created_at
      FROM bikes b WHERE b.organization_id = ? ORDER BY b.status ASC, b.registration ASC, b.id DESC`).all(req.orgId);
    res.json({ bikes });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not load bikes' });
  }
});

router.get('/agreements', (req, res) => {
  try {
    const agreements = db.prepare(`SELECT a.id, a.agreement_no, a.status, a.weekly_amount, a.total_weeks, a.total_amount, a.start_date, a.end_date, a.created_at,
        b.registration AS bike_registration, b.make, b.model,
        u.full_name AS rider_name, u.email AS rider_email,
        COALESCE((SELECT SUM(COALESCE(NULLIF(p.net_amount,0),p.amount)) FROM payments p WHERE p.agreement_id = a.id AND p.status = 'success'), 0) AS paid_total
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE b.organization_id = ?
      ORDER BY a.created_at DESC, a.id DESC LIMIT 500`).all(req.orgId);
    res.json({ agreements });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not load agreements' });
  }
});

router.get('/riders', (req, res) => {
  try {
    const riders = db.prepare(`SELECT DISTINCT u.id, u.full_name, u.email, u.phone, u.city, u.created_at,
        a.id AS agreement_id, a.agreement_no, a.status AS agreement_status, a.weekly_amount
      FROM users u
      LEFT JOIN agreements a ON a.user_id = u.id AND a.status IN ('active','paused','defaulted')
      WHERE u.role = 'rider' AND u.deleted_at IS NULL AND u.organization_id = ?
      ORDER BY u.full_name ASC`).all(req.orgId);
    res.json({ riders });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not load riders' });
  }
});

module.exports = router;

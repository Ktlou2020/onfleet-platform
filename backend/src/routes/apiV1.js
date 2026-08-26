const express = require('express');
const crypto = require('crypto');
const pgDb = require('../pgDb');
const asyncRouter = require('../utils/asyncRouter');
const { ALERT_SEVERITY, ALL_ALERT_TYPES } = require('../constants/alertTypes');

const router = asyncRouter(express.Router());

async function apiKeyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const rawKey = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!rawKey) return res.status(401).json({ error: 'Missing API key' });
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  // LEFT JOIN, not JOIN: a platform-scoped key has no organization_id, and an
  // inner join would silently reject it as an invalid key.
  const { rows } = await pgDb.query(
    `SELECT ak.*, o.id AS org_id
       FROM api_keys ak
       LEFT JOIN organizations o ON o.id = ak.organization_id
      WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`, [keyHash]);
  const key = rows[0];
  if (!key) return res.status(401).json({ error: 'Invalid or revoked API key' });
  await pgDb.query(`UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`, [key.id]);
  req.apiKey = key;
  req.orgId = key.org_id;
  req.isPlatformKey = key.scope === 'platform';
  next();
}

router.use(apiKeyAuth);

// Scope clause + params for a query over bikes. A platform key sees every
// vehicle including platform-owned stock (organization_id IS NULL); an
// organization key sees only its own, exactly as before.
function bikeScope(req, alias = 'b') {
  return req.isPlatformKey
    ? { clause: 'TRUE', params: [] }
    : { clause: `${alias}.organization_id = $1`, params: [req.orgId] };
}

function platformOnly(req, res) {
  if (req.isPlatformKey) return false;
  res.status(403).json({ error: 'This endpoint requires a platform-scoped API key' });
  return true;
}

// ── Vehicles ────────────────────────────────────────────────────────────────
// The sync endpoint: one row per vehicle carrying everything needed to
// reconcile against an external fleet system — identity, group (hub), and the
// rider currently responsible for it with their contact details. Previously a
// caller had to pull /bikes, /agreements and /riders and join them by hand.
router.get('/vehicles', async (req, res) => {
  const { clause, params } = bikeScope(req);
  const { rows: vehicles } = await pgDb.query(
    `SELECT b.id, b.registration, b.vin, b.make, b.model, b.year, b.color, b.engine_cc,
            b.status, b.fleet, b.odometer_km, b.next_service_date,
            b.insurance_expiry, b.license_disc_expiry, b.created_at,
            b.last_known_lat, b.last_known_lng, b.last_location_at,
            b.organization_id,
            o.name  AS organization_name,
            h.id    AS hub_id,
            h.name  AS hub_name,
            h.city  AS hub_city,
            d.imei  AS tracker_imei,
            d.model AS tracker_model,
            a.id            AS agreement_id,
            a.agreement_no  AS agreement_no,
            a.status        AS agreement_status,
            u.id            AS rider_id,
            u.full_name     AS rider_name,
            u.phone         AS rider_phone,
            u.email         AS rider_email
       FROM bikes b
       LEFT JOIN organizations o ON o.id = b.organization_id
       LEFT JOIN hubs h ON h.id = b.hub_id
       LEFT JOIN tracking_devices d ON d.bike_id = b.id
       LEFT JOIN LATERAL (
         SELECT * FROM agreements WHERE bike_id = b.id AND status = 'active'
         ORDER BY id DESC LIMIT 1
       ) a ON TRUE
       LEFT JOIN users u ON u.id = a.user_id
      WHERE ${clause}
      ORDER BY b.registration ASC, b.id ASC`, params);

  res.json({
    count: vehicles.length,
    synced_at: new Date().toISOString(),
    vehicles: vehicles.map((v) => ({
      id: v.id,
      registration: v.registration,
      vin: v.vin,
      make: v.make,
      model: v.model,
      year: v.year,
      color: v.color,
      engine_cc: v.engine_cc,
      status: v.status,
      odometer_km: v.odometer_km,
      next_service_date: v.next_service_date,
      insurance_expiry: v.insurance_expiry,
      license_disc_expiry: v.license_disc_expiry,
      created_at: v.created_at,
      last_known_position: v.last_known_lat != null
        ? { lat: v.last_known_lat, lng: v.last_known_lng, at: v.last_location_at }
        : null,
      group: v.hub_id ? { id: v.hub_id, name: v.hub_name, city: v.hub_city } : null,
      // Free-text fleet label kept alongside the structured hub — some vehicles
      // are tagged this way and never assigned to a hub.
      fleet_label: v.fleet || null,
      owner: v.organization_id
        ? { type: 'fleet_owner', id: v.organization_id, name: v.organization_name }
        : { type: 'platform', id: null, name: null },
      tracker: v.tracker_imei ? { imei: v.tracker_imei, model: v.tracker_model } : null,
      // The rider currently responsible for the vehicle — the contact a control
      // room actually needs when an alarm fires. Null for unallocated stock.
      driver: v.rider_id ? {
        id: v.rider_id,
        name: v.rider_name,
        phone: v.rider_phone,
        email: v.rider_email,
        agreement_id: v.agreement_id,
        agreement_no: v.agreement_no,
        agreement_status: v.agreement_status,
      } : null,
    })),
  });
});

// ── Groups (hubs) ───────────────────────────────────────────────────────────
router.get('/groups', async (req, res) => {
  const scoped = req.isPlatformKey
    ? { clause: 'TRUE', params: [] }
    : { clause: 'h.organization_id = $1', params: [req.orgId] };
  const { rows: groups } = await pgDb.query(
    `SELECT h.id, h.name, h.address, h.city, h.contact_name, h.contact_phone,
            h.organization_id, o.name AS organization_name,
            (SELECT COUNT(*) FROM bikes b WHERE b.hub_id = h.id) AS vehicle_count
       FROM hubs h
       LEFT JOIN organizations o ON o.id = h.organization_id
      WHERE ${scoped.clause}
      ORDER BY h.name ASC`, scoped.params);
  res.json({ count: groups.length, groups: groups.map((g) => ({ ...g, vehicle_count: Number(g.vehicle_count) })) });
});

// ── Event catalogue ─────────────────────────────────────────────────────────
// Self-documenting: an integrator can enumerate every alarm identifier we will
// ever send instead of waiting to observe them in the wild.
router.get('/event-types', (req, res) => {
  res.json({
    count: ALL_ALERT_TYPES.length,
    event_types: ALL_ALERT_TYPES.map((type) => ({ type, severity: ALERT_SEVERITY[type] })),
  });
});

// ── Alerts (pull) ───────────────────────────────────────────────────────────
// Complements the webhook push: lets an integrator backfill after downtime or
// reconcile what they think they received against what we actually raised.
router.get('/alerts', async (req, res) => {
  if (platformOnly(req, res)) return;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const since = req.query.since ? new Date(req.query.since) : null;
  if (req.query.since && Number.isNaN(since.getTime())) {
    return res.status(400).json({ error: 'Invalid `since` — expected an ISO 8601 timestamp' });
  }

  const params = [limit];
  let where = 'TRUE';
  if (since) { params.push(since.toISOString()); where = `ta.created_at >= $${params.length}`; }
  if (req.query.event_type) { params.push(req.query.event_type); where += ` AND ta.alert_type = $${params.length}`; }

  const { rows } = await pgDb.query(
    `SELECT ta.id, ta.alert_type, ta.severity, ta.payload, ta.created_at,
            ta.acknowledged_at, ta.resolved_at,
            b.id AS bike_id, b.registration, b.make, b.model,
            u.full_name AS rider_name, u.phone AS rider_phone
       FROM tracking_alerts ta
       LEFT JOIN bikes b ON b.id = ta.bike_id
       LEFT JOIN LATERAL (
         SELECT * FROM agreements WHERE bike_id = ta.bike_id AND status = 'active'
         ORDER BY id DESC LIMIT 1
       ) a ON TRUE
       LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where}
      ORDER BY ta.created_at DESC, ta.id DESC
      LIMIT $1`, params);

  res.json({
    count: rows.length,
    alerts: rows.map((r) => ({
      id: r.id,
      event_type: r.alert_type,
      severity: r.severity,
      occurred_at: r.created_at,
      acknowledged_at: r.acknowledged_at,
      resolved_at: r.resolved_at,
      vehicle: r.bike_id ? { id: r.bike_id, registration: r.registration, make: r.make, model: r.model } : null,
      driver: r.rider_name ? { name: r.rider_name, phone: r.rider_phone } : null,
      detail: (() => { try { return JSON.parse(r.payload || '{}'); } catch { return {}; } })(),
    })),
  });
});

// ── Legacy endpoints (unchanged shape, now scope-aware) ─────────────────────
router.get('/bikes', async (req, res) => {
  const { clause, params } = bikeScope(req);
  const { rows: bikes } = await pgDb.query(
    `SELECT b.id, b.registration, b.make, b.model, b.year, b.fleet, b.status, b.rental_weekly,
            b.total_weeks, b.odometer_km, b.next_service_date, b.hub_id, b.created_at
       FROM bikes b WHERE ${clause}
      ORDER BY b.status ASC, b.registration ASC, b.id DESC`, params);
  res.json({ bikes });
});

router.get('/agreements', async (req, res) => {
  const { clause, params } = bikeScope(req);
  const { rows: agreements } = await pgDb.query(
    `SELECT a.id, a.agreement_no, a.status, a.weekly_amount, a.total_weeks, a.total_amount,
            a.start_date, a.end_date, a.created_at,
            b.registration AS bike_registration, b.make, b.model,
            u.full_name AS rider_name, u.email AS rider_email,
            COALESCE((SELECT SUM(COALESCE(NULLIF(p.net_amount,0),p.amount)) FROM payments p
                       WHERE p.agreement_id = a.id AND p.status = 'success'), 0) AS paid_total
       FROM agreements a
       JOIN bikes b ON b.id = a.bike_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE ${clause}
      ORDER BY a.created_at DESC, a.id DESC LIMIT 500`, params);
  res.json({ agreements });
});

router.get('/riders', async (req, res) => {
  const scoped = req.isPlatformKey
    ? { clause: 'TRUE', params: [] }
    : { clause: 'u.organization_id = $1', params: [req.orgId] };
  const { rows: riders } = await pgDb.query(
    `SELECT DISTINCT u.id, u.full_name, u.email, u.phone, u.city, u.created_at,
            a.id AS agreement_id, a.agreement_no, a.status AS agreement_status, a.weekly_amount
       FROM users u
       LEFT JOIN agreements a ON a.user_id = u.id AND a.status IN ('active','paused','defaulted')
      WHERE u.role = 'rider' AND u.deleted_at IS NULL AND ${scoped.clause}
      ORDER BY u.full_name ASC`, scoped.params);
  res.json({ riders });
});

module.exports = router;

const express = require('express');
const crypto = require('crypto');
const pgDb = require('../pgDb');
const asyncRouter = require('../utils/asyncRouter');
const { ALERT_SEVERITY, ALL_ALERT_TYPES } = require('../constants/alertTypes');
const { alertContact } = require('../services/alertContact');
const poolFinance = require('../services/poolFinance');

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
  req.isFunderKey = key.scope === 'funder';
  // NULL means unrestricted; an array means exactly these pools and no others.
  // Kept as null rather than [] so that "no restriction" and "restricted to
  // nothing" cannot be confused by a truthiness check downstream.
  req.poolIds = Array.isArray(key.pool_ids) ? key.pool_ids.map(Number) : null;
  next();
}

router.use(apiKeyAuth);

// A funder key is for money, and only for money. It exists so that somebody
// financing a pool of bikes can read what that pool has collected without
// also being handed every rider's name and phone number across the estate —
// which is what a platform key would give them. Default-deny: anything that
// is not a pool endpoint is refused, so a route added later is out of a
// funder's reach until somebody decides otherwise on purpose.
router.use((req, res, next) => {
  if (!req.isFunderKey) return next();
  if (req.path === '/pools' || req.path.startsWith('/pools/')) return next();
  return res.status(403).json({
    error: 'This key may only read bike pool finance endpoints',
    code: 'FUNDER_KEY_SCOPE',
  });
});

// Scope clause + params for a query over bikes. A platform key sees every
// vehicle including platform-owned stock (organization_id IS NULL); an
// organization key sees only its own, exactly as before.
function bikeScope(req, alias = 'b') {
  return req.isPlatformKey
    // A walk-in bike registered by the workshop is not an OnFleet asset and
    // is never exported, whatever key is asking.
    ? { clause: `${alias}.workshop_only = FALSE`, params: [] }
    : { clause: `${alias}.workshop_only = FALSE AND ${alias}.organization_id = $1`, params: [req.orgId] };
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
    alerts: rows.map((r) => {
      // Same rule as webhook deliveries: which OnFleet number to call, decided
      // by when the alert happened.
      const contact = alertContact(r.created_at);
      return {
      id: r.id,
      event_type: r.alert_type,
      severity: r.severity,
      occurred_at: r.created_at,
      acknowledged_at: r.acknowledged_at,
      resolved_at: r.resolved_at,
      vehicle: r.bike_id ? { id: r.bike_id, registration: r.registration, make: r.make, model: r.model } : null,
      contact,
      driver: r.rider_name ? { name: r.rider_name, phone: contact.phone } : null,
      detail: (() => { try { return JSON.parse(r.payload || '{}'); } catch { return {}; } })(),
      };
    }),
  });
});

// ── Bike pools (finance) ────────────────────────────────────────────────────
// What a funder who advanced money against a set of delivery bikes needs to
// know: how much has come back, how much is late and how late, and what is
// unlikely ever to come back. The arithmetic lives in services/poolFinance.js
// so that these numbers cannot drift from the ones the admin screens show.
//
// No rider appears anywhere in these responses. A funder is owed an account
// of the money, not of the people, and names and phone numbers shared once
// cannot be unshared.

// Which pools this key may read at all.
//   platform, unrestricted  → every pool
//   platform/funder + pool_ids → exactly those
//   organization            → pools belonging to that fleet owner
function poolScope(req) {
  if (req.poolIds) return { poolIds: req.poolIds };
  if (req.isPlatformKey) return {};
  return { orgId: req.orgId };
}

function canSeePool(req, pool) {
  if (req.poolIds) return req.poolIds.includes(Number(pool.id));
  if (req.isPlatformKey) return true;
  return pool.organization_id != null && Number(pool.organization_id) === Number(req.orgId);
}

router.get('/pools', async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !['open', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid `status` — expected open or closed' });
  }
  const pools = await poolFinance.list({ ...poolScope(req), status });
  res.json({ count: pools.length, as_at: new Date().toISOString(), pools });
});

router.get('/pools/:id', async (req, res) => {
  const poolId = Number(req.params.id);
  if (!Number.isInteger(poolId) || poolId <= 0) {
    return res.status(400).json({ error: 'Invalid pool id' });
  }
  const pool = await poolFinance.getPool(poolId);
  // 404 rather than 403 for a pool this key may not read. A funder probing
  // ids should not be able to learn which other tranches exist from the
  // difference between "forbidden" and "no such thing".
  if (!pool || !canSeePool(req, pool)) return res.status(404).json({ error: 'Pool not found' });

  const full = await poolFinance.position(poolId);
  res.json({ as_at: new Date().toISOString(), ...full });
});

// The transaction feed, for reconciling against a bank statement. `since`
// makes it incremental: a nightly job asks for everything after its last
// successful run rather than re-pulling the pool's whole history.
router.get('/pools/:id/payments', async (req, res) => {
  const poolId = Number(req.params.id);
  if (!Number.isInteger(poolId) || poolId <= 0) {
    return res.status(400).json({ error: 'Invalid pool id' });
  }
  const pool = await poolFinance.getPool(poolId);
  if (!pool || !canSeePool(req, pool)) return res.status(404).json({ error: 'Pool not found' });

  const since = req.query.since ? new Date(req.query.since) : null;
  if (req.query.since && Number.isNaN(since.getTime())) {
    return res.status(400).json({ error: 'Invalid `since` — expected an ISO 8601 timestamp' });
  }
  const limit = Math.min(Number(req.query.limit) || 500, 2000);

  const rows = await poolFinance.payments(poolId, { since, limit });
  res.json({
    pool: poolFinance.poolShape(pool),
    count: rows.length,
    as_at: new Date().toISOString(),
    payments: rows,
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

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const pgDb = require('../pgDb');
const { authRequired, adminOnly, trackingReadOnly } = require('../middleware/auth');
const teltonikaServer = require('../tcp/teltonikaServer');
const trackingEvents = require('../trackingEvents');

const ENGINE_CUT_CMD  = { FMB920: 'setdigout 1 1', FMC920: 'setdigout 1 1', FMB965: 'setdigout 2 1', other: 'setdigout 1 1' };
const ENGINE_REST_CMD = { FMB920: 'setdigout 1 0', FMC920: 'setdigout 1 0', FMB965: 'setdigout 2 0', other: 'setdigout 1 0' };
const PRESET_COMMANDS = {
  cut_engine:     (model) => ENGINE_CUT_CMD[model]  || ENGINE_CUT_CMD.other,
  restore_engine: (model) => ENGINE_REST_CMD[model] || ENGINE_REST_CMD.other,
  get_gps:        () => 'getgps',
  fota_connect:   () => 'fota connect',
  get_info:       () => 'getinfo',
  get_status:     () => 'getstatus',
  get_ver:        () => 'getver',
  get_param:      () => 'getparam 2004',
};

// Device status thresholds.
// FMB920/FMB965 connect briefly to push data then drop the TCP link.
// "active"   = live socket open OR last seen < 10 min (normal reporting cadence)
// "sleeping" = last seen 10 min – 1 hour (idle/stationary sleep mode)
// "offline"  = last seen > 1 hour or never
const ACTIVE_GRACE_MS   = 10 * 60 * 1000;  // 10 min
const SLEEPING_GRACE_MS = 60 * 60 * 1000;  // 1 hour

function deviceStatus(imei, lastSeenAt, connectedImeis) {
  if (connectedImeis.includes(imei)) return 'active';
  if (!lastSeenAt) return 'offline';
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (age < ACTIVE_GRACE_MS)   return 'active';
  if (age < SLEEPING_GRACE_MS) return 'sleeping';
  return 'offline';
}

function isOnline(imei, lastSeenAt, connectedImeis) {
  const s = deviceStatus(imei, lastSeenAt, connectedImeis);
  return s !== 'offline' ? 1 : 0;
}

// All known alert types with defaults
const ALL_ALERT_TYPES = [
  'geofence_enter','geofence_exit','harsh_brake','harsh_accel','harsh_cornering',
  'idle','speeding','panic','power_disconnect','low_battery','movement','tamper','device_offline',
];

// Build a SQLite bike/org/rider map for a list of bike IDs
function getBikeMap(bikeIds) {
  if (!bikeIds.length) return {};
  const placeholders = bikeIds.map(() => '?').join(',');
  const bikes = db.prepare(`
    SELECT b.id, b.registration, b.make, b.model, b.color, b.vin, b.year, b.status,
           b.last_known_lat, b.last_known_lng, b.last_location_at, b.odometer_km,
           b.organization_id, o.name AS organization_name,
           (SELECT u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_name,
           (SELECT u.phone    FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_phone,
           (SELECT u.address  FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_address,
           (SELECT u.city     FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_city
    FROM bikes b LEFT JOIN organizations o ON o.id = b.organization_id
    WHERE b.id IN (${placeholders})
  `).all(...bikeIds);
  const map = {};
  for (const b of bikes) map[b.id] = b;
  return map;
}

// ---------- Devices ----------

router.get('/devices', authRequired, trackingReadOnly, async (req, res) => {
  const { rows: devices } = await pgDb.query(
    `SELECT * FROM tracking_devices ORDER BY connected DESC, last_seen_at DESC`
  );
  const connected = teltonikaServer.getConnectedIMEIs();
  const bikeIds = [...new Set(devices.map(d => d.bike_id).filter(Boolean))];
  const bikeMap = getBikeMap(bikeIds);
  const result = devices.map(d => ({
    ...d,
    device_status: deviceStatus(d.imei, d.last_seen_at, connected),
    connected: isOnline(d.imei, d.last_seen_at, connected),
    ...(d.bike_id && bikeMap[d.bike_id] ? {
      registration: bikeMap[d.bike_id].registration,
      make: bikeMap[d.bike_id].make,
      bike_model: bikeMap[d.bike_id].model,
      bike_color: bikeMap[d.bike_id].color,
      bike_vin: bikeMap[d.bike_id].vin,
      bike_year: bikeMap[d.bike_id].year,
      last_known_lat: bikeMap[d.bike_id].last_known_lat,
      last_known_lng: bikeMap[d.bike_id].last_known_lng,
      last_location_at: bikeMap[d.bike_id].last_location_at,
      organization_id: bikeMap[d.bike_id].organization_id,
      organization_name: bikeMap[d.bike_id].organization_name,
      rider_name: bikeMap[d.bike_id].rider_name,
      rider_phone: bikeMap[d.bike_id].rider_phone,
      rider_address: bikeMap[d.bike_id].rider_address,
      rider_city: bikeMap[d.bike_id].rider_city,
    } : {}),
  }));
  res.json(result);
});

router.get('/devices/:id', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT * FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
  const d = rows[0];
  const bike = d.bike_id ? db.prepare(`
    SELECT b.registration, b.make, b.model, b.last_known_lat, b.last_known_lng, b.last_location_at
    FROM bikes b WHERE b.id = ?
  `).get(d.bike_id) : null;
  const connImeis = teltonikaServer.getConnectedIMEIs();
  const status = deviceStatus(d.imei, d.last_seen_at, connImeis);
  res.json({ ...d, device_status: status, connected: status !== 'offline' ? 1 : 0, ...(bike || {}) });
});

router.post('/devices', authRequired, adminOnly, async (req, res) => {
  const { imei, model, bike_id, label } = req.body;
  if (!imei || String(imei).trim().length < 10) return res.status(400).json({ error: 'Valid IMEI required' });
  const validModels = ['FMB920', 'FMB965', 'FMC920', 'other'];
  if (model && !validModels.includes(model)) return res.status(400).json({ error: `Model must be one of: ${validModels.join(', ')}` });
  try {
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, model, bike_id, label) VALUES ($1,$2,$3,$4) RETURNING id`,
      [String(imei).trim(), model || 'other', bike_id || null, label || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.message.includes('unique') || err.code === '23505') return res.status(409).json({ error: 'IMEI already registered' });
    throw err;
  }
});

router.put('/devices/:id', authRequired, adminOnly, async (req, res) => {
  const { model, label } = req.body;
  const validModels = ['FMB920', 'FMB965', 'FMC920', 'other'];
  if (model !== undefined && !validModels.includes(model)) return res.status(400).json({ error: `Model must be one of: ${validModels.join(', ')}` });
  const speedLimit = req.body.speed_limit_kmh != null ? Number(req.body.speed_limit_kmh) : null;
  if (speedLimit !== null && (speedLimit < 10 || speedLimit > 300)) return res.status(400).json({ error: 'speed_limit_kmh must be 10–300' });
  const { rows } = await pgDb.query('SELECT id FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
  if ('bike_id' in req.body) {
    await pgDb.query(
      `UPDATE tracking_devices SET model=COALESCE($1,model), bike_id=$2, label=COALESCE($3,label), speed_limit_kmh=COALESCE($4,speed_limit_kmh), updated_at=NOW() WHERE id=$5`,
      [model || null, req.body.bike_id || null, label || null, speedLimit, rows[0].id]
    );
  } else {
    await pgDb.query(
      `UPDATE tracking_devices SET model=COALESCE($1,model), label=COALESCE($2,label), speed_limit_kmh=COALESCE($3,speed_limit_kmh), updated_at=NOW() WHERE id=$4`,
      [model || null, label || null, speedLimit, rows[0].id]
    );
  }
  res.json({ ok: true });
});

router.delete('/devices/:id', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT id, imei FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
  await pgDb.query('DELETE FROM tracking_devices WHERE id=$1', [rows[0].id]);
  res.json({ ok: true });
});

// ---------- Positions ----------

router.get('/devices/:id/positions', authRequired, trackingReadOnly, async (req, res) => {
  const { rows: devRows } = await pgDb.query('SELECT * FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!devRows[0]) return res.status(404).json({ error: 'Device not found' });
  if (!devRows[0].bike_id) return res.json([]);

  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const from  = req.query.from || null;
  const to    = req.query.to   || null;

  const params = [devRows[0].bike_id];
  let sql = 'SELECT id, lat, lng, speed_kmh, heading, recorded_at, satellites, altitude, ignition FROM gps_pings WHERE bike_id=$1';
  if (from) { params.push(from); sql += ` AND recorded_at >= $${params.length}`; }
  if (to)   { params.push(to);   sql += ` AND recorded_at <= $${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY recorded_at DESC LIMIT $${params.length}`;

  const { rows } = await pgDb.query(sql, params);
  res.json(rows.reverse());
});

// ---------- Commands ----------

router.post('/devices/:id/commands', authRequired, adminOnly, async (req, res) => {
  const { rows: devRows } = await pgDb.query('SELECT * FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!devRows[0]) return res.status(404).json({ error: 'Device not found' });
  const device = devRows[0];

  let command;
  if (req.body.preset) {
    const fn = PRESET_COMMANDS[req.body.preset];
    if (!fn) return res.status(400).json({ error: `Unknown preset. Available: ${Object.keys(PRESET_COMMANDS).join(', ')}` });
    command = fn(device.model);
  } else if (req.body.command) {
    command = String(req.body.command).trim();
  } else {
    return res.status(400).json({ error: 'Provide preset or command' });
  }

  const { rows: cmdRows } = await pgDb.query(
    `INSERT INTO tracking_commands (device_id, command, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [device.id, command, req.user.id]
  );
  const cmdId = cmdRows[0].id;
  const sentNow = teltonikaServer.sendCommand(device.imei, cmdId, command);
  let woke = false;
  if (!sentNow && command === 'getgps') {
    woke = teltonikaServer.sendWakePacket(device.imei);
  }
  res.json({
    id: cmdId,
    command,
    status: sentNow ? 'sent' : 'pending',
    note: sentNow
      ? 'Command sent to device'
      : woke
        ? 'Wake signal sent — device will respond shortly'
        : 'Device offline — command queued for next connection',
  });
});

router.get('/devices/:id/commands', authRequired, trackingReadOnly, async (req, res) => {
  const { rows: devRows } = await pgDb.query('SELECT id FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!devRows[0]) return res.status(404).json({ error: 'Device not found' });
  const { rows } = await pgDb.query(
    `SELECT tc.* FROM tracking_commands tc WHERE tc.device_id=$1 ORDER BY tc.created_at DESC LIMIT 100`,
    [devRows[0].id]
  );
  // Enrich created_by with user name from SQLite
  for (const cmd of rows) {
    if (cmd.created_by) {
      const u = db.prepare('SELECT full_name FROM users WHERE id = ?').get(cmd.created_by);
      cmd.created_by_name = u?.full_name || null;
    }
  }
  res.json(rows);
});

// ---------- Map overview ----------

router.get('/map', authRequired, trackingReadOnly, async (req, res) => {
  const connected = teltonikaServer.getConnectedIMEIs();

  // Get all devices with a linked bike
  const { rows: devices } = await pgDb.query(
    `SELECT id, imei, model, label, last_seen_at, bike_id FROM tracking_devices WHERE bike_id IS NOT NULL`
  );
  if (!devices.length) return res.json([]);

  const bikeIds = [...new Set(devices.map(d => d.bike_id))];

  // Latest ping per bike (Postgres LATERAL / DISTINCT ON)
  const { rows: latestPings } = await pgDb.query(
    `SELECT DISTINCT ON (bike_id) bike_id, speed_kmh, heading, ignition, satellites, altitude, io_data
     FROM gps_pings WHERE bike_id = ANY($1) ORDER BY bike_id, recorded_at DESC`,
    [bikeIds]
  );
  const pingMap = {};
  for (const p of latestPings) pingMap[p.bike_id] = p;

  // Bike + org + rider info from SQLite
  const bikeMap = getBikeMap(bikeIds);

  const result = devices
    .filter(d => bikeMap[d.bike_id]?.last_known_lat != null)
    .map(d => {
      const b = bikeMap[d.bike_id] || {};
      const p = pingMap[d.bike_id] || {};
      return {
        id: d.id, imei: d.imei, model: d.model, label: d.label,
        last_seen_at: d.last_seen_at,
        bike_id: d.bike_id,
        registration: b.registration, make: b.make, bike_model: b.model,
        bike_status: b.status, bike_color: b.color, bike_vin: b.vin, bike_year: b.year,
        lat: b.last_known_lat, lng: b.last_known_lng, last_location_at: b.last_location_at,
        odometer_km: b.odometer_km,
        organization_id: b.organization_id, organization_name: b.organization_name,
        speed_kmh: p.speed_kmh, heading: p.heading, ignition: p.ignition,
        satellites: p.satellites, altitude: p.altitude, io_data: p.io_data,
        rider_name: b.rider_name, rider_phone: b.rider_phone,
        rider_address: b.rider_address, rider_city: b.rider_city,
        device_status: deviceStatus(d.imei, d.last_seen_at, connected),
        connected: isOnline(d.imei, d.last_seen_at, connected),
      };
    });
  res.json(result);
});

// ---------- SSE live stream ----------

router.get('/live', authRequired, trackingReadOnly, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const onPing         = (p) => { try { res.write(`event: ping\ndata: ${JSON.stringify(p)}\n\n`); } catch (_) {} };
  const onAlert        = (p) => { try { res.write(`event: alert\ndata: ${JSON.stringify(p)}\n\n`); } catch (_) {} };
  const onDeviceStatus = (p) => { try { res.write(`event: device_status\ndata: ${JSON.stringify(p)}\n\n`); } catch (_) {} };
  trackingEvents.on('ping', onPing);
  trackingEvents.on('alert', onAlert);
  trackingEvents.on('device_status', onDeviceStatus);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 25_000);
  req.on('close', () => {
    trackingEvents.off('ping', onPing);
    trackingEvents.off('alert', onAlert);
    trackingEvents.off('device_status', onDeviceStatus);
    clearInterval(hb);
  });
});

// ---------- Geofences ----------

router.get('/geofences', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query(`SELECT * FROM geofences ORDER BY created_at DESC`);
  for (const gf of rows) {
    if (gf.bike_id) {
      const b = db.prepare('SELECT registration FROM bikes WHERE id = ?').get(gf.bike_id);
      gf.bike_registration = b?.registration || null;
    }
  }
  res.json(rows);
});

router.post('/geofences', authRequired, adminOnly, async (req, res) => {
  const { name, lat, lng, radius_m, bike_id, zone_type, color, polygon_coords } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const hasPolygon = Array.isArray(polygon_coords) && polygon_coords.length >= 3;
  if (!hasPolygon && (lat == null || lng == null)) return res.status(400).json({ error: 'lat and lng are required without a polygon' });
  const radius = Number(radius_m) || 500;
  if (!hasPolygon && (radius < 50 || radius > 50000)) return res.status(400).json({ error: 'radius_m must be 50–50000' });
  const centerLat = hasPolygon ? polygon_coords.reduce((s, p) => s + p[0], 0) / polygon_coords.length : Number(lat);
  const centerLng = hasPolygon ? polygon_coords.reduce((s, p) => s + p[1], 0) / polygon_coords.length : Number(lng);
  const { rows } = await pgDb.query(
    'INSERT INTO geofences (name, lat, lng, radius_m, bike_id, zone_type, color, polygon_coords, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [name, centerLat, centerLng, radius, bike_id || null, zone_type || 'standard', color || null, hasPolygon ? JSON.stringify(polygon_coords) : null, req.user.id]
  );
  res.status(201).json({ id: rows[0].id });
});

router.put('/geofences/:id', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT id FROM geofences WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Geofence not found' });
  const { name, lat, lng, radius_m, bike_id, active, polygon_coords } = req.body;
  const hasBikeId = 'bike_id' in req.body;
  const hasPolygon = 'polygon_coords' in req.body;
  await pgDb.query(`
    UPDATE geofences SET
      name           = COALESCE($1, name),
      lat            = COALESCE($2, lat),
      lng            = COALESCE($3, lng),
      radius_m       = COALESCE($4, radius_m),
      bike_id        = CASE WHEN $5 THEN $6 ELSE bike_id END,
      active         = COALESCE($7, active),
      polygon_coords = CASE WHEN $8 THEN $9::jsonb ELSE polygon_coords END
    WHERE id = $10
  `, [
    name || null,
    lat != null ? Number(lat) : null,
    lng != null ? Number(lng) : null,
    radius_m != null ? Number(radius_m) : null,
    hasBikeId, bike_id || null,
    active != null ? Boolean(active) : null,
    hasPolygon, polygon_coords != null ? JSON.stringify(polygon_coords) : null,
    rows[0].id,
  ]);
  res.json({ ok: true });
});

router.delete('/geofences/:id', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT id FROM geofences WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Geofence not found' });
  await pgDb.query('DELETE FROM geofences WHERE id=$1', [rows[0].id]);
  res.json({ ok: true });
});

// ---------- Trips ----------

router.get('/trips', authRequired, trackingReadOnly, async (req, res) => {
  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const bikeId = req.query.bike_id ? Number(req.query.bike_id) : null;
  const params = [];
  let sql = 'SELECT * FROM trips WHERE 1=1';
  if (bikeId) { params.push(bikeId); sql += ` AND bike_id=$${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY started_at DESC LIMIT $${params.length}`;
  const { rows } = await pgDb.query(sql, params);
  for (const t of rows) {
    const b = db.prepare('SELECT registration FROM bikes WHERE id = ?').get(t.bike_id);
    t.bike_registration = b?.registration || null;
  }
  res.json(rows);
});

// ---------- Alerts ----------

router.get('/alerts', authRequired, trackingReadOnly, async (req, res) => {
  const limit      = Math.min(Number(req.query.limit) || 100, 500);
  const bikeId     = req.query.bike_id ? Number(req.query.bike_id) : null;
  const unackedOnly = req.query.unacked === '1';
  const params = [];
  let sql = 'SELECT * FROM tracking_alerts WHERE 1=1';
  if (bikeId)     { params.push(bikeId); sql += ` AND bike_id=$${params.length}`; }
  if (unackedOnly) sql += ' AND acknowledged_at IS NULL';
  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const { rows } = await pgDb.query(sql, params);
  for (const a of rows) {
    const b = db.prepare('SELECT registration FROM bikes WHERE id = ?').get(a.bike_id);
    a.bike_registration = b?.registration || null;
  }
  res.json(rows);
});

router.put('/alerts/:id/acknowledge', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT id FROM tracking_alerts WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Alert not found' });
  await pgDb.query('UPDATE tracking_alerts SET acknowledged_at=NOW() WHERE id=$1', [rows[0].id]);
  res.json({ ok: true });
});

router.post('/alerts/acknowledge-all', authRequired, trackingReadOnly, async (req, res) => {
  const bikeId = req.body.bike_id ? Number(req.body.bike_id) : null;
  if (bikeId) {
    await pgDb.query('UPDATE tracking_alerts SET acknowledged_at=NOW() WHERE bike_id=$1 AND acknowledged_at IS NULL', [bikeId]);
  } else {
    await pgDb.query('UPDATE tracking_alerts SET acknowledged_at=NOW() WHERE acknowledged_at IS NULL');
  }
  res.json({ ok: true });
});

// ---------- Alert settings ----------

router.get('/alert-settings', authRequired, trackingReadOnly, async (req, res) => {
  const deviceId = req.query.device_id ? Number(req.query.device_id) : null;

  const { rows: globalRows } = await pgDb.query('SELECT * FROM alert_settings');
  const globalMap = {};
  for (const r of globalRows) globalMap[r.alert_type] = r;

  let deviceMap = {};
  if (deviceId) {
    try {
      const { rows: deviceRows } = await pgDb.query(
        'SELECT * FROM device_alert_settings WHERE device_id=$1', [deviceId]
      );
      for (const r of deviceRows) deviceMap[r.alert_type] = r;
    } catch { /* table may not exist yet */ }
  }

  // Alert types that are off by default when no explicit setting exists in the DB
  const DISABLED_BY_DEFAULT = new Set(['panic']);

  const result = ALL_ALERT_TYPES.map(t => {
    const g = globalMap[t];
    const d = deviceMap[t];
    const active = d || g;
    const enabledDefault = !DISABLED_BY_DEFAULT.has(t);
    return {
      alert_type: t,
      enabled: active ? active.enabled : enabledDefault,
      notify_enabled: active ? active.notify_enabled : enabledDefault,
      recipient_user_ids: (() => { try { return JSON.parse(active?.recipient_user_ids || '[]'); } catch { return []; } })(),
      device_override: !!d,
    };
  });
  res.json(result);
});

router.put('/alert-settings', authRequired, adminOnly, async (req, res) => {
  // Accept array (legacy) or { settings, device_id, apply_to_all }
  let settings, deviceId, applyToAll;
  if (Array.isArray(req.body)) {
    settings = req.body;
    deviceId = null;
    applyToAll = false;
  } else {
    settings = req.body.settings;
    deviceId = req.body.device_id || null;
    applyToAll = req.body.apply_to_all || false;
  }
  if (!Array.isArray(settings)) return res.status(400).json({ error: 'Expected settings array' });

  if (!deviceId || applyToAll) {
    // Save to global alert_settings
    for (const s of settings) {
      if (!ALL_ALERT_TYPES.includes(s.alert_type)) continue;
      const recipIds = JSON.stringify(Array.isArray(s.recipient_user_ids) ? s.recipient_user_ids : []);
      await pgDb.query(`
        INSERT INTO alert_settings (alert_type, enabled, notify_enabled, recipient_user_ids, updated_at)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (alert_type) DO UPDATE SET
          enabled=EXCLUDED.enabled, notify_enabled=EXCLUDED.notify_enabled,
          recipient_user_ids=EXCLUDED.recipient_user_ids, updated_at=NOW()
      `, [s.alert_type, s.enabled !== false, s.notify_enabled !== false, recipIds]);
    }
    if (applyToAll) {
      // Clear all device overrides so everything falls back to global
      try {
        const types = settings.map(s => s.alert_type).filter(t => ALL_ALERT_TYPES.includes(t));
        if (types.length) await pgDb.query('DELETE FROM device_alert_settings WHERE alert_type = ANY($1)', [types]);
      } catch { /* table may not exist */ }
    }
  }

  if (deviceId && !applyToAll) {
    // Save device-specific overrides
    for (const s of settings) {
      if (!ALL_ALERT_TYPES.includes(s.alert_type)) continue;
      const recipIds = JSON.stringify(Array.isArray(s.recipient_user_ids) ? s.recipient_user_ids : []);
      await pgDb.query(`
        INSERT INTO device_alert_settings (device_id, alert_type, enabled, notify_enabled, recipient_user_ids, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (device_id, alert_type) DO UPDATE SET
          enabled=EXCLUDED.enabled, notify_enabled=EXCLUDED.notify_enabled,
          recipient_user_ids=EXCLUDED.recipient_user_ids, updated_at=NOW()
      `, [deviceId, s.alert_type, s.enabled !== false, s.notify_enabled !== false, recipIds]);
    }
  }

  require('../services/tripService').reloadAlertSettings();
  res.json({ ok: true });
});

router.delete('/alert-settings/device/:device_id', authRequired, adminOnly, async (req, res) => {
  try {
    await pgDb.query('DELETE FROM device_alert_settings WHERE device_id=$1', [Number(req.params.device_id)]);
    require('../services/tripService').reloadAlertSettings();
  } catch { /* ignore if table missing */ }
  res.json({ ok: true });
});

router.get('/notification-users', authRequired, trackingReadOnly, (req, res) => {
  const users = db.prepare(
    `SELECT id, full_name, email, role FROM users WHERE role IN ('superadmin','admin') AND deleted_at IS NULL ORDER BY full_name`
  ).all();
  res.json(users);
});

module.exports = router;

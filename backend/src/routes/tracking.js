'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const teltonikaServer = require('../tcp/teltonikaServer');
const trackingEvents = require('../trackingEvents');

// Engine cut/restore command per model
const ENGINE_CUT_CMD = { FMB920: 'setdigout 1 1', FMC920: 'setdigout 1 1', FMB965: 'setdigout 2 1', other: 'setdigout 1 1' };
const ENGINE_RESTORE_CMD = { FMB920: 'setdigout 1 0', FMC920: 'setdigout 1 0', FMB965: 'setdigout 2 0', other: 'setdigout 1 0' };
const PRESET_COMMANDS = {
  cut_engine: (model) => ENGINE_CUT_CMD[model] || ENGINE_CUT_CMD.other,
  restore_engine: (model) => ENGINE_RESTORE_CMD[model] || ENGINE_RESTORE_CMD.other,
  fota_connect: () => 'fota connect',
  get_info: () => 'getinfo',
  get_status: () => 'getstatus',
  get_ver: () => 'getver',
  get_param: () => 'getparam 2004', // server domain (2001 = APN, 2004 = server)
};

// ---------- Devices ----------

// GET /api/tracking/devices
router.get('/devices', authRequired, adminOnly, (req, res) => {
  const devices = db.prepare(`
    SELECT td.*, b.registration, b.make, b.model AS bike_model, b.color AS bike_color, b.vin AS bike_vin, b.year AS bike_year,
           b.last_known_lat, b.last_known_lng, b.last_location_at,
           b.organization_id, o.name AS organization_name,
           (SELECT u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_name,
           (SELECT u.phone    FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_phone,
           (SELECT u.address  FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_address,
           (SELECT u.city     FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_city
    FROM tracking_devices td
    LEFT JOIN bikes b ON b.id = td.bike_id
    LEFT JOIN organizations o ON o.id = b.organization_id
    ORDER BY td.connected DESC, td.last_seen_at DESC
  `).all();
  const connected = teltonikaServer.getConnectedIMEIs();
  // Sync connected flag with live socket map
  for (const d of devices) d.connected = connected.includes(d.imei) ? 1 : 0;
  res.json(devices);
});

// GET /api/tracking/devices/:id
router.get('/devices/:id', authRequired, adminOnly, (req, res) => {
  const device = db.prepare(`
    SELECT td.*, b.registration, b.make, b.model AS bike_model, b.last_known_lat, b.last_known_lng, b.last_location_at
    FROM tracking_devices td LEFT JOIN bikes b ON b.id = td.bike_id
    WHERE td.id = ?
  `).get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  device.connected = teltonikaServer.getConnectedIMEIs().includes(device.imei) ? 1 : 0;
  res.json(device);
});

// POST /api/tracking/devices — register a new device
router.post('/devices', authRequired, adminOnly, (req, res) => {
  const { imei, model, bike_id, label } = req.body;
  if (!imei || String(imei).trim().length < 10) return res.status(400).json({ error: 'Valid IMEI required' });
  const validModels = ['FMB920', 'FMB965', 'FMC920', 'other'];
  if (model && !validModels.includes(model)) return res.status(400).json({ error: `Model must be one of: ${validModels.join(', ')}` });
  try {
    const info = db.prepare(
      `INSERT INTO tracking_devices (imei, model, bike_id, label) VALUES (?, ?, ?, ?)`
    ).run(String(imei).trim(), model || 'other', bike_id || null, label || null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'IMEI already registered' });
    throw err;
  }
});

// PUT /api/tracking/devices/:id
router.put('/devices/:id', authRequired, adminOnly, (req, res) => {
  const { model, label } = req.body;
  const validModels = ['FMB920', 'FMB965', 'FMC920', 'other'];
  if (model !== undefined && !validModels.includes(model)) return res.status(400).json({ error: `Model must be one of: ${validModels.join(', ')}` });
  const speedLimit = req.body.speed_limit_kmh != null ? Number(req.body.speed_limit_kmh) : null;
  if (speedLimit !== null && (speedLimit < 10 || speedLimit > 300)) return res.status(400).json({ error: 'speed_limit_kmh must be 10–300' });
  const device = db.prepare('SELECT id FROM tracking_devices WHERE id=?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if ('bike_id' in req.body) {
    db.prepare(`UPDATE tracking_devices SET model=COALESCE(?,model), bike_id=?, label=COALESCE(?,label), speed_limit_kmh=COALESCE(?,speed_limit_kmh), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(model || null, req.body.bike_id || null, label || null, speedLimit, device.id);
  } else {
    db.prepare(`UPDATE tracking_devices SET model=COALESCE(?,model), label=COALESCE(?,label), speed_limit_kmh=COALESCE(?,speed_limit_kmh), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(model || null, label || null, speedLimit, device.id);
  }
  res.json({ ok: true });
});

// DELETE /api/tracking/devices/:id
router.delete('/devices/:id', authRequired, adminOnly, (req, res) => {
  const device = db.prepare('SELECT id, imei FROM tracking_devices WHERE id=?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  db.prepare('DELETE FROM tracking_devices WHERE id=?').run(device.id);
  res.json({ ok: true });
});

// ---------- Positions ----------

// GET /api/tracking/devices/:id/positions?limit=200&from=&to=
router.get('/devices/:id/positions', authRequired, adminOnly, (req, res) => {
  const device = db.prepare('SELECT * FROM tracking_devices WHERE id=?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.bike_id) return res.json([]);

  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const from = req.query.from || null;
  const to = req.query.to || null;

  let sql = `SELECT id, lat, lng, speed_kmh, heading, recorded_at, satellites, altitude, ignition
             FROM gps_pings WHERE bike_id = ?`;
  const params = [device.bike_id];
  if (from) { sql += ' AND recorded_at >= ?'; params.push(from); }
  if (to) { sql += ' AND recorded_at <= ?'; params.push(to); }
  sql += ' ORDER BY recorded_at DESC LIMIT ?';
  params.push(limit);

  const positions = db.prepare(sql).all(...params);
  res.json(positions.reverse()); // chronological for trail rendering
});

// ---------- Commands ----------

// POST /api/tracking/devices/:id/commands
router.post('/devices/:id/commands', authRequired, adminOnly, async (req, res) => {
  const device = db.prepare('SELECT * FROM tracking_devices WHERE id=?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

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

  const info = db.prepare(
    `INSERT INTO tracking_commands (device_id, command, created_by) VALUES (?,?,?)`
  ).run(device.id, command, req.user.id);

  const cmdId = info.lastInsertRowid;
  const sentNow = teltonikaServer.sendCommand(device.imei, cmdId, command);

  res.json({
    id: cmdId,
    command,
    status: sentNow ? 'sent' : 'pending',
    note: sentNow ? 'Command sent to device' : 'Device offline — command will be sent when it reconnects'
  });
});

// GET /api/tracking/devices/:id/commands
router.get('/devices/:id/commands', authRequired, adminOnly, (req, res) => {
  const device = db.prepare('SELECT id FROM tracking_devices WHERE id=?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const commands = db.prepare(
    `SELECT tc.*, u.full_name AS created_by_name
     FROM tracking_commands tc LEFT JOIN users u ON u.id = tc.created_by
     WHERE tc.device_id = ? ORDER BY tc.created_at DESC LIMIT 100`
  ).all(device.id);
  res.json(commands);
});

// ---------- Map overview ----------

// GET /api/tracking/map — latest position for all bikes with a device
router.get('/map', authRequired, adminOnly, (req, res) => {
  const connected = teltonikaServer.getConnectedIMEIs();
  const devices = db.prepare(`
    SELECT td.id, td.imei, td.model, td.label, td.last_seen_at,
           b.id AS bike_id, b.registration, b.make, b.model AS bike_model, b.status AS bike_status,
           b.color AS bike_color, b.vin AS bike_vin, b.year AS bike_year,
           b.last_known_lat AS lat, b.last_known_lng AS lng, b.last_location_at,
           b.odometer_km, b.organization_id, o.name AS organization_name,
           gp.speed_kmh, gp.heading, gp.ignition, gp.satellites, gp.altitude, gp.io_data,
           (SELECT u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_name,
           (SELECT u.phone    FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_phone,
           (SELECT u.address  FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_address,
           (SELECT u.city     FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_city
    FROM tracking_devices td
    JOIN bikes b ON b.id = td.bike_id
    LEFT JOIN organizations o ON o.id = b.organization_id
    LEFT JOIN gps_pings gp ON gp.id = (
      SELECT id FROM gps_pings WHERE bike_id = b.id ORDER BY recorded_at DESC LIMIT 1
    )
    WHERE b.last_known_lat IS NOT NULL AND b.last_known_lng IS NOT NULL
    ORDER BY td.last_seen_at DESC
  `).all();
  for (const d of devices) d.connected = connected.includes(d.imei) ? 1 : 0;
  res.json(devices);
});

// GET /api/tracking/live — SSE stream of real-time GPS pings
router.get('/live', authRequired, adminOnly, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const onPing = (payload) => {
    try { res.write(`event: ping\ndata: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  };
  const onAlert = (payload) => {
    try { res.write(`event: alert\ndata: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  };

  trackingEvents.on('ping', onPing);
  trackingEvents.on('alert', onAlert);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 25_000);

  req.on('close', () => {
    trackingEvents.off('ping', onPing);
    trackingEvents.off('alert', onAlert);
    clearInterval(hb);
  });
});

// ---------- Geofences ----------

router.get('/geofences', authRequired, adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT gf.*, b.registration AS bike_registration
    FROM geofences gf LEFT JOIN bikes b ON b.id = gf.bike_id
    ORDER BY gf.created_at DESC
  `).all();
  res.json(rows);
});

router.post('/geofences', authRequired, adminOnly, (req, res) => {
  const { name, lat, lng, radius_m, bike_id } = req.body;
  if (!name || lat == null || lng == null) return res.status(400).json({ error: 'name, lat and lng are required' });
  const radius = Number(radius_m) || 500;
  if (radius < 50 || radius > 50000) return res.status(400).json({ error: 'radius_m must be 50–50000' });
  const info = db.prepare(
    'INSERT INTO geofences (name, lat, lng, radius_m, bike_id, created_by) VALUES (?,?,?,?,?,?)'
  ).run(name, Number(lat), Number(lng), radius, bike_id || null, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/geofences/:id', authRequired, adminOnly, (req, res) => {
  const gf = db.prepare('SELECT id FROM geofences WHERE id=?').get(req.params.id);
  if (!gf) return res.status(404).json({ error: 'Geofence not found' });
  const { name, lat, lng, radius_m, bike_id, active } = req.body;
  db.prepare(`
    UPDATE geofences SET
      name    = COALESCE(?, name),
      lat     = COALESCE(?, lat),
      lng     = COALESCE(?, lng),
      radius_m= COALESCE(?, radius_m),
      bike_id = CASE WHEN ? THEN ? ELSE bike_id END,
      active  = COALESCE(?, active)
    WHERE id = ?
  `).run(
    name || null,
    lat != null ? Number(lat) : null,
    lng != null ? Number(lng) : null,
    radius_m != null ? Number(radius_m) : null,
    'bike_id' in req.body ? 1 : 0, bike_id || null,
    active != null ? Number(active) : null,
    gf.id,
  );
  res.json({ ok: true });
});

router.delete('/geofences/:id', authRequired, adminOnly, (req, res) => {
  const gf = db.prepare('SELECT id FROM geofences WHERE id=?').get(req.params.id);
  if (!gf) return res.status(404).json({ error: 'Geofence not found' });
  db.prepare('DELETE FROM geofences WHERE id=?').run(gf.id);
  res.json({ ok: true });
});

// ---------- Trips ----------

router.get('/trips', authRequired, adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const bikeId = req.query.bike_id ? Number(req.query.bike_id) : null;
  let sql = `
    SELECT t.*, b.registration AS bike_registration
    FROM trips t LEFT JOIN bikes b ON b.id = t.bike_id
    WHERE 1=1
  `;
  const params = [];
  if (bikeId) { sql += ' AND t.bike_id = ?'; params.push(bikeId); }
  sql += ' ORDER BY t.started_at DESC LIMIT ?';
  params.push(limit);
  res.json(db.prepare(sql).all(...params));
});

// ---------- Alerts ----------

router.get('/alerts', authRequired, adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const bikeId = req.query.bike_id ? Number(req.query.bike_id) : null;
  const unackedOnly = req.query.unacked === '1';
  let sql = `
    SELECT ta.*, b.registration AS bike_registration
    FROM tracking_alerts ta LEFT JOIN bikes b ON b.id = ta.bike_id
    WHERE 1=1
  `;
  const params = [];
  if (bikeId) { sql += ' AND ta.bike_id = ?'; params.push(bikeId); }
  if (unackedOnly) sql += ' AND ta.acknowledged_at IS NULL';
  sql += ' ORDER BY ta.created_at DESC LIMIT ?';
  params.push(limit);
  res.json(db.prepare(sql).all(...params));
});

router.put('/alerts/:id/acknowledge', authRequired, adminOnly, (req, res) => {
  const alert = db.prepare('SELECT id FROM tracking_alerts WHERE id=?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  db.prepare('UPDATE tracking_alerts SET acknowledged_at=CURRENT_TIMESTAMP WHERE id=?').run(alert.id);
  res.json({ ok: true });
});

router.post('/alerts/acknowledge-all', authRequired, adminOnly, (req, res) => {
  const bikeId = req.body.bike_id ? Number(req.body.bike_id) : null;
  if (bikeId) {
    db.prepare('UPDATE tracking_alerts SET acknowledged_at=CURRENT_TIMESTAMP WHERE bike_id=? AND acknowledged_at IS NULL').run(bikeId);
  } else {
    db.prepare('UPDATE tracking_alerts SET acknowledged_at=CURRENT_TIMESTAMP WHERE acknowledged_at IS NULL').run();
  }
  res.json({ ok: true });
});

module.exports = router;

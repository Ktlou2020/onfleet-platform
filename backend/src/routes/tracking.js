'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const teltonikaServer = require('../tcp/teltonikaServer');

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
  get_param: () => 'getparam 2001', // server IP
};

// ---------- Devices ----------

// GET /api/tracking/devices
router.get('/devices', authRequired, adminOnly, (req, res) => {
  const devices = db.prepare(`
    SELECT td.*, b.registration, b.make, b.model AS bike_model, b.last_known_lat, b.last_known_lng, b.last_location_at
    FROM tracking_devices td
    LEFT JOIN bikes b ON b.id = td.bike_id
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
  const { model, bike_id, label } = req.body;
  const validModels = ['FMB920', 'FMB965', 'FMC920', 'other'];
  if (model !== undefined && !validModels.includes(model)) return res.status(400).json({ error: `Model must be one of: ${validModels.join(', ')}` });
  const device = db.prepare('SELECT id FROM tracking_devices WHERE id=?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  db.prepare(`UPDATE tracking_devices SET model=COALESCE(?,model), bike_id=?, label=COALESCE(?,label), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(model || null, bike_id !== undefined ? (bike_id || null) : null, label || null, device.id);
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
           b.last_known_lat AS lat, b.last_known_lng AS lng, b.last_location_at,
           gp.speed_kmh, gp.heading, gp.ignition, gp.satellites, gp.altitude
    FROM tracking_devices td
    JOIN bikes b ON b.id = td.bike_id
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

  teltonikaServer.trackingEvents.on('ping', onPing);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 25_000);

  req.on('close', () => {
    teltonikaServer.trackingEvents.off('ping', onPing);
    clearInterval(hb);
  });
});

module.exports = router;

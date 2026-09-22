'use strict';

const express = require('express');
const multer = require('multer');
const pgDb = require('../pgDb');
const { authRequired, adminOnly, trackingReadOnly } = require('../middleware/auth');
const teltonikaServer = require('../tcp/teltonikaServer');
const trackingEvents = require('../trackingEvents');
const riskService = require('../services/riskService');
const { reloadGeofences } = require('../services/geofenceService');
const { logAudit } = require('../utils/helpersPg');
const { cutCommandForModel, restoreCommandForModel } = require('../services/engineCommands');
const gpsImportService = require('../services/gpsImportService');
const asyncRouter = require('../utils/asyncRouter');
const { ALL_ALERT_TYPES } = require('../constants/alertTypes');
const { ALERT_OUTCOMES, ALERT_OUTCOME_IDS, REAL_OUTCOME_IDS } = require('../constants/alertOutcomes');
const { notifyRiderEngineState } = require('../services/engineCutNotifier');

const router = asyncRouter(express.Router());
const gpsImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const PRESET_COMMANDS = {
  cut_engine:     (model) => cutCommandForModel(model),
  restore_engine: (model) => restoreCommandForModel(model),
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
// Bike/org/rider map for a list of bike IDs — bikes/organizations/users all
// live in the same Postgres database now, so this is a single real query
// instead of a per-row SQLite lookup loop.
async function getBikeMap(bikeIds) {
  if (!bikeIds.length) return {};
  const { rows: bikes } = await pgDb.query(`
    SELECT b.id, b.registration, b.make, b.model, b.color, b.vin, b.year, b.status,
           b.last_known_lat, b.last_known_lng, b.last_location_at, b.odometer_km,
           b.organization_id, o.name AS organization_name,
           (SELECT u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_name,
           (SELECT u.phone    FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_phone,
           (SELECT u.address  FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_address,
           (SELECT u.city     FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_city,
           (SELECT u.address_match_status FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_address_match_status
    FROM bikes b LEFT JOIN organizations o ON o.id = b.organization_id
    WHERE b.id = ANY($1)
  `, [bikeIds]);
  const map = {};
  for (const b of bikes) map[b.id] = b;
  return map;
}

// Batch-fetch bike registration + current rider (name/phone only — never
// full address/PII here, this feeds alert lists control room sees constantly)
// for a set of tracking rows that each carry a bike_id — one query instead
// of one SELECT per row.
async function attachBikeRegistrations(rowsWithBikeId, bikeIdKey = 'bike_id') {
  const ids = [...new Set(rowsWithBikeId.map(r => r[bikeIdKey]).filter(Boolean))];
  if (!ids.length) {
    for (const r of rowsWithBikeId) { r.bike_registration = null; r.rider_name = null; r.rider_phone = null; }
    return;
  }
  const { rows: bikes } = await pgDb.query(`
    SELECT b.id, b.registration,
      (SELECT u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_name,
      (SELECT u.phone     FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_phone
    FROM bikes b WHERE b.id = ANY($1)
  `, [ids]);
  const byId = new Map(bikes.map(b => [b.id, b]));
  for (const r of rowsWithBikeId) {
    const b = byId.get(r[bikeIdKey]);
    r.bike_registration = b?.registration || null;
    r.rider_name = b?.rider_name || null;
    r.rider_phone = b?.rider_phone || null;
  }
}

// ---------- Devices ----------

router.get('/devices', authRequired, trackingReadOnly, async (req, res) => {
  const { rows: devices } = await pgDb.query(
    `SELECT * FROM tracking_devices ORDER BY connected DESC, last_seen_at DESC`
  );
  const connected = teltonikaServer.getConnectedIMEIs();
  const bikeIds = [...new Set(devices.map(d => d.bike_id).filter(Boolean))];
  const bikeMap = await getBikeMap(bikeIds);
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
      rider_address_match_status: bikeMap[d.bike_id].rider_address_match_status,
    } : {}),
  }));
  res.json(result);
});

router.get('/devices/:id', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT * FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
  const d = rows[0];
  let bike = null;
  if (d.bike_id) {
    const { rows: bikeRows } = await pgDb.query(`
      SELECT b.registration, b.make, b.model, b.last_known_lat, b.last_known_lng, b.last_location_at
      FROM bikes b WHERE b.id = $1
    `, [d.bike_id]);
    bike = bikeRows[0] || null;
  }
  const connImeis = teltonikaServer.getConnectedIMEIs();
  const status = deviceStatus(d.imei, d.last_seen_at, connImeis);
  res.json({ ...d, device_status: status, connected: status !== 'offline' ? 1 : 0, ...(bike || {}) });
});

// Registering, relinking and removing trackers are audited. Before this there
// was no record of who put a tracker on which bike, so a tracker found on the
// wrong (or a paid-off) bike couldn't be traced back. Plates are stored with
// the bike ids so the entry still reads correctly if a bike is renamed, and
// the IMEI is in every entry so the audit log search finds it.
async function bikePlate(bikeId) {
  if (!bikeId) return null;
  const { rows } = await pgDb.query('SELECT registration FROM bikes WHERE id=$1', [bikeId]);
  return rows[0]?.registration || null;
}

router.post('/devices', authRequired, adminOnly, async (req, res) => {
  const { imei, model, bike_id, label } = req.body;
  if (!imei || String(imei).trim().length < 10) return res.status(400).json({ error: 'Valid IMEI required' });
  const validModels = ['FMB920', 'FMB965', 'FMC920', 'other'];
  if (model && !validModels.includes(model)) return res.status(400).json({ error: `Model must be one of: ${validModels.join(', ')}` });
  const cleanImei = String(imei).trim();
  try {
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, model, bike_id, label) VALUES ($1,$2,$3,$4) RETURNING id`,
      [cleanImei, model || 'other', bike_id || null, label || null]
    );
    await logAudit(req.user.id, 'tracking.device_register', 'tracking_devices', rows[0].id, {
      imei: cleanImei, model: model || 'other', label: label || null,
      bike_id: bike_id || null, registration: await bikePlate(bike_id),
    }, req.ip);
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.message.includes('unique') || err.code === '23505') {
      // A failed attempt is worth keeping too: it usually means someone tried
      // to put a tracker that is already in use onto a second bike.
      const { rows: existing } = await pgDb.query('SELECT id, bike_id FROM tracking_devices WHERE imei=$1', [cleanImei]);
      await logAudit(req.user.id, 'tracking.device_register_rejected', 'tracking_devices', existing[0]?.id || null, {
        imei: cleanImei, reason: 'IMEI already registered',
        attempted_bike_id: bike_id || null, attempted_registration: await bikePlate(bike_id),
        current_bike_id: existing[0]?.bike_id || null, current_registration: await bikePlate(existing[0]?.bike_id),
      }, req.ip);
      return res.status(409).json({ error: 'IMEI already registered' });
    }
    throw err;
  }
});

router.put('/devices/:id', authRequired, adminOnly, async (req, res) => {
  const { model, label } = req.body;
  const validModels = ['FMB920', 'FMB965', 'FMC920', 'other'];
  if (model !== undefined && !validModels.includes(model)) return res.status(400).json({ error: `Model must be one of: ${validModels.join(', ')}` });
  const speedLimit = req.body.speed_limit_kmh != null ? Number(req.body.speed_limit_kmh) : null;
  if (speedLimit !== null && (speedLimit < 10 || speedLimit > 300)) return res.status(400).json({ error: 'speed_limit_kmh must be 10–300' });
  const { rows } = await pgDb.query('SELECT id, imei, model, bike_id, label, speed_limit_kmh FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
  const before = rows[0];
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
  const { rows: afterRows } = await pgDb.query('SELECT model, bike_id, label, speed_limit_kmh FROM tracking_devices WHERE id=$1', [before.id]);
  const after = afterRows[0];
  const changes = {};
  for (const field of ['model', 'label', 'speed_limit_kmh']) {
    if (String(before[field] ?? '') !== String(after[field] ?? '')) changes[field] = { from: before[field], to: after[field] };
  }
  const relinked = String(before.bike_id ?? '') !== String(after.bike_id ?? '');
  if (relinked) {
    const action = !after.bike_id ? 'tracking.device_unlink' : !before.bike_id ? 'tracking.device_link' : 'tracking.device_relink';
    await logAudit(req.user.id, action, 'tracking_devices', before.id, {
      imei: before.imei,
      from_bike_id: before.bike_id, from_registration: await bikePlate(before.bike_id),
      to_bike_id: after.bike_id, to_registration: await bikePlate(after.bike_id),
      ...(Object.keys(changes).length ? { changes } : {}),
    }, req.ip);
  } else if (Object.keys(changes).length) {
    await logAudit(req.user.id, 'tracking.device_update', 'tracking_devices', before.id, {
      imei: before.imei, bike_id: after.bike_id, registration: await bikePlate(after.bike_id), changes,
    }, req.ip);
  }
  res.json({ ok: true });
});

router.delete('/devices/:id', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT id, imei, model, bike_id, label FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
  await pgDb.query('DELETE FROM tracking_devices WHERE id=$1', [rows[0].id]);
  await logAudit(req.user.id, 'tracking.device_delete', 'tracking_devices', rows[0].id, {
    imei: rows[0].imei, model: rows[0].model, label: rows[0].label,
    bike_id: rows[0].bike_id, registration: await bikePlate(rows[0].bike_id),
  }, req.ip);
  res.json({ ok: true });
});

// Clear a device from the Health tab after reading it. Stores which issue
// categories were acknowledged (not the display text — that includes
// fluctuating numbers like a battery %) so the row reappears if the
// situation changes rather than staying silently dismissed forever.
router.put('/devices/:id/health-ack', authRequired, trackingReadOnly, async (req, res) => {
  const signature = String(req.body.signature || '').trim();
  if (!signature) return res.status(400).json({ error: 'signature is required' });
  const { rows } = await pgDb.query('SELECT id FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
  await pgDb.query(
    'UPDATE tracking_devices SET health_ack_at=NOW(), health_ack_signature=$1 WHERE id=$2',
    [signature, rows[0].id]
  );
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

  // Track cut state persistently — setdigout doesn't survive a device power
  // cycle, so a cut must be re-asserted on every reconnect (teltonikaServer.js)
  // until explicitly restored, or a rider can defeat it by cycling power.
  if (req.body.preset === 'cut_engine') {
    await pgDb.query(
      `UPDATE tracking_devices SET engine_cut_active=TRUE, engine_cut_reason='Manual cut', engine_cut_at=NOW(), engine_cut_by=$1 WHERE id=$2`,
      [req.user.id, device.id]
    );
    await logAudit(req.user.id, 'tracking.engine_cut', 'tracking_devices', device.id, { bike_id: device.bike_id, imei: device.imei }, req.ip);
    notifyRiderEngineState(device.bike_id, 'cut', { reason: req.body.reason || null })
      .catch((e) => console.error('[EngineCut] rider notify failed:', e.message));
  } else if (req.body.preset === 'restore_engine') {
    await pgDb.query(
      `UPDATE tracking_devices SET engine_cut_active=FALSE, engine_cut_reason=NULL, engine_cut_at=NULL, engine_cut_by=NULL WHERE id=$1`,
      [device.id]
    );
    await logAudit(req.user.id, 'tracking.engine_restore', 'tracking_devices', device.id, { bike_id: device.bike_id, imei: device.imei }, req.ip);
    notifyRiderEngineState(device.bike_id, 'restored')
      .catch((e) => console.error('[EngineCut] rider notify failed:', e.message));
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

// Bulk command dispatch — deliberately preset-only (no raw `command`), so a
// bulk action is always one of the small set of things the UI actually
// offers and reviews before sending, not an arbitrary string fanned out
// across many real vehicles at once.
router.post('/devices/commands-bulk', authRequired, adminOnly, async (req, res) => {
  const preset = req.body.preset;
  const fn = PRESET_COMMANDS[preset];
  if (!fn) return res.status(400).json({ error: `Unknown preset. Available: ${Object.keys(PRESET_COMMANDS).join(', ')}` });
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isFinite))] : [];
  if (!ids.length) return res.status(400).json({ error: 'No devices selected' });
  if (ids.length > 100) return res.status(400).json({ error: 'Too many devices selected (max 100)' });

  const { rows: devices } = await pgDb.query('SELECT * FROM tracking_devices WHERE id = ANY($1)', [ids]);
  const results = [];
  for (const device of devices) {
    const command = fn(device.model);
    const { rows: cmdRows } = await pgDb.query(
      `INSERT INTO tracking_commands (device_id, command, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [device.id, command, req.user.id]
    );
    const cmdId = cmdRows[0].id;
    const sentNow = teltonikaServer.sendCommand(device.imei, cmdId, command);

    if (preset === 'cut_engine') {
      await pgDb.query(
        `UPDATE tracking_devices SET engine_cut_active=TRUE, engine_cut_reason='Manual cut (bulk)', engine_cut_at=NOW(), engine_cut_by=$1 WHERE id=$2`,
        [req.user.id, device.id]
      );
      await logAudit(req.user.id, 'tracking.engine_cut', 'tracking_devices', device.id, { bike_id: device.bike_id, imei: device.imei, bulk: true }, req.ip);
      notifyRiderEngineState(device.bike_id, 'cut', { reason: req.body.reason || null })
        .catch((e) => console.error('[EngineCut] rider notify failed:', e.message));
    } else if (preset === 'restore_engine') {
      await pgDb.query(
        `UPDATE tracking_devices SET engine_cut_active=FALSE, engine_cut_reason=NULL, engine_cut_at=NULL, engine_cut_by=NULL WHERE id=$1`,
        [device.id]
      );
      await logAudit(req.user.id, 'tracking.engine_restore', 'tracking_devices', device.id, { bike_id: device.bike_id, imei: device.imei, bulk: true }, req.ip);
      notifyRiderEngineState(device.bike_id, 'restored')
        .catch((e) => console.error('[EngineCut] rider notify failed:', e.message));
    }

    results.push({ device_id: device.id, imei: device.imei, status: sentNow ? 'sent' : 'queued' });
  }

  const skipped = ids.length - devices.length;
  res.json({ results, sent_count: results.length, skipped_count: skipped });
});

router.get('/devices/:id/commands', authRequired, trackingReadOnly, async (req, res) => {
  const { rows: devRows } = await pgDb.query('SELECT id FROM tracking_devices WHERE id=$1', [req.params.id]);
  if (!devRows[0]) return res.status(404).json({ error: 'Device not found' });
  const { rows } = await pgDb.query(
    `SELECT tc.* FROM tracking_commands tc WHERE tc.device_id=$1 ORDER BY tc.created_at DESC LIMIT 100`,
    [devRows[0].id]
  );
  // Enrich created_by with the user's name
  const creatorIds = [...new Set(rows.map(cmd => cmd.created_by).filter(Boolean))];
  if (creatorIds.length) {
    const { rows: users } = await pgDb.query('SELECT id, full_name FROM users WHERE id = ANY($1)', [creatorIds]);
    const nameById = new Map(users.map(u => [u.id, u.full_name]));
    for (const cmd of rows) cmd.created_by_name = cmd.created_by ? (nameById.get(cmd.created_by) || null) : null;
  }
  res.json(rows);
});

// ---------- Map overview ----------

router.get('/map', authRequired, trackingReadOnly, async (req, res) => {
  const connected = teltonikaServer.getConnectedIMEIs();

  // Devices, bike/org/rider info, and the latest GPS ping per bike used to be
  // 3 round-trips merged in JS — one query now that tracking and business
  // data share a database, with a LATERAL join for "latest ping per bike".
  const { rows } = await pgDb.query(
    `SELECT td.id, td.imei, td.model, td.label, td.last_seen_at, td.bike_id,
            b.registration, b.make, b.model AS bike_model,
            b.status AS bike_status, b.color AS bike_color, b.vin AS bike_vin, b.year AS bike_year,
            b.last_known_lat AS lat, b.last_known_lng AS lng, b.last_location_at,
            b.odometer_km,
            b.organization_id, o.name AS organization_name,
            (SELECT u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_name,
            (SELECT u.phone    FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_phone,
            (SELECT u.address  FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_address,
            (SELECT u.city     FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_city,
            p.speed_kmh, p.heading, p.ignition, p.satellites, p.altitude, p.io_data
     FROM tracking_devices td
     JOIN bikes b ON b.id = td.bike_id
     LEFT JOIN organizations o ON o.id = b.organization_id
     LEFT JOIN LATERAL (
       SELECT speed_kmh, heading, ignition, satellites, altitude, io_data
       FROM gps_pings gp WHERE gp.bike_id = b.id ORDER BY gp.recorded_at DESC LIMIT 1
     ) p ON true
     WHERE td.bike_id IS NOT NULL AND b.last_known_lat IS NOT NULL`
  );

  const riskMap = riskService.getCurrentScores();
  const result = rows.map(r => {
    const risk = riskMap[r.bike_id];
    return {
      ...r,
      device_status: deviceStatus(r.imei, r.last_seen_at, connected),
      connected: isOnline(r.imei, r.last_seen_at, connected),
      risk_score: risk?.score ?? null, risk_level: risk?.level ?? null, risk_reasons: risk?.reasons ?? null,
    };
  });
  res.json(result);
});

// ---------- AI theft/anomaly risk ----------

router.get('/risk', authRequired, trackingReadOnly, async (req, res) => {
  const riskMap = riskService.getCurrentScores();
  const bikeIds = Object.keys(riskMap).map(Number);
  const bikeMap = await getBikeMap(bikeIds);
  const result = bikeIds
    .map(bikeId => ({ bike_id: bikeId, registration: bikeMap[bikeId]?.registration || null, ...riskMap[bikeId] }))
    .sort((a, b) => b.score - a.score);
  res.json(result);
});

// ---------- Dashboard ----------

// Must match CRITICAL_ALERT_TYPES in frontend/src/lib/alertMeta.js.
const CRITICAL_ALERT_TYPES_SQL = ['panic', 'tamper', 'power_disconnect', 'movement', 'theft_risk', 'night_movement', 'towing'];

router.get('/dashboard', authRequired, trackingReadOnly, async (req, res) => {
  const { todayStart, weekStart } = sastDayAndWeekStart();
  const connected = teltonikaServer.getConnectedIMEIs();

  const [
    { rows: deviceRows },
    { rows: coverageRows },
    { rows: alertsByType },
    { rows: alertCounterRows },
    { rows: tripRows },
    { rows: stolenRows },
  ] = await Promise.all([
    pgDb.query('SELECT imei, last_seen_at, engine_cut_active FROM tracking_devices'),
    // Coverage is measured against bikes out with riders. Paid-off, stolen and
    // workshop bikes aren't expected to carry a tracker, and counting them made
    // the fleet look 5% covered when the real gap is the active fleet.
    pgDb.query(`
      SELECT COUNT(*) AS total_in_service,
             COUNT(*) FILTER (WHERE id IN (SELECT bike_id FROM tracking_devices WHERE bike_id IS NOT NULL)) AS with_device
      FROM bikes WHERE status = 'active'
    `),
    pgDb.query(
      `SELECT alert_type, COUNT(*) AS count FROM tracking_alerts WHERE created_at >= $1 GROUP BY alert_type ORDER BY count DESC`,
      [todayStart.toISOString()]
    ),
    pgDb.query(
      `SELECT
         COUNT(*) FILTER (WHERE resolved_at IS NULL)                                  AS open_total,
         COUNT(*) FILTER (WHERE resolved_at IS NULL AND acknowledged_at IS NULL)       AS unacknowledged,
         COUNT(*) FILTER (WHERE resolved_at IS NULL AND alert_type = ANY($1))          AS critical_open,
         COUNT(*) FILTER (WHERE created_at >= $2)                                      AS today_total,
         COUNT(*) FILTER (WHERE resolved_at >= $2)                                     AS resolved_today
       FROM tracking_alerts`,
      [CRITICAL_ALERT_TYPES_SQL, todayStart.toISOString()]
    ),
    pgDb.query(
      `SELECT
         COUNT(*) FILTER (WHERE started_at >= $1)                      AS today_trips,
         COALESCE(SUM(distance_km) FILTER (WHERE started_at >= $1), 0) AS today_km,
         COUNT(*) FILTER (WHERE started_at >= $2)                      AS week_trips,
         COALESCE(SUM(distance_km) FILTER (WHERE started_at >= $2), 0) AS week_km
       FROM trips`,
      [todayStart.toISOString(), weekStart.toISOString()]
    ),
    pgDb.query(`SELECT COUNT(*) AS count FROM bikes WHERE status = 'stolen'`),
  ]);

  const devices = { active: 0, sleeping: 0, offline: 0 };
  let neverConnected = 0;
  for (const d of deviceRows) {
    if (!d.last_seen_at) neverConnected += 1;
    const status = deviceStatus(d.imei, d.last_seen_at, connected);
    devices[status] = (devices[status] || 0) + 1;
  }
  const engineCutsActive = deviceRows.filter((d) => d.engine_cut_active).length;

  const riskMap = riskService.getCurrentScores();
  const riskBikeIds = Object.keys(riskMap).map(Number);
  const riskBikeMap = await getBikeMap(riskBikeIds);
  const topRiskBikes = riskBikeIds
    .map((bikeId) => ({ bike_id: bikeId, registration: riskBikeMap[bikeId]?.registration || null, ...riskMap[bikeId] }))
    .filter((r) => r.level !== 'normal')
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const c = alertCounterRows[0];
  const t = tripRows[0];
  const coverage = coverageRows[0];

  res.json({
    devices: {
      total: deviceRows.length,
      active: devices.active || 0,
      sleeping: devices.sleeping || 0,
      offline: devices.offline || 0,
      never_connected: neverConnected,
    },
    fleet_coverage: {
      total_in_service: Number(coverage.total_in_service),
      with_device: Number(coverage.with_device),
    },
    engine_cuts_active: engineCutsActive,
    stolen_bikes: Number(stolenRows[0].count),
    alerts: {
      open_total: Number(c.open_total),
      unacknowledged: Number(c.unacknowledged),
      critical_open: Number(c.critical_open),
      today_total: Number(c.today_total),
      resolved_today: Number(c.resolved_today),
      today_by_type: alertsByType.map((r) => ({ alert_type: r.alert_type, count: Number(r.count) })),
    },
    trips: {
      today_trips: Number(t.today_trips),
      today_km: Number(t.today_km),
      week_trips: Number(t.week_trips),
      week_km: Number(t.week_km),
    },
    top_risk_bikes: topRiskBikes,
  });
});

// ---------- SSE live stream ----------

router.get('/live', authRequired, trackingReadOnly, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const onPing         = (p) => { try { res.write(`event: ping\ndata: ${JSON.stringify(p)}\n\n`); } catch {} };
  // The control room's stream carries only what its list would show, so an
  // alert can't arrive live that the page then can't find.
  let hidden = new Set();
  if (!seesEverything(req.user)) {
    controlRoomHiddenTypes().then((set) => { hidden = set; }).catch(() => {});
  }
  const visible = (p) => !p?.alert_type || !hidden.has(p.alert_type);
  const onAlert         = (p) => { try { if (visible(p)) res.write(`event: alert\ndata: ${JSON.stringify(p)}\n\n`); } catch {} };
  const onAlertResolved = (p) => { try { if (visible(p)) res.write(`event: alert_resolved\ndata: ${JSON.stringify(p)}\n\n`); } catch {} };
  const onDeviceStatus = (p) => { try { res.write(`event: device_status\ndata: ${JSON.stringify(p)}\n\n`); } catch {} };
  const onRiskUpdate   = (p) => { try { res.write(`event: risk_update\ndata: ${JSON.stringify(p)}\n\n`); } catch {} };
  trackingEvents.on('ping', onPing);
  trackingEvents.on('alert', onAlert);
  trackingEvents.on('alert_resolved', onAlertResolved);
  trackingEvents.on('device_status', onDeviceStatus);
  trackingEvents.on('risk_update', onRiskUpdate);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 25_000);
  req.on('close', () => {
    trackingEvents.off('ping', onPing);
    trackingEvents.off('alert', onAlert);
    trackingEvents.off('alert_resolved', onAlertResolved);
    trackingEvents.off('device_status', onDeviceStatus);
    trackingEvents.off('risk_update', onRiskUpdate);
    clearInterval(hb);
  });
});

// ---------- Geofences ----------

router.get('/geofences', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query(`SELECT * FROM geofences ORDER BY created_at DESC`);
  await attachBikeRegistrations(rows);
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
  reloadGeofences();
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
  reloadGeofences();
  res.json({ ok: true });
});

router.delete('/geofences/:id', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT id FROM geofences WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Geofence not found' });
  await pgDb.query('DELETE FROM geofences WHERE id=$1', [rows[0].id]);
  reloadGeofences();
  res.json({ ok: true });
});

// ---------- Trips ----------

// South Africa Standard Time is a fixed UTC+2 offset year-round (no DST).
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// Returns UTC instants for the start of "today" and the start of "this week"
// (Monday) as observed in SAST, regardless of the server's own timezone.
function sastDayAndWeekStart() {
  const shifted = new Date(Date.now() + SAST_OFFSET_MS); // UTC fields == SAST wall-clock fields
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  const todayStart = new Date(Date.UTC(y, m, d, 0, 0, 0) - SAST_OFFSET_MS);
  const dayOfWeek = (shifted.getUTCDay() + 6) % 7; // Mon=0 … Sun=6, in SAST wall-clock
  const weekStart = new Date(todayStart.getTime() - dayOfWeek * 86400000);
  return { todayStart, weekStart };
}

router.get('/trips/stats', authRequired, trackingReadOnly, async (req, res) => {
  const bikeId = req.query.bike_id ? Number(req.query.bike_id) : null;
  if (!bikeId) return res.status(400).json({ error: 'bike_id is required' });
  const { todayStart, weekStart } = sastDayAndWeekStart();

  const { rows } = await pgDb.query(
    `SELECT
       COUNT(*) FILTER (WHERE started_at >= $2)                        AS today_trips,
       COALESCE(SUM(distance_km) FILTER (WHERE started_at >= $2), 0)   AS today_km,
       COALESCE(SUM(duration_sec) FILTER (WHERE started_at >= $2), 0)  AS today_sec,
       COUNT(*) FILTER (WHERE started_at >= $3)                        AS week_trips,
       COALESCE(SUM(distance_km) FILTER (WHERE started_at >= $3), 0)   AS week_km,
       COALESCE(SUM(duration_sec) FILTER (WHERE started_at >= $3), 0)  AS week_sec,
       COALESCE(MAX(max_speed_kmh) FILTER (WHERE started_at >= $3), 0) AS week_top_speed_kmh
     FROM trips WHERE bike_id=$1`,
    [bikeId, todayStart.toISOString(), weekStart.toISOString()]
  );
  const r = rows[0];
  res.json({
    today: { trips: Number(r.today_trips), km: Number(r.today_km), sec: Number(r.today_sec) },
    week:  { trips: Number(r.week_trips),  km: Number(r.week_km),  sec: Number(r.week_sec), top_speed_kmh: Number(r.week_top_speed_kmh) },
  });
});

router.get('/trips', authRequired, trackingReadOnly, async (req, res) => {
  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const bikeId = req.query.bike_id ? Number(req.query.bike_id) : null;
  const params = [];
  let sql = 'SELECT * FROM trips WHERE 1=1';
  if (bikeId) { params.push(bikeId); sql += ` AND bike_id=$${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY started_at DESC LIMIT $${params.length}`;
  const { rows } = await pgDb.query(sql, params);
  await attachBikeRegistrations(rows);
  res.json(rows);
});

// ---------- Alerts ----------

// Which alert types the control room is shown. An outsourced room watching for
// theft does not need a month of idling alerts, and that noise is what makes a
// tamper alert easy to miss. Only their view is narrowed: the alert is still
// raised, still escalates, and admins still see it.
//
// Visible unless an admin has said otherwise, so a new alert type never
// arrives invisible.
async function controlRoomHiddenTypes(db = pgDb) {
  const { rows } = await db.query(
    `SELECT alert_type FROM alert_settings WHERE control_room_visible = FALSE`);
  return new Set(rows.map((r) => r.alert_type));
}

const seesEverything = (user) => user?.role !== 'control_room';


router.get('/alerts', authRequired, trackingReadOnly, async (req, res) => {
  const limit      = Math.min(Number(req.query.limit) || 100, 500);
  const bikeId     = req.query.bike_id ? Number(req.query.bike_id) : null;
  const unackedOnly = req.query.unacked === '1';
  const status = String(req.query.status || '').trim(); // 'open' | 'resolved'
  const from = req.query.from ? new Date(req.query.from) : null;
  const to   = req.query.to   ? new Date(req.query.to)   : null;
  const params = [];
  let sql = 'SELECT * FROM tracking_alerts WHERE 1=1';
  if (!seesEverything(req.user)) {
    const hidden = await controlRoomHiddenTypes();
    if (hidden.size) { params.push([...hidden]); sql += ` AND alert_type <> ALL($${params.length})`; }
  }
  if (bikeId)     { params.push(bikeId); sql += ` AND bike_id=$${params.length}`; }
  if (unackedOnly) sql += ' AND acknowledged_at IS NULL';
  if (status === 'open')     sql += ' AND resolved_at IS NULL';
  if (status === 'resolved') sql += ' AND resolved_at IS NOT NULL';
  if (from && !Number.isNaN(from.getTime())) { params.push(from.toISOString()); sql += ` AND created_at >= $${params.length}`; }
  if (to && !Number.isNaN(to.getTime()))     { params.push(to.toISOString());   sql += ` AND created_at <= $${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const { rows } = await pgDb.query(sql, params);
  const peopleIds = [...new Set(rows.flatMap(a => [a.resolved_by, a.acknowledged_by]).filter(Boolean))];
  const nameMap = {};
  if (peopleIds.length) {
    const { rows: people } = await pgDb.query('SELECT id, full_name FROM users WHERE id = ANY($1)', [peopleIds]);
    for (const u of people) nameMap[u.id] = u.full_name;
  }
  await attachBikeRegistrations(rows);
  for (const a of rows) {
    a.resolved_by_name = a.resolved_by ? (nameMap[a.resolved_by] || null) : null;
    a.acknowledged_by_name = a.acknowledged_by ? (nameMap[a.acknowledged_by] || null) : null;
  }
  res.json(rows);
});

// Acknowledging stops a critical alert escalating, so it records who did it.
router.put('/alerts/:id/acknowledge', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT id, alert_type, bike_id, acknowledged_at FROM tracking_alerts WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Alert not found' });
  await pgDb.query(
    'UPDATE tracking_alerts SET acknowledged_at=COALESCE(acknowledged_at, NOW()), acknowledged_by=COALESCE(acknowledged_by, $1) WHERE id=$2',
    [req.user.id, rows[0].id]);
  if (!rows[0].acknowledged_at) {
    await logAudit(req.user.id, 'alert.acknowledge', 'tracking_alerts', rows[0].id,
      { alert_type: rows[0].alert_type, bike_id: rows[0].bike_id }, req.ip);
  }
  res.json({ ok: true });
});

// The outcome catalogue, plus how the last 30 days were closed. "Real" alerts
// are the ones an outcome marks as a genuine event, which is the noise ratio
// the control room is judged on.
router.get('/alerts/outcomes', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query(
    `SELECT resolution_outcome AS outcome, COUNT(*)::int AS count
       FROM tracking_alerts
      WHERE resolved_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1`);
  const { rows: [totals] } = await pgDb.query(
    `SELECT COUNT(*)::int AS raised,
            COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS closed,
            COUNT(*) FILTER (WHERE resolution_outcome = ANY($1))::int AS real_events
       FROM tracking_alerts WHERE created_at >= NOW() - INTERVAL '30 days'`, [REAL_OUTCOME_IDS]);
  const { rows: [open] } = await pgDb.query(
    `SELECT COUNT(*)::int AS open,
            COUNT(*) FILTER (WHERE severity IN ('critical','high'))::int AS open_serious,
            MIN(created_at) AS oldest
       FROM tracking_alerts WHERE resolved_at IS NULL`);
  res.json({ outcomes: ALERT_OUTCOMES, counts: rows, totals, open });
});

// Closing takes an outcome from the catalogue, a comment, or both. Demanding
// a typed comment is why nothing was being closed at all; a tap on "False
// alarm" is a better record than an empty queue.
function readOutcome(body) {
  const outcome = body.outcome === undefined || body.outcome === null || body.outcome === '' ? null : String(body.outcome).trim();
  if (outcome && !ALERT_OUTCOME_IDS.includes(outcome)) {
    return { error: `Unknown outcome "${outcome}". Choose one of: ${ALERT_OUTCOME_IDS.join(', ')}` };
  }
  const comment = String(body.comment || '').trim();
  if (!outcome && !comment) return { error: 'Choose an outcome, or write a comment, to close an alert' };
  if (comment.length > 1000) return { error: 'Keep the comment under 1000 characters' };
  return { outcome, comment: comment || null };
}

router.put('/alerts/:id/resolve', authRequired, trackingReadOnly, async (req, res) => {
  const parsed = readOutcome(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { outcome, comment } = parsed;
  const { rows } = await pgDb.query('SELECT * FROM tracking_alerts WHERE id=$1', [req.params.id]);
  const alert = rows[0];
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (alert.resolved_at) return res.status(409).json({ error: 'Alert already closed' });

  const { rows: updated } = await pgDb.query(
    `UPDATE tracking_alerts
     SET resolved_by=$1, resolved_at=NOW(), resolution_comment=$2, resolution_outcome=$3,
         acknowledged_at=COALESCE(acknowledged_at, NOW()), acknowledged_by=COALESCE(acknowledged_by, $1)
     WHERE id=$4 RETURNING *`,
    [req.user.id, comment, outcome, alert.id]
  );
  const resolved = updated[0];
  await attachBikeRegistrations([resolved]);
  resolved.resolved_by_name = req.user.full_name;

  await logAudit(req.user.id, 'alert.resolve', 'tracking_alerts', resolved.id,
    { alert_type: resolved.alert_type, bike_id: resolved.bike_id, outcome, comment }, req.ip);
  trackingEvents.emit('alert_resolved', resolved);

  res.json(resolved);
});

router.post('/alerts/resolve-bulk', authRequired, trackingReadOnly, async (req, res) => {
  const parsed = readOutcome(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { outcome, comment } = parsed;
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isFinite))] : [];
  if (!ids.length) return res.status(400).json({ error: 'No alerts selected' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many alerts selected (max 500)' });

  const { rows: resolved } = await pgDb.query(
    `UPDATE tracking_alerts
     SET resolved_by=$1, resolved_at=NOW(), resolution_comment=$2, resolution_outcome=$3,
         acknowledged_at=COALESCE(acknowledged_at, NOW()), acknowledged_by=COALESCE(acknowledged_by, $1)
     WHERE id = ANY($4) AND resolved_at IS NULL
     RETURNING *`,
    [req.user.id, comment, outcome, ids]
  );

  await attachBikeRegistrations(resolved);
  for (const alert of resolved) {
    alert.resolved_by_name = req.user.full_name;
    await logAudit(req.user.id, 'alert.resolve', 'tracking_alerts', alert.id,
      { alert_type: alert.alert_type, bike_id: alert.bike_id, outcome, comment, bulk: true }, req.ip);
    trackingEvents.emit('alert_resolved', alert);
  }

  const skipped = ids.length - resolved.length;
  res.json({ resolved, resolved_count: resolved.length, skipped_count: skipped });
});

// ---------- Tracker health and installs ----------
// What the tracking platform is actually delivering, and proof that each
// tracker was really installed rather than just registered.

const deviceCommissioning = require('../services/deviceCommissioning');

router.get('/device-health', authRequired, trackingReadOnly, async (req, res) => {
  res.json(await deviceCommissioning.fleetHealth());
});

router.get('/devices/:id/install-check', authRequired, trackingReadOnly, async (req, res) => {
  const result = await deviceCommissioning.runChecks(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'Device not found' });
  res.json(result);
});

router.post('/devices/:id/commission', authRequired, adminOnly, async (req, res) => {
  const deviceId = Number(req.params.id);
  const overrideReason = String(req.body.override_reason || '').trim() || null;
  const notes = String(req.body.notes || '').trim() || null;
  const result = await deviceCommissioning.commission({ deviceId, actorId: req.user.id, notes, overrideReason });
  if (result.error) return res.status(result.checks ? 409 : 404).json(result);
  await logAudit(req.user.id, 'tracking.device_commissioned', 'tracking_devices', deviceId,
    { override_reason: overrideReason, notes }, req.ip);
  res.json(result);
});

// ---------- Theft cases ----------
// The playbook for a bike that may be being taken: a case opens itself on a
// tamper, towing, movement, night-movement, power-disconnect or critical
// theft-risk alert, collects everything that happens to that bike while it is
// open, and closes with an outcome. That is where the recovery rate comes from.

const theftCases = require('../services/theftCaseService');

router.get('/theft-cases', authRequired, trackingReadOnly, async (req, res) => {
  const status = String(req.query.status || 'open');
  const where = status === 'all' ? '' :
    status === 'closed' ? 'WHERE tc.closed_at IS NOT NULL' : 'WHERE tc.closed_at IS NULL';
  const { rows } = await pgDb.query(
    `SELECT tc.*, b.registration, b.make, b.model AS bike_model, b.status AS bike_status,
            b.last_known_lat, b.last_known_lng, b.last_location_at,
            td.imei, td.connected, td.last_seen_at, td.engine_cut_active,
            u.full_name AS opened_by_name, cu.full_name AS closed_by_name,
            (SELECT COUNT(*)::int FROM theft_case_events e WHERE e.case_id = tc.id) AS event_count
       FROM theft_cases tc
       JOIN bikes b ON b.id = tc.bike_id
       LEFT JOIN tracking_devices td ON td.id = tc.device_id
       LEFT JOIN users u ON u.id = tc.opened_by
       LEFT JOIN users cu ON cu.id = tc.closed_by
       ${where}
      ORDER BY tc.opened_at DESC LIMIT 200`);
  res.json(rows);
});

// How the fleet is doing at getting bikes back — the number this whole
// playbook exists to move.
router.get('/theft-cases/stats', authRequired, trackingReadOnly, async (req, res) => {
  const { rows: [all] } = await pgDb.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE closed_at IS NULL)::int AS open,
            COUNT(*) FILTER (WHERE status = 'recovered')::int AS recovered,
            COUNT(*) FILTER (WHERE status = 'false_alarm')::int AS false_alarms,
            COUNT(*) FILTER (WHERE status = 'written_off')::int AS written_off,
            ROUND(AVG(EXTRACT(epoch FROM closed_at - opened_at) / 3600) FILTER (WHERE status = 'recovered')::numeric, 1) AS avg_hours_to_recover
       FROM theft_cases`);
  const genuine = all.recovered + all.written_off;
  res.json({ ...all, recovery_rate_pct: genuine ? Math.round((all.recovered / genuine) * 100) : null });
});

router.get('/theft-cases/:id', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query(
    `SELECT tc.*, b.registration, b.make, b.model AS bike_model, b.status AS bike_status, b.vin,
            td.imei, td.model AS device_model, td.connected, td.last_seen_at, td.engine_cut_active,
            u.full_name AS opened_by_name, cu.full_name AS closed_by_name,
            r.full_name AS rider_name, r.phone AS rider_phone
       FROM theft_cases tc
       JOIN bikes b ON b.id = tc.bike_id
       LEFT JOIN tracking_devices td ON td.id = tc.device_id
       LEFT JOIN users u ON u.id = tc.opened_by
       LEFT JOIN users cu ON cu.id = tc.closed_by
       LEFT JOIN LATERAL (SELECT user_id FROM agreements WHERE bike_id = b.id AND status = 'active' ORDER BY id DESC LIMIT 1) ag ON TRUE
       LEFT JOIN users r ON r.id = ag.user_id
      WHERE tc.id = $1`, [req.params.id]);
  const theftCase = rows[0];
  if (!theftCase) return res.status(404).json({ error: 'Case not found' });

  const { rows: events } = await pgDb.query(
    `SELECT e.*, u.full_name AS actor_name FROM theft_case_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.case_id = $1 ORDER BY e.created_at, e.id`, [theftCase.id]);
  // From a quarter of an hour before the case opened: the alert that triggered
  // it is a moment older than the case itself, and the lead-up is what tells
  // you whether the bike was tampered with before it moved.
  const { rows: alerts } = await pgDb.query(
    `SELECT id, alert_type, severity, created_at, acknowledged_at, resolved_at, resolution_outcome
       FROM tracking_alerts
      WHERE bike_id = $1 AND created_at >= $2::timestamptz - INTERVAL '15 minutes'
      ORDER BY created_at DESC LIMIT 100`,
    [theftCase.bike_id, theftCase.opened_at]);
  const { rows: pings } = await pgDb.query(
    `SELECT lat, lng, speed_kmh, heading, ignition, recorded_at FROM gps_pings
      WHERE bike_id = $1 AND recorded_at >= $2::timestamptz - INTERVAL '15 minutes'
      ORDER BY recorded_at DESC LIMIT 500`,
    [theftCase.bike_id, theftCase.opened_at]);
  res.json({ case: theftCase, events, alerts, pings });
});

router.post('/theft-cases', authRequired, adminOnly, async (req, res) => {
  const bikeId = Number(req.body.bike_id);
  if (!Number.isFinite(bikeId)) return res.status(400).json({ error: 'Which bike?' });
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'Say why this case is being opened' });
  const { rows: bike } = await pgDb.query('SELECT id FROM bikes WHERE id=$1', [bikeId]);
  if (!bike[0]) return res.status(404).json({ error: 'Bike not found' });
  const { rows: dev } = await pgDb.query('SELECT id FROM tracking_devices WHERE bike_id=$1 LIMIT 1', [bikeId]);

  const { theftCase, created } = await theftCases.openCase({
    bikeId, deviceId: dev[0]?.id || null, reason, actorId: req.user.id,
  });
  await logAudit(req.user.id, created ? 'theft_case.open' : 'theft_case.reuse', 'theft_cases', theftCase.id,
    { bike_id: bikeId, reason }, req.ip);
  res.status(created ? 201 : 200).json({ case: theftCase, created });
});

router.post('/theft-cases/:id/notes', authRequired, trackingReadOnly, async (req, res) => {
  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Write something to add' });
  const { rows } = await pgDb.query('SELECT id FROM theft_cases WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Case not found' });
  const event = await theftCases.addEvent(rows[0].id, 'note', note.slice(0, 2000), null, req.user.id);
  res.status(201).json(event);
});

router.put('/theft-cases/:id/status', authRequired, trackingReadOnly, async (req, res) => {
  const status = String(req.body.status || '');
  const note = String(req.body.note || '').trim() || null;
  const police = String(req.body.police_reference || '').trim() || null;
  const caseId = Number(req.params.id);
  try {
    const updated = theftCases.CLOSED_STATUSES.includes(status)
      ? await theftCases.closeCase({ caseId, status, note, policeReference: police, actorId: req.user.id })
      : await theftCases.setStatus({ caseId, status, policeReference: police, actorId: req.user.id });
    if (!updated) return res.status(404).json({ error: 'Case not found, or already closed' });
    await logAudit(req.user.id, 'theft_case.status', 'theft_cases', caseId,
      { status, police_reference: police, note }, req.ip);
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Live follow asks the tracker where it is every minute or so, instead of
// waiting for its own reporting interval. It costs SIM data, so it is
// time-boxed and can be stopped.
router.post('/theft-cases/:id/follow', authRequired, trackingReadOnly, async (req, res) => {
  const minutes = Math.min(Math.max(Number(req.body.minutes) || theftCases.FOLLOW_MINUTES, 5), 720);
  const updated = await theftCases.extendFollow(Number(req.params.id), minutes, req.user.id);
  if (!updated) return res.status(404).json({ error: 'Case not found, or already closed' });
  res.json(updated);
});

router.delete('/theft-cases/:id/follow', authRequired, trackingReadOnly, async (req, res) => {
  const updated = await theftCases.stopFollow(Number(req.params.id), req.user.id);
  if (!updated) return res.status(404).json({ error: 'Case not found, or already closed' });
  res.json(updated);
});

// ---------- Bike notes ----------
// Free-text operational log control room/admin attach to a bike. Explicitly
// on trackingReadOnly (not adminOnly) — control room is otherwise read-only
// on tracking, but writing a note here is the one exception they need.

router.get('/bikes/:bikeId/notes', authRequired, trackingReadOnly, async (req, res) => {
  const { rows } = await pgDb.query(`
    SELECT n.id, n.bike_id, n.note, n.created_at, n.author_id, u.full_name AS author_name
    FROM bike_notes n LEFT JOIN users u ON u.id = n.author_id
    WHERE n.bike_id = $1 ORDER BY n.created_at DESC LIMIT 100
  `, [req.params.bikeId]);
  res.json(rows);
});

router.post('/bikes/:bikeId/notes', authRequired, trackingReadOnly, async (req, res) => {
  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Note text is required' });
  if (note.length > 2000) return res.status(400).json({ error: 'Note is too long (max 2000 characters)' });
  const { rows: bikeRows } = await pgDb.query('SELECT id FROM bikes WHERE id = $1', [req.params.bikeId]);
  if (!bikeRows[0]) return res.status(404).json({ error: 'Bike not found' });

  const { rows } = await pgDb.query(
    `INSERT INTO bike_notes (bike_id, author_id, note) VALUES ($1,$2,$3) RETURNING id, bike_id, note, created_at, author_id`,
    [req.params.bikeId, req.user.id, note]
  );
  const created = rows[0];
  created.author_name = req.user.full_name;
  await logAudit(req.user.id, 'bike.note_added', 'bike_notes', created.id, { bike_id: Number(req.params.bikeId) }, req.ip);
  res.json(created);
});

router.post('/alerts/acknowledge-all', authRequired, trackingReadOnly, async (req, res) => {
  const bikeId = req.body.bike_id ? Number(req.body.bike_id) : null;
  let sql = 'UPDATE tracking_alerts SET acknowledged_at=NOW(), acknowledged_by=$1 WHERE acknowledged_at IS NULL';
  const params = [req.user.id];
  if (bikeId) { params.push(bikeId); sql += ` AND bike_id=$${params.length}`; }
  // Acknowledging everything should not reach alerts this person cannot see.
  if (!seesEverything(req.user)) {
    const hidden = await controlRoomHiddenTypes();
    if (hidden.size) { params.push([...hidden]); sql += ` AND alert_type <> ALL($${params.length})`; }
  }
  const { rowCount } = await pgDb.query(sql, params);
  // Clearing the whole queue in one click is worth a record of who did it.
  await logAudit(req.user.id, 'alert.acknowledge_all', 'tracking_alerts', bikeId || null,
    { bike_id: bikeId, acknowledged: rowCount }, req.ip);
  res.json({ ok: true, acknowledged: rowCount });
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
      control_room_visible: g ? g.control_room_visible !== false : true,
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
        INSERT INTO alert_settings (alert_type, enabled, notify_enabled, recipient_user_ids, control_room_visible, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (alert_type) DO UPDATE SET
          enabled=EXCLUDED.enabled, notify_enabled=EXCLUDED.notify_enabled,
          recipient_user_ids=EXCLUDED.recipient_user_ids,
          control_room_visible=EXCLUDED.control_room_visible, updated_at=NOW()
      `, [s.alert_type, s.enabled !== false, s.notify_enabled !== false, recipIds, s.control_room_visible !== false]);
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
  riskService.reloadAlertSettings();
  res.json({ ok: true });
});

router.delete('/alert-settings/device/:device_id', authRequired, adminOnly, async (req, res) => {
  try {
    await pgDb.query('DELETE FROM device_alert_settings WHERE device_id=$1', [Number(req.params.device_id)]);
    require('../services/tripService').reloadAlertSettings();
  } catch { /* ignore if table missing */ }
  res.json({ ok: true });
});

// The overnight curfew — a bike moving between 00:00 and 04:00 SAST has its
// engine cut automatically once it slows to walking pace.
//
// Both of these are audited. Something that immobilises vehicles on its own
// should leave a record of who turned it on, who turned it off, and who
// decided a particular bike was allowed out at night.
router.get('/night-curfew', authRequired, trackingReadOnly, async (req, res) => {
  const nightCurfew = require('../services/nightCurfew');
  const { rows: exempt } = await pgDb.query(
    `SELECT id, registration, status FROM bikes WHERE night_curfew_exempt = TRUE ORDER BY registration`);
  res.json({
    enabled: await nightCurfew.isEnabled(),
    cut_below_kmh: nightCurfew.CUT_BELOW_KMH,
    covered_statuses: nightCurfew.CUTTABLE_STATUSES,
    exempt_bikes: exempt,
  });
});

router.put('/night-curfew', authRequired, adminOnly, async (req, res) => {
  const nightCurfew = require('../services/nightCurfew');
  const enabled = !!req.body.enabled;
  await nightCurfew.setEnabled(enabled);
  await logAudit(req.user.id, enabled ? 'tracking.night_curfew_on' : 'tracking.night_curfew_off',
    'app_settings', null, { enabled });
  res.json({ ok: true, enabled });
});

router.put('/night-curfew/bike/:bike_id', authRequired, adminOnly, async (req, res) => {
  const bikeId = Number(req.params.bike_id);
  if (!Number.isInteger(bikeId)) return res.status(400).json({ error: 'Bad bike id' });
  const exempt = !!req.body.exempt;
  const { rows } = await pgDb.query(
    'UPDATE bikes SET night_curfew_exempt = $1 WHERE id = $2 RETURNING id, registration', [exempt, bikeId]);
  if (!rows.length) return res.status(404).json({ error: 'Bike not found' });
  await logAudit(req.user.id, exempt ? 'tracking.night_curfew_exempt' : 'tracking.night_curfew_unexempt',
    'bikes', bikeId, { registration: rows[0].registration, reason: req.body.reason || null });
  res.json({ ok: true, bike: rows[0], exempt });
});

router.get('/notification-users', authRequired, trackingReadOnly, async (req, res) => {
  const { rows: users } = await pgDb.query(
    `SELECT id, full_name, email, role FROM users WHERE role IN ('superadmin','admin') AND deleted_at IS NULL ORDER BY full_name`
  );
  res.json(users);
});

// Import historical GPS data from another tracking platform's CSV export —
// e.g. to fill a gap where our own tracker has no data for an incident.
router.post('/gps-import/preview', authRequired, adminOnly, gpsImportUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });
  try {
    res.json(gpsImportService.preview(req.file.buffer.toString('utf8')));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/gps-import', authRequired, adminOnly, gpsImportUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });
  try {
    const summary = await gpsImportService.importCsv(req.file.buffer.toString('utf8'));
    await logAudit(req.user.id, 'gps.csv_import', null, null, summary, req.ip);
    res.json(summary);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;

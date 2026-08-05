'use strict';

const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');
const { sendNotification } = require('./notifier');

// In-memory trip state per bike
const openTrips = new Map();
// Devices that don't report an ignition signal (io[239] absent) can't gate
// trip start/end on it — fall back to ending a trip after this long stationary.
const NO_IGNITION_TRIP_END_IDLE_MS = 5 * 60 * 1000;
// Cooldown map: `${bikeId}:${alertType}` → last-fired epoch ms
const alertCooldowns = new Map();
// Previous external voltage: bikeId → last known ext_voltage_mv
const prevExtVoltage = new Map();

// Alert settings cache: alertType → { enabled, notify_enabled, recipientIds: number[] }
let alertSettingsCache = {};
// Per-device alert settings: deviceId → alertType → { enabled, notify_enabled, recipientIds }
let deviceAlertSettings = {};

async function loadAlertSettings() {
  try {
    const { rows } = await pgDb.query('SELECT * FROM alert_settings');
    const next = {};
    for (const r of rows) {
      let recipientIds = [];
      try { recipientIds = JSON.parse(r.recipient_user_ids || '[]'); } catch { /* ignore */ }
      next[r.alert_type] = { enabled: r.enabled, notify_enabled: r.notify_enabled, recipientIds };
    }
    alertSettingsCache = next;
  } catch { /* table may not exist yet on first boot; use defaults */ }

  try {
    const { rows: deviceRows } = await pgDb.query('SELECT * FROM device_alert_settings');
    const deviceNext = {};
    for (const r of deviceRows) {
      if (!deviceNext[r.device_id]) deviceNext[r.device_id] = {};
      let recipientIds = [];
      try { recipientIds = JSON.parse(r.recipient_user_ids || '[]'); } catch { /* ignore */ }
      deviceNext[r.device_id][r.alert_type] = { enabled: r.enabled, notify_enabled: r.notify_enabled, recipientIds };
    }
    deviceAlertSettings = deviceNext;
  } catch { /* table may not exist yet */ }
}
// Called by tracking.js after a PUT /alert-settings
function reloadAlertSettings() { loadAlertSettings().catch(() => {}); }
// Load on startup (non-blocking)
setTimeout(() => loadAlertSettings().catch(() => {}), 2000);

const COOLDOWNS_MS = {
  speeding:          5 * 60_000,
  harsh_brake:           60_000,
  harsh_accel:           60_000,
  harsh_cornering:       60_000,
  panic:             5 * 60_000,
  movement:          5 * 60_000,
  tamper:           10 * 60_000,
  low_battery:      60 * 60_000,
  power_disconnect: 10 * 60_000,
  device_offline:  240 * 60_000, // 4-hour cooldown — don't spam if stays offline
};

// Alert types that are OFF by default (no panic button wired on standard installs)
const ALERT_DISABLED_BY_DEFAULT = new Set(['panic']);

const CRITICAL_TYPES = new Set(['panic', 'tamper', 'power_disconnect', 'movement']);

const ALERT_LABELS = {
  geofence_enter:   'Entered geofence',
  geofence_exit:    'Left geofence',
  harsh_brake:      'Harsh braking',
  harsh_accel:      'Harsh acceleration',
  harsh_cornering:  'Harsh cornering',
  idle:             'Extended idle',
  speeding:         'Speeding',
  panic:            'Panic / SOS',
  power_disconnect: 'External power disconnected',
  low_battery:      'Low tracker battery',
  movement:         'Unauthorized movement',
  tamper:           'GPS tamper detected',
  device_offline:   'Device offline',
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function canFire(bikeId, alertType, nowMs) {
  const cooldown = COOLDOWNS_MS[alertType];
  if (!cooldown) return true;
  const key = `${bikeId}:${alertType}`;
  const last = alertCooldowns.get(key);
  if (last && nowMs - last < cooldown) return false;
  alertCooldowns.set(key, nowMs);
  return true;
}

async function emitAlert(id, bikeId, deviceId, alertType, payload, recordedAt) {
  const { rows: bikeRows } = await pgDb.query('SELECT registration FROM bikes WHERE id = $1', [bikeId]);
  const reg = bikeRows[0]?.registration || null;
  trackingEvents.emit('alert', {
    id,
    bike_id: bikeId,
    device_id: deviceId,
    alert_type: alertType,
    payload: JSON.stringify(payload),
    bike_registration: reg,
    created_at: recordedAt,
    acknowledged_at: null,
  });
  const deviceSetting = deviceId != null ? deviceAlertSettings[deviceId]?.[alertType] : undefined;
  const setting = deviceSetting !== undefined ? deviceSetting : alertSettingsCache[alertType];
  const notifyEnabled = setting ? setting.notify_enabled : true;
  if (!notifyEnabled) return;

  const label = ALERT_LABELS[alertType] || alertType;
  const title = `🚨 Fleet Alert: ${label} — ${reg || `Bike #${bikeId}`}`;
  const message = `A ${label} alert was triggered for ${reg || `Bike #${bikeId}`} at ${recordedAt}.\n\nDetails:\n${JSON.stringify(payload, null, 2)}`;

  // Use custom recipients if configured, otherwise fall back to all superadmins for critical alerts
  const customIds = setting?.recipientIds?.length ? setting.recipientIds : null;
  if (customIds) {
    const { rows: recipients } = await pgDb.query(
      'SELECT id FROM users WHERE id = ANY($1) AND deleted_at IS NULL', [customIds]
    );
    for (const u of recipients) {
      sendNotification({ userId: u.id, channel: 'email', type: `gps_${alertType}`, title, message, throwOnError: false }).catch(() => {});
    }
  } else if (CRITICAL_TYPES.has(alertType)) {
    const { rows: admins } = await pgDb.query(
      "SELECT id FROM users WHERE role='superadmin' AND email IS NOT NULL AND deleted_at IS NULL"
    );
    for (const admin of admins) {
      sendNotification({ userId: admin.id, channel: 'email', type: `gps_${alertType}`, title, message, throwOnError: false }).catch(() => {});
    }
  }
}

async function fireAlert(bikeId, deviceId, alertType, payload, recordedAt, nowMs) {
  const deviceSetting = deviceId != null ? deviceAlertSettings[deviceId]?.[alertType] : undefined;
  const setting = deviceSetting !== undefined ? deviceSetting : alertSettingsCache[alertType];
  const enabledDefault = !ALERT_DISABLED_BY_DEFAULT.has(alertType);
  if (setting ? setting.enabled === false : !enabledDefault) return;
  if (!canFire(bikeId, alertType, nowMs)) return;
  const { rows } = await pgDb.query(
    'INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [bikeId, deviceId, alertType, JSON.stringify(payload), recordedAt]
  );
  await emitAlert(rows[0].id, bikeId, deviceId, alertType, payload, recordedAt);
}

async function processPing(bikeId, deviceId, lat, lng, speed, ignition, recordedAt, io, speedLimitKmh = 120) {
  const ts = new Date(recordedAt).getTime();
  const moving = speed > 2;
  // ignition is the raw io[239] value: a number when the device reports it, null when it doesn't.
  // Devices without a wired/configured ignition line can't gate trip start/end on it at all —
  // fall back to movement for those instead of silently never recording a trip.
  const hasIgnitionSignal = ignition !== null && ignition !== undefined;
  const ignitionOn = hasIgnitionSignal ? !!ignition : null;

  if (io) {
    if (io[248]) await fireAlert(bikeId, deviceId, 'harsh_brake',     { lat, lng, value: io[248] }, recordedAt, ts);
    if (io[247]) await fireAlert(bikeId, deviceId, 'harsh_accel',     { lat, lng, value: io[247] }, recordedAt, ts);
    if (io[249]) await fireAlert(bikeId, deviceId, 'harsh_cornering', { lat, lng, value: io[249] }, recordedAt, ts);
    if (io[1])   await fireAlert(bikeId, deviceId, 'panic', { lat, lng }, recordedAt, ts);
    if (io[252]) await fireAlert(bikeId, deviceId, 'tamper', { lat, lng, value: io[252] }, recordedAt, ts);
    if (io[240] && !ignition) await fireAlert(bikeId, deviceId, 'movement', { lat, lng }, recordedAt, ts);

    const extMv = io[67] != null ? Number(io[67]) : null;
    if (extMv !== null) {
      const prev = prevExtVoltage.get(bikeId);
      if (prev != null && prev > 9000 && extMv < 1000) {
        await fireAlert(bikeId, deviceId, 'power_disconnect', { lat, lng, prev_mv: prev, curr_mv: extMv }, recordedAt, ts);
      }
      prevExtVoltage.set(bikeId, extMv);
    }

    const battMv = io[66] != null ? Number(io[66]) : null;
    const onExternalPower = io[67] != null && Number(io[67]) > 9000;
    if (battMv !== null && !onExternalPower && battMv < 3400) {
      await fireAlert(bikeId, deviceId, 'low_battery', { lat, lng, battery_mv: battMv }, recordedAt, ts);
    }
  }

  if (speed > speedLimitKmh) {
    await fireAlert(bikeId, deviceId, 'speeding', { lat, lng, speed_kmh: speed, limit_kmh: speedLimitKmh }, recordedAt, ts);
  }

  const state = openTrips.get(bikeId);

  if (!state) {
    // With an ignition signal, require it on. Without one, movement alone starts the trip.
    if ((hasIgnitionSignal ? ignitionOn : true) && moving) {
      const { rows } = await pgDb.query(
        'INSERT INTO trips (bike_id, device_id, started_at, start_lat, start_lng) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [bikeId, deviceId, recordedAt, lat, lng]
      );
      openTrips.set(bikeId, {
        tripId: rows[0].id,
        startTs: ts,
        startLat: lat, startLng: lng,
        lastLat: lat, lastLng: lng,
        lastTs: ts,
        idleStart: null,
        noSignalStoppedSince: null,
        distanceKm: 0,
        maxSpeed: speed,
        totalSpeed: speed,
        pingCount: 1,
      });
    }
    return;
  }

  const seg = haversineKm(state.lastLat, state.lastLng, lat, lng);
  state.distanceKm += seg;
  if (speed > state.maxSpeed) state.maxSpeed = speed;
  state.totalSpeed += speed;
  state.pingCount += 1;
  state.lastLat = lat;
  state.lastLng = lng;
  state.lastTs = ts;

  if (ignition && speed < 5) {
    if (!state.idleStart) {
      state.idleStart = ts;
    } else if (ts - state.idleStart >= 300_000) {
      await fireAlert(bikeId, deviceId, 'idle', { lat, lng, idle_sec: Math.round((ts - state.idleStart) / 1000) }, recordedAt, ts);
      state.idleStart = ts;
    }
  } else {
    state.idleStart = null;
  }

  // With an ignition signal, end the trip the instant it goes off — unchanged behavior.
  // Without one, there's no "off" event to key off, so end after a stationary spell instead.
  let endTrip;
  if (hasIgnitionSignal) {
    endTrip = !ignitionOn;
  } else if (moving) {
    state.noSignalStoppedSince = null;
    endTrip = false;
  } else {
    if (!state.noSignalStoppedSince) state.noSignalStoppedSince = ts;
    endTrip = (ts - state.noSignalStoppedSince) >= NO_IGNITION_TRIP_END_IDLE_MS;
  }

  if (endTrip) {
    const durationSec = Math.max(0, Math.round((ts - state.startTs) / 1000));
    const avgSpeed = state.pingCount > 0 ? Math.round(state.totalSpeed / state.pingCount) : 0;
    const distRounded = Math.round(state.distanceKm * 100) / 100;
    await pgDb.query(
      'UPDATE trips SET ended_at=$1, end_lat=$2, end_lng=$3, distance_km=$4, max_speed_kmh=$5, avg_speed_kmh=$6, duration_sec=$7 WHERE id=$8',
      [recordedAt, lat, lng, distRounded, Math.round(state.maxSpeed), avgSpeed, durationSec, state.tripId]
    );
    if (distRounded > 0) {
      await pgDb.query('UPDATE bikes SET odometer_km = COALESCE(odometer_km, 0) + $1 WHERE id = $2', [distRounded, bikeId]);
    }
    openTrips.delete(bikeId);
  }
}

async function hydrateOpenTrips() {
  try {
    const { rows } = await pgDb.query(`
      SELECT t.*,
             gp.lat AS last_lat, gp.lng AS last_lng, gp.recorded_at AS last_ping_at
      FROM trips t
      LEFT JOIN LATERAL (
        SELECT lat, lng, recorded_at FROM gps_pings WHERE bike_id = t.bike_id ORDER BY recorded_at DESC LIMIT 1
      ) gp ON TRUE
      WHERE t.ended_at IS NULL
    `);
    for (const row of rows) {
      if (openTrips.has(row.bike_id)) continue;
      openTrips.set(row.bike_id, {
        tripId:     row.id,
        startTs:    new Date(row.started_at).getTime(),
        startLat:   row.start_lat,
        startLng:   row.start_lng,
        lastLat:    row.last_lat  ?? row.start_lat,
        lastLng:    row.last_lng  ?? row.start_lng,
        lastTs:     row.last_ping_at ? new Date(row.last_ping_at).getTime() : new Date(row.started_at).getTime(),
        idleStart:  null,
        noSignalStoppedSince: null,
        distanceKm: row.distance_km  || 0,
        maxSpeed:   row.max_speed_kmh || 0,
        totalSpeed: 0,
        pingCount:  1,
      });
    }
    if (rows.length) console.log(`[Trip] Hydrated ${rows.length} open trip(s) from Postgres`);
  } catch (e) {
    console.error('[Trip] Failed to hydrate open trips:', e.message);
  }
}

async function checkOfflineDevices() {
  try {
    const { rows } = await pgDb.query(`
      UPDATE tracking_devices
      SET connected = FALSE
      WHERE connected = TRUE
        AND last_seen_at < NOW() - INTERVAL '15 minutes'
      RETURNING id, bike_id, last_seen_at, imei
    `);
    for (const device of rows) {
      console.log(`[Offline] ${device.imei} marked offline (last seen ${device.last_seen_at})`);
      trackingEvents.emit('device_status', { device_id: device.id, connected: false });
      if (!device.bike_id) continue;
      const recordedAt = new Date().toISOString();
      await fireAlert(device.bike_id, device.id, 'device_offline', {
        imei: device.imei,
        last_seen: device.last_seen_at,
      }, recordedAt, Date.now());
    }
  } catch (e) {
    console.error('[Offline] Check failed:', e.message);
  }
}

module.exports = { processPing, hydrateOpenTrips, reloadAlertSettings, checkOfflineDevices };

'use strict';

const db = require('../db');
const trackingEvents = require('../trackingEvents');
const { sendNotification } = require('./notifier');

// In-memory trip state: bikeId → { tripId, startTs, startLat, startLng, lastLat, lastLng, lastTs, idleStart, distanceKm, maxSpeed, totalSpeed, pingCount }
const openTrips = new Map();
// Cooldown map: `${bikeId}:${alertType}` → last-fired epoch ms
const alertCooldowns = new Map();
// Previous external voltage: bikeId → last known ext_voltage_mv (for power-disconnect detection)
const prevExtVoltage = new Map();

// Minimum ms between repeated alerts of the same type per bike
const COOLDOWNS_MS = {
  speeding:          5 * 60_000,   // 5 minutes
  harsh_brake:           60_000,   // 1 minute (one alert per braking episode)
  harsh_accel:           60_000,
  harsh_cornering:       60_000,
  panic:             5 * 60_000,
  movement:          5 * 60_000,
  tamper:           10 * 60_000,
  low_battery:      60 * 60_000,   // 1 hour
  power_disconnect: 10 * 60_000,
  // idle has its own logic (idleStart reset); no entry here
};

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

const insertTrip = db.prepare(
  'INSERT INTO trips (bike_id, device_id, started_at, start_lat, start_lng) VALUES (?, ?, ?, ?, ?)'
);
const closeTrip = db.prepare(
  'UPDATE trips SET ended_at=?, end_lat=?, end_lng=?, distance_km=?, max_speed_kmh=?, avg_speed_kmh=?, duration_sec=? WHERE id=?'
);
const insertAlert = db.prepare(
  'INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at) VALUES (?, ?, ?, ?, ?)'
);
const getBikeReg = db.prepare('SELECT registration FROM bikes WHERE id = ?');
const updateOdometer = db.prepare(
  'UPDATE bikes SET odometer_km = COALESCE(odometer_km, 0) + ? WHERE id = ?'
);
const getSuperadmins = db.prepare(
  "SELECT id FROM users WHERE role='superadmin' AND email IS NOT NULL AND deleted_at IS NULL"
);

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

function emitAlert(id, bikeId, deviceId, alertType, payload, recordedAt) {
  const reg = getBikeReg.get(bikeId)?.registration || null;
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
  if (CRITICAL_TYPES.has(alertType)) {
    const label = ALERT_LABELS[alertType] || alertType;
    const admins = getSuperadmins.all();
    for (const admin of admins) {
      sendNotification({
        userId: admin.id,
        channel: 'email',
        type: `gps_${alertType}`,
        title: `🚨 Fleet Alert: ${label} — ${reg || `Bike #${bikeId}`}`,
        message: `A ${label} alert was triggered for ${reg || `Bike #${bikeId}`} at ${recordedAt}.\n\nDetails:\n${JSON.stringify(payload, null, 2)}`,
        throwOnError: false,
      }).catch(() => {});
    }
  }
}

function fireAlert(bikeId, deviceId, alertType, payload, recordedAt, nowMs) {
  if (!canFire(bikeId, alertType, nowMs)) return;
  const result = insertAlert.run(bikeId, deviceId, alertType, JSON.stringify(payload), recordedAt);
  emitAlert(result.lastInsertRowid, bikeId, deviceId, alertType, payload, recordedAt);
}

function processPing(bikeId, deviceId, lat, lng, speed, ignition, recordedAt, io, speedLimitKmh = 120) {
  const ts = new Date(recordedAt).getTime();
  const moving = speed > 2;

  if (io) {
    // Harsh driving events (cooldown prevents duplicate alerts per multi-ping episode)
    if (io[248]) fireAlert(bikeId, deviceId, 'harsh_brake',     { lat, lng, value: io[248] }, recordedAt, ts);
    if (io[247]) fireAlert(bikeId, deviceId, 'harsh_accel',     { lat, lng, value: io[247] }, recordedAt, ts);
    if (io[249]) fireAlert(bikeId, deviceId, 'harsh_cornering', { lat, lng, value: io[249] }, recordedAt, ts);

    // Panic / SOS button (Digital Input 1)
    if (io[1]) fireAlert(bikeId, deviceId, 'panic', { lat, lng }, recordedAt, ts);

    // GPS jammer / unplug detection
    if (io[252]) fireAlert(bikeId, deviceId, 'tamper', { lat, lng, value: io[252] }, recordedAt, ts);

    // Unauthorized movement: movement sensor active while ignition is off
    if (io[240] && !ignition) fireAlert(bikeId, deviceId, 'movement', { lat, lng }, recordedAt, ts);

    // External power disconnect: was on vehicle power (>9V), now cut (<1V)
    const extMv = io[67] != null ? Number(io[67]) : null;
    if (extMv !== null) {
      const prev = prevExtVoltage.get(bikeId);
      if (prev != null && prev > 9000 && extMv < 1000) {
        fireAlert(bikeId, deviceId, 'power_disconnect', { lat, lng, prev_mv: prev, curr_mv: extMv }, recordedAt, ts);
      }
      prevExtVoltage.set(bikeId, extMv);
    }

    // Low internal battery (below ~20%, not on external power)
    const battMv = io[66] != null ? Number(io[66]) : null;
    const onExternalPower = extMv != null && extMv > 9000;
    if (battMv !== null && !onExternalPower && battMv < 3400) {
      fireAlert(bikeId, deviceId, 'low_battery', { lat, lng, battery_mv: battMv }, recordedAt, ts);
    }
  }

  // Speeding (configurable threshold, 5-minute cooldown)
  if (speed > speedLimitKmh) {
    fireAlert(bikeId, deviceId, 'speeding', { lat, lng, speed_kmh: speed, limit_kmh: speedLimitKmh }, recordedAt, ts);
  }

  const state = openTrips.get(bikeId);

  if (!state) {
    if (ignition && moving) {
      const info = insertTrip.run(bikeId, deviceId, recordedAt, lat, lng);
      openTrips.set(bikeId, {
        tripId: info.lastInsertRowid,
        startTs: ts,
        startLat: lat, startLng: lng,
        lastLat: lat, lastLng: lng,
        lastTs: ts,
        idleStart: null,
        distanceKm: 0,
        maxSpeed: speed,
        totalSpeed: speed,
        pingCount: 1,
      });
    }
    return;
  }

  // Update running trip
  const seg = haversineKm(state.lastLat, state.lastLng, lat, lng);
  state.distanceKm += seg;
  if (speed > state.maxSpeed) state.maxSpeed = speed;
  state.totalSpeed += speed;
  state.pingCount += 1;
  state.lastLat = lat;
  state.lastLng = lng;
  state.lastTs = ts;

  // Idle detection: ignition on, speed < 5 km/h for >= 5 minutes
  if (ignition && speed < 5) {
    if (!state.idleStart) {
      state.idleStart = ts;
    } else if (ts - state.idleStart >= 300_000) {
      fireAlert(bikeId, deviceId, 'idle', { lat, lng, idle_sec: Math.round((ts - state.idleStart) / 1000) }, recordedAt, ts);
      state.idleStart = ts;
    }
  } else {
    state.idleStart = null;
  }

  // End trip when ignition turns off
  if (!ignition) {
    const durationSec = Math.max(0, Math.round((ts - state.startTs) / 1000));
    const avgSpeed = state.pingCount > 0 ? Math.round(state.totalSpeed / state.pingCount) : 0;
    const distRounded = Math.round(state.distanceKm * 100) / 100;
    closeTrip.run(
      recordedAt, lat, lng,
      distRounded,
      Math.round(state.maxSpeed),
      avgSpeed,
      durationSec,
      state.tripId,
    );
    if (distRounded > 0) updateOdometer.run(distRounded, bikeId);
    openTrips.delete(bikeId);
  }
}

// Hydrate any trips that were open when the server last restarted
function hydrateOpenTrips() {
  try {
    const rows = db.prepare(`
      SELECT t.*,
             gp.lat AS last_lat, gp.lng AS last_lng, gp.recorded_at AS last_ping_at
      FROM trips t
      LEFT JOIN gps_pings gp ON gp.id = (
        SELECT id FROM gps_pings WHERE bike_id = t.bike_id ORDER BY recorded_at DESC LIMIT 1
      )
      WHERE t.ended_at IS NULL
    `).all();
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
        distanceKm: row.distance_km  || 0,
        maxSpeed:   row.max_speed_kmh || 0,
        totalSpeed: 0,
        pingCount:  1,
      });
    }
    if (rows.length) console.log(`[Trip] Hydrated ${rows.length} open trip(s) from DB`);
  } catch (e) {
    console.error('[Trip] Failed to hydrate open trips:', e.message);
  }
}

hydrateOpenTrips();

module.exports = { processPing };

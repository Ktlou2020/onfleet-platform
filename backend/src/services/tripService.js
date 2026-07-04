'use strict';

const db = require('../db');
const trackingEvents = require('../trackingEvents');

// In-memory trip state: bikeId → { tripId, startTs, startLat, startLng, lastLat, lastLng, lastTs, idleStart, distanceKm, maxSpeed, totalSpeed, pingCount }
const openTrips = new Map();

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

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
}

function fireAlert(bikeId, deviceId, alertType, payload, recordedAt) {
  const result = insertAlert.run(bikeId, deviceId, alertType, JSON.stringify(payload), recordedAt);
  emitAlert(result.lastInsertRowid, bikeId, deviceId, alertType, payload, recordedAt);
}

function processPing(bikeId, deviceId, lat, lng, speed, ignition, recordedAt, io) {
  const ts = new Date(recordedAt).getTime();
  const moving = speed > 2;

  // Harsh driving events (IO flags set by device on harsh-event records)
  if (io) {
    if (io[248]) fireAlert(bikeId, deviceId, 'harsh_brake',      { lat, lng, value: io[248] }, recordedAt);
    if (io[247]) fireAlert(bikeId, deviceId, 'harsh_accel',      { lat, lng, value: io[247] }, recordedAt);
    if (io[249]) fireAlert(bikeId, deviceId, 'harsh_cornering',  { lat, lng, value: io[249] }, recordedAt);
  }

  // Speeding alert > 120 km/h
  if (speed > 120) {
    fireAlert(bikeId, deviceId, 'speeding', { lat, lng, speed_kmh: speed }, recordedAt);
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

  // Idle detection: ignition on, speed < 5 for >= 5 min
  if (ignition && speed < 5) {
    if (!state.idleStart) {
      state.idleStart = ts;
    } else if (ts - state.idleStart >= 300_000) {
      fireAlert(bikeId, deviceId, 'idle', { lat, lng, idle_sec: Math.round((ts - state.idleStart) / 1000) }, recordedAt);
      state.idleStart = ts; // reset to avoid flood
    }
  } else {
    state.idleStart = null;
  }

  // End trip when ignition turns off
  if (!ignition) {
    const durationSec = Math.max(0, Math.round((ts - state.startTs) / 1000));
    const avgSpeed = state.pingCount > 0 ? Math.round(state.totalSpeed / state.pingCount) : 0;
    closeTrip.run(
      recordedAt, lat, lng,
      Math.round(state.distanceKm * 100) / 100,
      Math.round(state.maxSpeed),
      avgSpeed,
      durationSec,
      state.tripId,
    );
    openTrips.delete(bikeId);
  }
}

module.exports = { processPing };

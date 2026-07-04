'use strict';

const db = require('../db');
const trackingEvents = require('../trackingEvents');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const getActiveGeofences = db.prepare('SELECT * FROM geofences WHERE active = 1');
const getState = db.prepare(
  'SELECT inside FROM geofence_states WHERE bike_id = ? AND geofence_id = ?'
);
const upsertState = db.prepare(`
  INSERT INTO geofence_states (bike_id, geofence_id, inside, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (bike_id, geofence_id) DO UPDATE SET inside = excluded.inside, updated_at = excluded.updated_at
`);
const insertAlert = db.prepare(
  'INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at) VALUES (?, ?, ?, ?, ?)'
);
const getBikeReg = db.prepare('SELECT registration FROM bikes WHERE id = ?');

function checkGeofences(bikeId, deviceId, lat, lng, recordedAt) {
  const fences = getActiveGeofences.all();
  if (!fences.length) return;
  const reg = getBikeReg.get(bikeId)?.registration || null;

  for (const gf of fences) {
    if (gf.bike_id !== null && gf.bike_id !== bikeId) continue;

    const distKm = haversineKm(lat, lng, gf.lat, gf.lng);
    const inside = distKm * 1000 <= gf.radius_m;
    const prev = getState.get(bikeId, gf.id);

    if (prev === undefined) {
      upsertState.run(bikeId, gf.id, inside ? 1 : 0, recordedAt);
      continue;
    }

    const wasInside = !!prev.inside;
    if (inside === wasInside) continue;

    const alertType = inside ? 'geofence_enter' : 'geofence_exit';
    const payload = JSON.stringify({ geofence_id: gf.id, geofence_name: gf.name, lat, lng });
    const result = insertAlert.run(bikeId, deviceId, alertType, payload, recordedAt);
    upsertState.run(bikeId, gf.id, inside ? 1 : 0, recordedAt);

    trackingEvents.emit('alert', {
      id: result.lastInsertRowid,
      bike_id: bikeId,
      device_id: deviceId,
      alert_type: alertType,
      payload,
      bike_registration: reg,
      created_at: recordedAt,
      acknowledged_at: null,
    });
  }
}

module.exports = { checkGeofences, haversineKm };

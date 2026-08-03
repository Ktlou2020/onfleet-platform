'use strict';

const db = require('../db');
const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function checkGeofences(bikeId, deviceId, lat, lng, recordedAt) {
  const { rows: fences } = await pgDb.query('SELECT * FROM geofences WHERE active = TRUE');
  if (!fences.length) return;

  const bike = db.prepare('SELECT registration FROM bikes WHERE id = ?').get(bikeId);
  const reg = bike?.registration || null;

  for (const gf of fences) {
    if (gf.bike_id !== null && Number(gf.bike_id) !== Number(bikeId)) continue;

    const distKm = haversineKm(lat, lng, gf.lat, gf.lng);
    const inside = distKm * 1000 <= gf.radius_m;

    const { rows: stateRows } = await pgDb.query(
      'SELECT inside FROM geofence_states WHERE bike_id = $1 AND geofence_id = $2',
      [bikeId, gf.id]
    );

    if (!stateRows.length) {
      await pgDb.query(
        `INSERT INTO geofence_states (bike_id, geofence_id, inside, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (bike_id, geofence_id) DO UPDATE SET inside=EXCLUDED.inside, updated_at=EXCLUDED.updated_at`,
        [bikeId, gf.id, inside, recordedAt]
      );
      continue;
    }

    const wasInside = !!stateRows[0].inside;
    if (inside === wasInside) continue;

    const alertType = inside ? 'geofence_enter' : 'geofence_exit';
    const payload = JSON.stringify({ geofence_id: gf.id, geofence_name: gf.name, zone_type: gf.zone_type || 'standard', lat, lng });

    const { rows: alertRows } = await pgDb.query(
      'INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [bikeId, deviceId, alertType, payload, recordedAt]
    );
    await pgDb.query(
      `INSERT INTO geofence_states (bike_id, geofence_id, inside, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (bike_id, geofence_id) DO UPDATE SET inside=EXCLUDED.inside, updated_at=EXCLUDED.updated_at`,
      [bikeId, gf.id, inside, recordedAt]
    );

    trackingEvents.emit('alert', {
      id: alertRows[0].id,
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

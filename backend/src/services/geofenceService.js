'use strict';

const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');
const { cutCommandForModel } = require('./engineCommands');

async function autoEngineCut(deviceId, bikeId, geofence, reg) {
  try {
    const { rows } = await pgDb.query(
      'SELECT id, imei, model FROM tracking_devices WHERE id = $1',
      [deviceId]
    );
    if (!rows.length) return;
    const device = rows[0];
    const cutCmd = cutCommandForModel(device.model);

    const { rows: cmdRows } = await pgDb.query(
      `INSERT INTO tracking_commands (device_id, command, status, created_at)
       VALUES ($1, $2, 'pending', NOW()) RETURNING id`,
      [deviceId, cutCmd]
    );
    const cmdId = cmdRows[0].id;

    // Persist "should stay cut" — setdigout doesn't survive a device power
    // cycle, so this gets re-checked and re-sent on every reconnect
    // (teltonikaServer.js) until explicitly restored.
    await pgDb.query(
      `UPDATE tracking_devices SET engine_cut_active=TRUE, engine_cut_reason=$1, engine_cut_at=NOW(), engine_cut_by=NULL WHERE id=$2`,
      [`Entered no-go zone: ${geofence.name}`, deviceId]
    );

    // Lazy require avoids circular dep (teltonikaServer → geofenceService → teltonikaServer)
    const { sendCommand } = require('../tcp/teltonikaServer');
    const sent = sendCommand(device.imei, cmdId, cutCmd);
    console.log(`[GeofenceService] Auto engine cut ${sent ? 'sent' : 'queued'} for ${device.imei} — entered: ${geofence.name}`);

    const cutPayload = JSON.stringify({ geofence_name: geofence.name, cmd: cutCmd, queued: !sent });
    const { rows: alertRows } = await pgDb.query(
      `INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at)
       VALUES ($1,$2,'engine_cut_auto',$3,NOW()) RETURNING id`,
      [bikeId, deviceId, cutPayload]
    );
    trackingEvents.emit('alert', {
      id: alertRows[0].id,
      bike_id: bikeId,
      device_id: deviceId,
      alert_type: 'engine_cut_auto',
      payload: cutPayload,
      bike_registration: reg,
      created_at: new Date().toISOString(),
      acknowledged_at: null,
    });
  } catch (e) {
    console.error('[GeofenceService] Auto engine cut failed:', e.message);
  }
}

// Ray-casting point-in-polygon; coords: [[lat,lng], ...]
function pointInPolygon(lat, lng, coords) {
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [yi, xi] = coords[i];
    const [yj, xj] = coords[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

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

  const { rows: bikeRows } = await pgDb.query('SELECT registration FROM bikes WHERE id = $1', [bikeId]);
  const reg = bikeRows[0]?.registration || null;

  for (const gf of fences) {
    if (gf.bike_id !== null && Number(gf.bike_id) !== Number(bikeId)) continue;

    let inside;
    const coords = gf.polygon_coords;
    if (coords && Array.isArray(coords) && coords.length >= 3) {
      inside = pointInPolygon(lat, lng, coords);
    } else {
      const distKm = haversineKm(lat, lng, gf.lat, gf.lng);
      inside = distKm * 1000 <= gf.radius_m;
    }

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
    const zoneType = gf.zone_type || 'standard';
    const payload = JSON.stringify({ geofence_id: gf.id, geofence_name: gf.name, zone_type: zoneType, lat, lng });

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

    // Automatically cut the engine when a bike enters a no-go zone
    if (alertType === 'geofence_enter' && zoneType === 'danger' && deviceId != null) {
      autoEngineCut(deviceId, bikeId, gf, reg);
    }
  }
}

module.exports = { checkGeofences, haversineKm };

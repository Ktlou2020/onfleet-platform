'use strict';

const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');
const { cutCommandForModel } = require('./engineCommands');

// Active geofences change only via admin CRUD (routes/tracking.js), not per
// ping — cached in memory and refreshed on demand instead of re-querying on
// every single GPS ping across every bike. reloadGeofences() is called by
// the geofence CRUD routes after any create/update/delete.
let geofenceCache = null; // Array | null (null = not loaded yet; an empty array is a valid loaded state)

async function loadGeofences() {
  const { rows } = await pgDb.query('SELECT * FROM geofences WHERE active = TRUE');
  geofenceCache = rows;
  return rows;
}

async function getGeofences() {
  if (geofenceCache) return geofenceCache;
  return loadGeofences();
}

function reloadGeofences() {
  loadGeofences().catch((e) => console.error('[GeofenceService] reload failed:', e.message));
}

// Warm the cache at boot so the first real ping doesn't pay the query cost inline.
setTimeout(() => loadGeofences().catch(() => {}), 2000);

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
  const allFences = await getGeofences();
  const fences = allFences.filter((gf) => gf.bike_id === null || Number(gf.bike_id) === Number(bikeId));
  if (!fences.length) return;

  // One batched lookup for every relevant fence's state instead of one round-trip per fence.
  const { rows: stateRows } = await pgDb.query(
    'SELECT geofence_id, inside FROM geofence_states WHERE bike_id = $1 AND geofence_id = ANY($2)',
    [bikeId, fences.map((gf) => gf.id)]
  );
  const stateByFence = new Map(stateRows.map((s) => [s.geofence_id, !!s.inside]));

  // Only needed if a fence actually transitions this ping — most pings touch
  // no boundary at all, so skip the round-trip unless it's actually required.
  let reg; // undefined = not yet fetched (distinct from a bike with no registration, which resolves to null)
  const getReg = async () => {
    if (reg === undefined) {
      const { rows: bikeRows } = await pgDb.query('SELECT registration FROM bikes WHERE id = $1', [bikeId]);
      reg = bikeRows[0]?.registration || null;
    }
    return reg;
  };

  for (const gf of fences) {
    let inside;
    const coords = gf.polygon_coords;
    if (coords && Array.isArray(coords) && coords.length >= 3) {
      inside = pointInPolygon(lat, lng, coords);
    } else {
      const distKm = haversineKm(lat, lng, gf.lat, gf.lng);
      inside = distKm * 1000 <= gf.radius_m;
    }

    const hasState = stateByFence.has(gf.id);
    if (!hasState) {
      await pgDb.query(
        `INSERT INTO geofence_states (bike_id, geofence_id, inside, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (bike_id, geofence_id) DO UPDATE SET inside=EXCLUDED.inside, updated_at=EXCLUDED.updated_at`,
        [bikeId, gf.id, inside, recordedAt]
      );
      continue;
    }

    const wasInside = stateByFence.get(gf.id);
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

    const regValue = await getReg();
    trackingEvents.emit('alert', {
      id: alertRows[0].id,
      bike_id: bikeId,
      device_id: deviceId,
      alert_type: alertType,
      payload,
      bike_registration: regValue,
      created_at: recordedAt,
      acknowledged_at: null,
    });

    // Automatically cut the engine when a bike enters a no-go zone
    if (alertType === 'geofence_enter' && zoneType === 'danger' && deviceId != null) {
      autoEngineCut(deviceId, bikeId, gf, regValue);
    }
  }
}

module.exports = { checkGeofences, haversineKm, reloadGeofences };

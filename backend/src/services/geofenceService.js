'use strict';

const pgDb = require('../pgDb');
const { zoneAlertType } = require('../constants/alertTypes');
const { autoCut } = require('./autoEngineCut');

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

// Entering a no-go zone cuts the engine, through the same path as the
// overnight curfew so both behave identically afterwards.
function autoEngineCut(deviceId, bikeId, geofence) {
  return autoCut({
    deviceId,
    bikeId,
    reason: `Entered no-go zone: ${geofence.name}`,
    riderReason: `it entered a no-go zone (${geofence.name})`,
    payload: { geofence_id: geofence.id, geofence_name: geofence.name },
  });
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

    const zoneType = gf.zone_type || 'standard';
    const alertType = zoneAlertType(zoneType, inside);
    const payload = { geofence_id: gf.id, geofence_name: gf.name, zone_type: zoneType, lat, lng };

    // The crossing is recorded whatever happens to the alert: if the alert
    // type is switched off we must still remember which side of the boundary
    // the bike is on, or every later ping reads as the same fresh crossing.
    await pgDb.query(
      `INSERT INTO geofence_states (bike_id, geofence_id, inside, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (bike_id, geofence_id) DO UPDATE SET inside=EXCLUDED.inside, updated_at=EXCLUDED.updated_at`,
      [bikeId, gf.id, inside, recordedAt]
    );

    // Through tripService's fireAlert rather than a local INSERT, so a zone
    // alert obeys the admin's on/off switch and actually emails the people
    // named against it — neither of which happened while this inserted its
    // own row and emitted straight to the live feed.
    const { fireAlert } = require('./tripService');
    await fireAlert(bikeId, deviceId, alertType, payload, recordedAt, new Date(recordedAt).getTime());

    // Entering a no-go zone cuts the engine. That is the zone's whole purpose,
    // so it does not wait on the alert type being switched on — and it raises
    // its own engine_cut_auto alert either way.
    if (inside && zoneType === 'danger' && deviceId != null) {
      autoEngineCut(deviceId, bikeId, gf);
    }
  }
}

module.exports = { checkGeofences, haversineKm, reloadGeofences };

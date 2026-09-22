'use strict';

const pgDb = require('../pgDb');
const { zoneAlertType } = require('../constants/alertTypes');
const { autoCut } = require('./autoEngineCut');
const { metresInside, resolveInside } = require('./geofenceGeometry');

// A boundary is not a knife edge. A hand-drawn zone follows streets, and a GPS
// fix scatters tens of metres, so a bike riding the edge produces fixes that
// land alternately inside and outside. MS23NMGP crossed the Como City boundary
// three times in eight minutes that way, and each inward crossing cut its
// engine — twice in four minutes, with somebody restoring it in between.
//
// Nothing changes between these two buffers, so scatter cannot toggle the
// state. A bike genuinely riding in passes 75 m within seconds.
const ENTER_BUFFER_M = 75;
const EXIT_BUFFER_M = 75;

// A fix from three satellites can be a kilometre out. It is good enough to
// draw a rough trail and far too poor to immobilise a bike on.
const MIN_SATELLITES_FOR_ZONES = 4;

// Crossing the buffer raises the alert at once, so the control room hears
// immediately. Cutting the engine waits until the bike has stayed inside this
// long — a corner clipped at a junction is not worth stranding a rider over.
const CUT_CONFIRM_MS = 60 * 1000;

// bikeId:geofenceId → when this bike was first confirmed inside that zone.
const insideSince = new Map();

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
function autoEngineCut(deviceId, bikeId, geofence, metresInsideZone = null) {
  return autoCut({
    deviceId,
    bikeId,
    reason: `Entered no-go zone: ${geofence.name}`,
    riderReason: `it entered a no-go zone (${geofence.name})`,
    payload: {
      geofence_id: geofence.id,
      geofence_name: geofence.name,
      metres_inside: metresInsideZone,
      confirmed_after_sec: Math.round(CUT_CONFIRM_MS / 1000),
    },
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

async function checkGeofences(bikeId, deviceId, lat, lng, recordedAt, satellites = null) {
  // A three-satellite fix can be a kilometre out. Good enough for a trail,
  // nowhere near good enough to cut an engine on.
  if (satellites != null && Number(satellites) < MIN_SATELLITES_FOR_ZONES) return;

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
    const depthM = metresInside(lat, lng, gf);
    const hadState = stateByFence.has(gf.id);
    const inside = resolveInside({
      metres: depthM,
      wasInside: hadState ? stateByFence.get(gf.id) : null,
      enterBufferM: ENTER_BUFFER_M,
      exitBufferM: EXIT_BUFFER_M,
    });

    const zoneKey = `${bikeId}:${gf.id}`;
    const zoneTypeNow = gf.zone_type || 'standard';

    // Checked on every ping, not only on a crossing: the cut is what happens
    // when the bike is STILL inside a while after entering, and by then there
    // is no transition left to hang it off.
    if (!inside) {
      insideSince.delete(zoneKey);
    } else if (zoneTypeNow === 'danger' && deviceId != null) {
      const since = insideSince.get(zoneKey);
      if (since === undefined) {
        insideSince.set(zoneKey, new Date(recordedAt).getTime());
      } else if (new Date(recordedAt).getTime() - since >= CUT_CONFIRM_MS) {
        insideSince.delete(zoneKey); // one cut per entry, not one per ping
        autoEngineCut(deviceId, bikeId, gf, Math.round(depthM));
      }
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
    const payload = { geofence_id: gf.id, geofence_name: gf.name, zone_type: zoneType, lat, lng, metres_inside: Math.round(depthM) };

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


  }
}

module.exports = { checkGeofences, haversineKm, reloadGeofences };

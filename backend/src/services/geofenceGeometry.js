'use strict';

// How far inside or outside a zone a position is — not merely which side.
//
// Which side is not enough. A bike riding a road that runs along a zone's edge
// produces fixes that land alternately inside and outside, because an ordinary
// GPS fix scatters tens of metres and a hand-drawn boundary follows the street.
// MS23NMGP crossed the "Como City" boundary three times in eight minutes that
// way, and each inward crossing cut its engine.
//
// With a distance instead of a yes/no, a zone can be given a dead band: enter
// only once properly inside, leave only once properly outside, and ignore the
// churn in between. That is what stops the flapping, at any sampling rate.

const EARTH_RADIUS_M = 6371000;

function toRad(d) { return (d * Math.PI) / 180; }

// Local flat-earth projection in metres, good to a fraction of a percent over
// the few kilometres a geofence spans, and far cheaper than haversine per edge.
function project(lat, lng, originLat) {
  const x = toRad(lng) * Math.cos(toRad(originLat)) * EARTH_RADIUS_M;
  const y = toRad(lat) * EARTH_RADIUS_M;
  return [x, y];
}

function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Shortest distance from a point to a line segment, all in projected metres.
function pointToSegmentM(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Ray casting; coords are [lat, lng] pairs, matching how the map draws them.
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

function distanceToPolygonEdgeM(lat, lng, coords) {
  const [px, py] = project(lat, lng, lat);
  let best = Infinity;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [ax, ay] = project(coords[i][0], coords[i][1], lat);
    const [bx, by] = project(coords[j][0], coords[j][1], lat);
    best = Math.min(best, pointToSegmentM(px, py, ax, ay, bx, by));
  }
  return best;
}

/**
 * Metres inside the zone: positive inside, negative outside, ~0 on the line.
 * Works for a polygon zone and for a plain radius zone.
 */
function metresInside(lat, lng, geofence) {
  const coords = geofence.polygon_coords;
  const poly = typeof coords === 'string' ? safeParse(coords) : coords;

  if (Array.isArray(poly) && poly.length >= 3) {
    const edge = distanceToPolygonEdgeM(lat, lng, poly);
    return pointInPolygon(lat, lng, poly) ? edge : -edge;
  }
  const centreDist = haversineM(lat, lng, Number(geofence.lat), Number(geofence.lng));
  return Number(geofence.radius_m || 0) - centreDist;
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Whether the bike should now count as inside, given where it was before.
 *
 * The dead band is the whole point: between the two buffers nothing changes,
 * so scatter along the boundary cannot toggle the state. A bike genuinely
 * entering crosses the inner buffer within a few seconds of real travel.
 */
function resolveInside({ metres, wasInside, enterBufferM, exitBufferM }) {
  if (wasInside === null || wasInside === undefined) {
    // First sighting: no history to protect, so take the plain answer.
    return metres > 0;
  }
  if (!wasInside && metres >= enterBufferM) return true;
  if (wasInside && metres <= -exitBufferM) return false;
  return wasInside;
}

module.exports = {
  metresInside, resolveInside, pointInPolygon,
  haversineM, distanceToPolygonEdgeM, pointToSegmentM,
};

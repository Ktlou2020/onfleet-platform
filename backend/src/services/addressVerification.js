'use strict';

// Compares where a rider's bike is actually parked overnight against the
// address they gave us on file — WITHOUT ever inferring or displaying a new
// address. Only a match/mismatch/unverified status is stored and exposed;
// the geocoded coordinates and overnight GPS cluster are used for the
// comparison only and never surfaced via the API.
//
// "Overnight" = 00:00-04:00 SAST, the same high-theft window the
// night_movement alert watches (see tripService.js) — bikes should be
// parked and stationary then, so pings in that window are a reasonable
// proxy for "where the rider actually lives/stays".

const crypto = require('crypto');
const pgDb = require('../pgDb');
const { geocodeAddress } = require('./geocode');

const MIN_PINGS = 5;
const MIN_DISTINCT_NIGHTS = 3;
const LOOKBACK_DAYS = 21;
const MAX_CLUSTER_SPREAD_KM = 5; // overnight locations too scattered to trust as "home"
const MISMATCH_THRESHOLD_KM = 3; // accounts for geocoding imprecision, complexes, etc.
const NOMINATIM_DELAY_MS = 1100; // Nominatim usage policy: max ~1 req/sec

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashAddress(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function buildAddressText(rider) {
  return [rider.address, rider.city, rider.province, rider.postal_code]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(', ');
}

async function getOvernightCluster(bikeId) {
  const { rows } = await pgDb.query(`
    SELECT lat, lng
    FROM gps_pings
    WHERE bike_id = $1
      AND recorded_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
      AND EXTRACT(HOUR FROM recorded_at AT TIME ZONE 'Africa/Johannesburg') BETWEEN 0 AND 3
  `, [bikeId]);
  if (rows.length < MIN_PINGS) return null;

  const { rows: nightRows } = await pgDb.query(`
    SELECT COUNT(DISTINCT (recorded_at AT TIME ZONE 'Africa/Johannesburg')::date) AS nights
    FROM gps_pings
    WHERE bike_id = $1
      AND recorded_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
      AND EXTRACT(HOUR FROM recorded_at AT TIME ZONE 'Africa/Johannesburg') BETWEEN 0 AND 3
  `, [bikeId]);
  if (Number(nightRows[0]?.nights || 0) < MIN_DISTINCT_NIGHTS) return null;

  const centroidLat = rows.reduce((sum, r) => sum + r.lat, 0) / rows.length;
  const centroidLng = rows.reduce((sum, r) => sum + r.lng, 0) / rows.length;
  const maxSpreadKm = Math.max(...rows.map((r) => haversineKm(centroidLat, centroidLng, r.lat, r.lng)));
  if (maxSpreadKm > MAX_CLUSTER_SPREAD_KM) return null; // parks in too many different places to trust

  return { lat: centroidLat, lng: centroidLng };
}

async function runAddressVerification() {
  const { rows: riders } = await pgDb.query(`
    SELECT DISTINCT ON (u.id)
      u.id AS user_id, u.address, u.city, u.province, u.postal_code,
      u.address_lat, u.address_lng, u.address_geocode_hash,
      b.id AS bike_id
    FROM bikes b
    JOIN agreements a ON a.bike_id = b.id AND a.status = 'active'
    JOIN users u ON u.id = a.user_id AND u.deleted_at IS NULL
    JOIN tracking_devices d ON d.bike_id = b.id
    ORDER BY u.id, a.created_at DESC
  `);

  for (const rider of riders) {
    try {
      const addressText = buildAddressText(rider);
      if (addressText.length < 5) continue; // no usable address on file — leave 'unverified'

      const hash = hashAddress(addressText);
      let addressLat = rider.address_lat;
      let addressLng = rider.address_lng;

      if (hash !== rider.address_geocode_hash) {
        const geo = await geocodeAddress(`${addressText}, South Africa`);
        addressLat = geo?.lat ?? null;
        addressLng = geo?.lng ?? null;
        await pgDb.query(
          `UPDATE users SET address_lat = $1, address_lng = $2, address_geocode_hash = $3, address_geocoded_at = NOW() WHERE id = $4`,
          [addressLat, addressLng, hash, rider.user_id]
        );
        await sleep(NOMINATIM_DELAY_MS);
      }
      if (addressLat == null || addressLng == null) continue; // couldn't geocode this address — leave 'unverified'

      const cluster = await getOvernightCluster(rider.bike_id);
      if (!cluster) continue; // not enough consistent overnight data yet — leave 'unverified'

      const distanceKm = haversineKm(addressLat, addressLng, cluster.lat, cluster.lng);
      const status = distanceKm <= MISMATCH_THRESHOLD_KM ? 'match' : 'mismatch';
      await pgDb.query(
        `UPDATE users SET address_match_status = $1, address_match_checked_at = NOW() WHERE id = $2`,
        [status, rider.user_id]
      );
    } catch (err) {
      console.error(`[address-verification] failed for user ${rider.user_id}:`, err.message);
    }
  }
}

module.exports = { runAddressVerification };

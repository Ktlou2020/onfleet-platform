'use strict';

// Address search for the delivery-address box: suggestions as you type, and
// turning a dropped pin back into a street address. Requests go through
// our server so we can keep results to South Africa, cache them, rate-limit
// them, and swap provider without touching the app.
//
// Providers (GEOCODER env):
//   photon   — default. Free OpenStreetMap search (photon.komoot.io) built
//              for type-ahead; fair use only, so for real volume run your
//              own Photon or switch provider.
//   maptiler — MapTiler Geocoding, needs MAPTILER_KEY.

const SA_BBOX = { minLng: 16.3, minLat: -35.0, maxLng: 33.0, maxLat: -22.0 };
const UA = process.env.GEOCODER_USER_AGENT || 'Cloud9Delivery/0.1 (+help@cloud9.africa)';
const CACHE_MAX = 1000;
const CACHE_MS = 60 * 60 * 1000;

const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
  return fn().then((value) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, until: Date.now() + CACHE_MS });
    return value;
  });
}

const inSA = (lat, lng) => lat >= SA_BBOX.minLat && lat <= SA_BBOX.maxLat && lng >= SA_BBOX.minLng && lng <= SA_BBOX.maxLng;

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Address search failed (${res.status})`);
  return res.json();
}

// ---- Photon ---------------------------------------------------------------
function photonPlace(f) {
  const p = f.properties || {};
  const [lng, lat] = f.geometry?.coordinates || [];
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const main = street || p.name || '';
  const area = [p.name && street && p.name !== street ? p.name : null, p.district || p.locality, p.city || p.county, p.postcode].filter(Boolean);
  const label = [main, ...area.filter((a) => a !== main)].join(', ');
  return { label, main, secondary: area.filter((a) => a !== main).join(', '), lat, lng, city: p.city || p.county || p.state || null, kind: p.osm_value || p.type || null };
}

const photon = {
  async search(q, near, fetchImpl) {
    const u = new URL('https://photon.komoot.io/api/');
    u.searchParams.set('q', q);
    u.searchParams.set('limit', '6');
    u.searchParams.set('lang', 'en');
    u.searchParams.set('bbox', `${SA_BBOX.minLng},${SA_BBOX.minLat},${SA_BBOX.maxLng},${SA_BBOX.maxLat}`);
    if (near) { u.searchParams.set('lat', String(near.lat)); u.searchParams.set('lon', String(near.lng)); }
    const d = await getJson(u, fetchImpl);
    return (d.features || []).filter((f) => !f.properties?.countrycode || f.properties.countrycode === 'ZA').map(photonPlace);
  },
  async reverse(lat, lng, fetchImpl) {
    const u = new URL('https://photon.komoot.io/reverse');
    u.searchParams.set('lat', String(lat));
    u.searchParams.set('lon', String(lng));
    u.searchParams.set('lang', 'en');
    const d = await getJson(u, fetchImpl);
    return d.features?.[0] ? photonPlace(d.features[0]) : null;
  },
};

// ---- MapTiler -----------------------------------------------------------
function maptilerPlace(f) {
  const [lng, lat] = f.center || f.geometry?.coordinates || [];
  const ctx = (f.context || []).map((c) => c.text);
  const main = [f.address, f.text].filter(Boolean).join(' ') || f.text;
  return { label: f.place_name, main, secondary: ctx.slice(0, 3).join(', '), lat, lng, city: ctx.find(Boolean) || null, kind: f.place_type?.[0] || null };
}

const maptiler = {
  async search(q, near, fetchImpl) {
    const u = new URL(`https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json`);
    u.searchParams.set('key', process.env.MAPTILER_KEY || '');
    u.searchParams.set('country', 'za');
    u.searchParams.set('autocomplete', 'true');
    u.searchParams.set('limit', '6');
    if (near) u.searchParams.set('proximity', `${near.lng},${near.lat}`);
    return ((await getJson(u, fetchImpl)).features || []).map(maptilerPlace);
  },
  async reverse(lat, lng, fetchImpl) {
    const u = new URL(`https://api.maptiler.com/geocoding/${lng},${lat}.json`);
    u.searchParams.set('key', process.env.MAPTILER_KEY || '');
    const f = (await getJson(u, fetchImpl)).features?.[0];
    return f ? maptilerPlace(f) : null;
  },
};

function provider() {
  return process.env.GEOCODER === 'maptiler' && process.env.MAPTILER_KEY ? maptiler : photon;
}

async function search(q, near, fetchImpl = fetch) {
  const text = String(q || '').trim().slice(0, 120);
  if (text.length < 3) return [];
  const key = `s|${process.env.GEOCODER || 'photon'}|${text.toLowerCase()}|${near ? `${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : ''}`;
  return cached(key, () => provider().search(text, near, fetchImpl))
    .then((list) => list.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && inSA(p.lat, p.lng) && p.label));
}

async function reverse(lat, lng, fetchImpl = fetch) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inSA(lat, lng)) return null;
  // ~10 m grid, so a pin nudged a little re-uses the answer.
  const key = `r|${process.env.GEOCODER || 'photon'}|${lat.toFixed(4)},${lng.toFixed(4)}`;
  return cached(key, () => provider().reverse(lat, lng, fetchImpl));
}

// Map tiles, configurable the same way. OpenStreetMap's own tiles need no
// key but are for light use with attribution; set MAP_TILE_URL to a
// provider such as MapTiler or Stadia for production volume.
function mapTiles() {
  return {
    url: process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: process.env.MAP_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: Number(process.env.MAP_TILE_MAX_ZOOM || 19),
  };
}

function tileHost() {
  try {
    return new URL(mapTiles().url.replace(/\{[a-z]\}/g, 'a')).origin.replace('://a.', '://*.');
  } catch {
    return null;
  }
}

module.exports = { search, reverse, mapTiles, tileHost, inSA, _cache: cache };

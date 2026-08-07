'use strict';

// Forward geocoding (address text -> lat/lng) via Nominatim (OpenStreetMap),
// the same free geocoder already used client-side for reverse geocoding in
// admin/Tracking.jsx. Nominatim's usage policy requires a real User-Agent
// and caps usage at ~1 request/second — callers doing more than one lookup
// (e.g. the address-verification cron) must space calls out themselves.

const axios = require('axios');

const USER_AGENT = 'OnFleetAfrica/1.0 (ops@onfleet.africa)';

async function geocodeAddress(addressText) {
  const q = String(addressText || '').trim();
  if (q.length < 5) return null;
  try {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { format: 'json', limit: 1, countrycodes: 'za', q },
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      timeout: 8000,
    });
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit || hit.lat == null || hit.lon == null) return null;
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch (err) {
    console.error('[geocode] lookup failed:', err.message);
    return null;
  }
}

module.exports = { geocodeAddress };

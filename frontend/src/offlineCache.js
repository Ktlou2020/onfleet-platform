// Last-known-good cache for GET API responses, so a dropped connection (common
// for riders/fleet owners on the road with patchy SA mobile data) shows stale
// data instead of a blank/broken page. Never throws — a full or unavailable
// localStorage should degrade to "no cache", not break the request.

const PREFIX = 'of_apicache:';

function cacheKey(url) {
  return PREFIX + url;
}

export function readCache(url) {
  try {
    const raw = localStorage.getItem(cacheKey(url));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeCache(url, data) {
  try {
    const payload = JSON.stringify({ data, cachedAt: Date.now() });
    if (payload.length > 200_000) return; // skip caching unusually large responses
    localStorage.setItem(cacheKey(url), payload);
  } catch {
    // quota exceeded or storage disabled — offline cache is best-effort
  }
}

export function clearCache() {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(PREFIX))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    // ignore
  }
}

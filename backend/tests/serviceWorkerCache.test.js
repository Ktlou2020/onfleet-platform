import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

// The service worker's fetch handler, exercised without a browser.
//
// This is tested at all because a fetch handler is the most dangerous thing in
// the frontend: it sits in front of *every* request the app makes. A mistake
// here does not break images, it breaks the application. The handler is meant
// to touch uploaded images and nothing else, and "nothing else" is most of
// what these tests check.
//
// It lives in the backend suite because that is where the test runner is; the
// file under test is frontend/public/sw.js.

const here = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.join(here, '../../frontend/public/sw.js');

function loadServiceWorker({ fetchImpl, cacheStore = new Map() } = {}) {
  const handlers = {};
  const cacheApi = {
    async open() {
      return {
        async match(request) { return cacheStore.get(keyOf(request)) || undefined; },
        async put(request, response) { cacheStore.set(keyOf(request), response); },
        async keys() { return [...cacheStore.keys()]; },
      };
    },
    async keys() { return ['onfleet-uploads-v1', 'onfleet-uploads-old']; },
    async delete() { return true; },
  };
  const keyOf = (r) => (typeof r === 'string' ? r : r.url);

  const self = {
    location: { origin: 'https://portal.onfleet.africa' },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => Promise.resolve(), matchAll: async () => [] },
    registration: { showNotification: () => {} },
  };

  const sandbox = {
    self,
    caches: cacheApi,
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, clone: () => ({ cloned: true }) })),
    Response: { error: () => ({ type: 'error' }) },
    URL,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SW_PATH, 'utf8'), sandbox);
  return { handlers, cacheStore };
}

/** Fire the fetch handler and report whether it took the request over. */
function dispatch(handlers, { url, method = 'GET' }) {
  let responded = null;
  handlers.fetch({
    request: { url, method },
    respondWith: (p) => { responded = p; },
  });
  return responded;
}

describe('the service worker only touches uploaded images', () => {
  let handlers;

  beforeEach(() => { ({ handlers } = loadServiceWorker()); });

  it('registers a fetch handler at all', () => {
    expect(typeof handlers.fetch).toBe('function');
  });

  it('takes over a request for an uploaded image', async () => {
    const r = dispatch(handlers, { url: 'https://portal.onfleet.africa/uploads/part-photos/a.jpg' });
    expect(r).not.toBeNull();
    await expect(r).resolves.toMatchObject({ ok: true });
  });

  // Everything below is a request the app must keep handling itself.
  const leaveAlone = {
    'an API call': 'https://portal.onfleet.africa/api/workshop/job-cards',
    'the app shell': 'https://portal.onfleet.africa/',
    'a built asset': 'https://portal.onfleet.africa/assets/index-abc.js',
    'the logo': 'https://portal.onfleet.africa/logo.png',
    'another origin': 'https://unpkg.com/leaflet/dist/leaflet.css',
    'a map tile': 'https://tile.openstreetmap.org/12/2345/1234.png',
  };

  for (const [what, url] of Object.entries(leaveAlone)) {
    it(`does not intercept ${what}`, () => {
      expect(dispatch(handlers, { url })).toBeNull();
    });
  }

  // The origin check earns its place only here. Every other cross-origin URL
  // is already turned away for not being under /uploads/, so without a case
  // that shares the path, the guard can be deleted and nothing notices.
  it('does not intercept another origin that happens to use the same path', () => {
    expect(dispatch(handlers, { url: 'https://someone-else.example.com/uploads/part-photos/a.jpg' })).toBeNull();
  });

  // An upload is a POST. Caching one, or answering it from cache, would be
  // catastrophic in a quiet way.
  it('ignores anything that is not a GET', () => {
    expect(dispatch(handlers, {
      url: 'https://portal.onfleet.africa/uploads/part-photos/a.jpg', method: 'POST',
    })).toBeNull();
  });

  it('does not fall over on a malformed url', () => {
    expect(() => dispatch(handlers, { url: 'not a url at all' })).not.toThrow();
  });
});

describe('what the service worker keeps', () => {
  it('serves the second request from the cache without going to the network', async () => {
    let networkCalls = 0;
    const { handlers } = loadServiceWorker({
      fetchImpl: async () => {
        networkCalls += 1;
        return { ok: true, status: 200, body: 'bytes', clone: () => ({ ok: true, status: 200, body: 'bytes' }) };
      },
    });
    const url = 'https://portal.onfleet.africa/uploads/part-photos/a.jpg';
    await dispatch(handlers, { url });
    await dispatch(handlers, { url });
    expect(networkCalls).toBe(1);
  });

  // A 404 or an auth redirect cached here would be a blank square that never
  // recovers, on every phone that saw it.
  it('refuses to keep anything that is not a clean 200', async () => {
    const { handlers, cacheStore } = loadServiceWorker({
      fetchImpl: async () => ({ ok: false, status: 404, clone: () => ({}) }),
    });
    await dispatch(handlers, { url: 'https://portal.onfleet.africa/uploads/part-photos/missing.jpg' });
    expect(cacheStore.size).toBe(0);
  });

  it('gives up honestly when offline and nothing is cached', async () => {
    const { handlers } = loadServiceWorker({
      fetchImpl: async () => { throw new Error('offline'); },
    });
    const r = await dispatch(handlers, { url: 'https://portal.onfleet.africa/uploads/part-photos/a.jpg' });
    expect(r).toMatchObject({ type: 'error' });
  });

  it('still answers from cache when the network is gone', async () => {
    const cacheStore = new Map();
    const url = 'https://portal.onfleet.africa/uploads/part-photos/a.jpg';

    const online = loadServiceWorker({ cacheStore, fetchImpl: async () => ({ ok: true, status: 200, clone: () => ({ cached: true }) }) });
    await dispatch(online.handlers, { url });

    const offline = loadServiceWorker({ cacheStore, fetchImpl: async () => { throw new Error('offline'); } });
    await expect(dispatch(offline.handlers, { url })).resolves.toMatchObject({ cached: true });
  });
});

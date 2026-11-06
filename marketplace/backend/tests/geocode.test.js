import { describe, it, expect, beforeEach, vi } from 'vitest';
const request = require('supertest');
const geocode = require('../src/geocode');
const { setup } = require('./helpers');

// Photon-shaped answers, so the tests don't need the network.
const feature = (props, lng, lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { countrycode: 'ZA', ...props } });
const reply = (features) => ({ ok: true, json: async () => ({ features }) });

beforeEach(() => geocode._cache.clear());

describe('address search', () => {
  it('turns provider results into labelled South African addresses', async () => {
    const fetchImpl = vi.fn(async () => reply([
      feature({ housenumber: '5', street: 'Tyrwhitt Avenue', district: 'Rosebank', city: 'Johannesburg', postcode: '2196' }, 28.045, -26.14),
      feature({ name: 'Rosebank Mall', street: 'Cradock Avenue', city: 'Johannesburg' }, 28.0436, -26.1456),
      feature({ name: 'Rosebank', city: 'Sydney', countrycode: 'AU' }, 151.2, -33.8), // wrong country
    ]));
    const r = await geocode.search('5 tyrwhitt', { lat: -26.14, lng: 28.04 }, fetchImpl);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ main: '5 Tyrwhitt Avenue', label: '5 Tyrwhitt Avenue, Rosebank, Johannesburg, 2196', city: 'Johannesburg', lat: -26.14, lng: 28.045 });
    expect(r[1].label).toContain('Rosebank Mall');
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain('photon.komoot.io/api');
    expect(url).toContain('bbox=16.3');
    expect(url).toContain('lat=-26.14');
  });

  it('needs three characters, and caches repeat searches', async () => {
    const fetchImpl = vi.fn(async () => reply([feature({ street: 'Bree Street', city: 'Cape Town' }, 18.418, -33.918)]));
    expect(await geocode.search('br', null, fetchImpl)).toEqual([]);
    await geocode.search('Bree St', null, fetchImpl);
    await geocode.search('bree st', null, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reverse-geocodes a pin inside South Africa only', async () => {
    const fetchImpl = vi.fn(async () => reply([feature({ housenumber: '200', street: 'Florida Road', district: 'Morningside', city: 'Durban' }, 31.0119, -29.8296)]));
    expect(await geocode.reverse(-29.8296, 31.0119, fetchImpl)).toMatchObject({ main: '200 Florida Road', city: 'Durban' });
    expect(await geocode.reverse(51.5, -0.12, fetchImpl)).toBeNull(); // London
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails politely when the provider is down', async () => {
    const t = await setup();
    const original = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    try {
      const res = await request(t.app).get('/api/geocode/search').query({ q: 'Main Road' });
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ results: [], error: expect.stringMatching(/drop the pin/) });
    } finally {
      global.fetch = original;
    }
  });

  it('tells the app which map tiles to use and lets them load', async () => {
    const t = await setup();
    const meta = await request(t.app).get('/api/meta');
    expect(meta.body.mapTiles.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(meta.headers['content-security-policy']).toContain('img-src \'self\' data: https://tile.openstreetmap.org');
    expect(meta.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});

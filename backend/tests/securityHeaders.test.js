import { describe, it, expect } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';

const app = buildApp();

describe('Referrer-Policy', () => {
  it('lets the browser tell map tile servers which site is asking, without the path', async () => {
    // With no-referrer, OpenStreetMap answered every tile request with its
    // "Access blocked" image. The origin is enough for OSM, and keeps paths
    // like /admin/agreements/358 private.
    const res = await request(app).get('/api/this-route-does-not-exist');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});

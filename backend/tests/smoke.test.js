import { describe, it, expect } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';

describe('smoke', () => {
  it('health check responds', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

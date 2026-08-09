import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import {
  resetAllPgTables, createPgUser, createPgBike, createPgAlert, authHeader,
} from './helpers/testPgDb.js';

const app = buildApp();

describe.skipIf(!process.env.DATABASE_URL)('insurance claims routes', () => {
  let admin, rider, bike;

  beforeEach(async () => {
    await resetAllPgTables();
    ({ user: admin } = await createPgUser({ role: 'superadmin' }));
    ({ user: rider } = await createPgUser({ role: 'rider' }));
    bike = await createPgBike();
  });

  describe('POST /api/claims', () => {
    it('files a claim and returns it hydrated with bike info', async () => {
      const res = await request(app)
        .post('/api/claims')
        .set(authHeader(admin))
        .send({ bike_id: bike.id, claim_type: 'theft', description: 'Bike stolen overnight', incident_date: '2026-08-01' });

      expect(res.status).toBe(200);
      expect(res.body.claim.status).toBe('filed');
      expect(res.body.claim.claim_type).toBe('theft');
      expect(res.body.claim.filed_by).toBe(admin.id);
      expect(res.body.claim.bike.registration).toBe(bike.registration);
    });

    it('links supporting alerts as evidence', async () => {
      const alert = await createPgAlert({ bike_id: bike.id, alert_type: 'towing' });
      const res = await request(app)
        .post('/api/claims')
        .set(authHeader(admin))
        .send({ bike_id: bike.id, claim_type: 'theft', description: 'Towing alert fired', linked_alert_ids: [alert.id] });

      expect(res.status).toBe(200);
      expect(res.body.claim.alerts).toHaveLength(1);
      expect(res.body.claim.alerts[0].alert_type).toBe('towing');
    });

    it('rejects a missing bike_id', async () => {
      const res = await request(app).post('/api/claims').set(authHeader(admin)).send({ claim_type: 'theft', description: 'x' });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid claim_type', async () => {
      const res = await request(app).post('/api/claims').set(authHeader(admin))
        .send({ bike_id: bike.id, claim_type: 'not-a-real-type', description: 'x' });
      expect(res.status).toBe(400);
    });

    it('rejects a missing description', async () => {
      const res = await request(app).post('/api/claims').set(authHeader(admin))
        .send({ bike_id: bike.id, claim_type: 'theft' });
      expect(res.status).toBe(400);
    });

    it('404s for a nonexistent bike', async () => {
      const res = await request(app).post('/api/claims').set(authHeader(admin))
        .send({ bike_id: 999999, claim_type: 'theft', description: 'x' });
      expect(res.status).toBe(404);
    });

    it('rejects a non-admin rider', async () => {
      const res = await request(app).post('/api/claims').set(authHeader(rider))
        .send({ bike_id: bike.id, claim_type: 'theft', description: 'x' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/claims', () => {
    it('lists claims, filterable by status', async () => {
      await request(app).post('/api/claims').set(authHeader(admin)).send({ bike_id: bike.id, claim_type: 'theft', description: 'a' });
      const bike2 = await createPgBike();
      const filed = await request(app).post('/api/claims').set(authHeader(admin)).send({ bike_id: bike2.id, claim_type: 'damage', description: 'b' });
      await request(app).put(`/api/claims/${filed.body.claim.id}`).set(authHeader(admin)).send({ status: 'investigating' });

      const all = await request(app).get('/api/claims').set(authHeader(admin));
      expect(all.body.claims).toHaveLength(2);

      const filtered = await request(app).get('/api/claims?status=investigating').set(authHeader(admin));
      expect(filtered.body.claims).toHaveLength(1);
      expect(filtered.body.claims[0].claim_type).toBe('damage');
    });
  });

  describe('GET /api/claims/:id', () => {
    it('404s for a nonexistent claim', async () => {
      const res = await request(app).get('/api/claims/999999').set(authHeader(admin));
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/claims/:id', () => {
    async function fileClaim() {
      const res = await request(app).post('/api/claims').set(authHeader(admin))
        .send({ bike_id: bike.id, claim_type: 'theft', description: 'x' });
      return res.body.claim;
    }

    it('updates status and sets resolved_at for a terminal status', async () => {
      const claim = await fileClaim();
      const res = await request(app).put(`/api/claims/${claim.id}`).set(authHeader(admin)).send({ status: 'paid' });
      expect(res.status).toBe(200);
      expect(res.body.claim.status).toBe('paid');
      expect(res.body.claim.resolved_at).not.toBeNull();
    });

    it('does not set resolved_at for a non-terminal status', async () => {
      const claim = await fileClaim();
      const res = await request(app).put(`/api/claims/${claim.id}`).set(authHeader(admin)).send({ status: 'investigating' });
      expect(res.body.claim.resolved_at).toBeNull();
    });

    it('updates payout_amount and notes', async () => {
      const claim = await fileClaim();
      const res = await request(app).put(`/api/claims/${claim.id}`).set(authHeader(admin)).send({ payout_amount: 15000, notes: 'Insurer ref #123' });
      expect(res.status).toBe(200);
      expect(Number(res.body.claim.payout_amount)).toBe(15000);
      expect(res.body.claim.notes).toBe('Insurer ref #123');
    });

    it('rejects an invalid status', async () => {
      const claim = await fileClaim();
      const res = await request(app).put(`/api/claims/${claim.id}`).set(authHeader(admin)).send({ status: 'not-a-status' });
      expect(res.status).toBe(400);
    });

    it('rejects an empty update', async () => {
      const claim = await fileClaim();
      const res = await request(app).put(`/api/claims/${claim.id}`).set(authHeader(admin)).send({});
      expect(res.status).toBe(400);
    });

    it('404s for a nonexistent claim', async () => {
      const res = await request(app).put('/api/claims/999999').set(authHeader(admin)).send({ status: 'paid' });
      expect(res.status).toBe(404);
    });
  });
});

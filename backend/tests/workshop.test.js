import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// The workshop had 97 job cards to its name and three quiet problems in them:
// work that stopped moving with nothing to say so, every card assigned to an
// admin who does not turn spanners, and a third of finished jobs closing with
// no record of what they cost.
describe.skipIf(!process.env.DATABASE_URL)('workshop', () => {
  let tech;
  let admin;
  let bike;

  const create = (body, as = admin) =>
    request(app).post('/api/workshop/job-cards').set(authHeader(as)).send(body);
  const dashboard = (as = admin) =>
    request(app).get('/api/workshop/dashboard').set(authHeader(as));
  const addItem = (id, body) =>
    request(app).post(`/api/workshop/job-cards/${id}/items`).set(authHeader(admin)).send(body);
  const ageCard = (id, days) =>
    pgDb.query(`UPDATE job_cards SET created_at = NOW() - ($1 || ' days')::interval WHERE id = $2`, [String(days), id]);

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'superadmin' })).user;
    tech = (await createPgUser({ role: 'technician' })).user;
    bike = await createPgBike();
  });

  describe('assignment', () => {
    it('leaves a job unassigned rather than quietly giving it to whoever raised it', async () => {
      const res = await create({ bike_id: bike.id, job_type: 'repair', description: 'Brakes' });
      expect(res.status).toBe(200);

      const { rows } = await pgDb.query('SELECT technician_id FROM job_cards WHERE id = $1', [res.body.id]);
      // This is the whole bug: it used to default to req.user.id, so 89 of 97
      // real job cards landed on one superadmin account.
      expect(rows[0].technician_id).toBeNull();
    });

    it('assigns to a named technician when one is given', async () => {
      const res = await create({ bike_id: bike.id, job_type: 'repair', technician_id: tech.id });
      const { rows } = await pgDb.query('SELECT technician_id FROM job_cards WHERE id = $1', [res.body.id]);
      expect(rows[0].technician_id).toBe(tech.id);
    });

    it('refuses an assignee who cannot be given work', async () => {
      const rider = (await createPgUser({ role: 'rider' })).user;
      const res = await create({ bike_id: bike.id, job_type: 'repair', technician_id: rider.id });
      expect(res.status).toBe(400);
    });

    it('counts unassigned active work on the dashboard', async () => {
      await create({ bike_id: bike.id, job_type: 'repair' });
      await create({ bike_id: bike.id, job_type: 'repair', technician_id: tech.id });

      const res = await dashboard();
      expect(res.body.stats.unassigned_count).toBe(1);
    });
  });

  describe('work that has stopped moving', () => {
    it('counts a job open past a week and never started', async () => {
      const fresh = await create({ bike_id: bike.id, job_type: 'repair' });
      const stale = await create({ bike_id: bike.id, job_type: 'repair' });
      await ageCard(stale.body.id, 30);

      const res = await dashboard();
      expect(res.body.stats.stalled_count).toBe(1);
      expect(res.body.stats.oldest_active_days).toBe(30);
      expect(fresh.body.id).toBeDefined();
    });

    it('does not count a job that has actually been started', async () => {
      const started = await create({ bike_id: bike.id, job_type: 'repair' });
      await ageCard(started.body.id, 30);
      await request(app).post(`/api/workshop/job-cards/${started.body.id}/start`).set(authHeader(admin));

      const res = await dashboard();
      expect(res.body.stats.stalled_count).toBe(0);
    });

    it('puts the longest-waiting job first, and stops hiding any of them', async () => {
      const ids = [];
      for (let i = 0; i < 12; i++) {
        const r = await create({ bike_id: bike.id, job_type: 'repair' });
        await ageCard(r.body.id, i);          // i = 0 newest … 11 oldest
        ids.push(r.body.id);
      }

      const res = await dashboard();
      // Twelve open jobs used to meet a LIMIT 10 sorted newest-first, so the
      // two that had waited longest appeared nowhere at all.
      expect(res.body.active_jobs).toHaveLength(12);
      expect(res.body.active_jobs[0].id).toBe(ids[11]);
      expect(res.body.active_jobs[0].days_open).toBe(11);
    });
  });

  describe('closing a job with nothing costed', () => {
    const completeBody = { completion_notes: 'Done', odometer_km: 12000 };

    it('refuses to close a job that has no parts or labour on it', async () => {
      const job = await create({ bike_id: bike.id, job_type: 'repair' });
      const res = await request(app)
        .post(`/api/workshop/job-cards/${job.body.id}/complete`).set(authHeader(admin)).send(completeBody);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('no_cost_lines');
    });

    it('closes it when that is said explicitly', async () => {
      const job = await create({ bike_id: bike.id, job_type: 'repair' });
      const res = await request(app)
        .post(`/api/workshop/job-cards/${job.body.id}/complete`).set(authHeader(admin))
        .send({ ...completeBody, allow_uncosted: true });

      expect(res.status).toBe(200);
    });

    it('closes a costed job without argument', async () => {
      const job = await create({ bike_id: bike.id, job_type: 'repair' });
      await addItem(job.body.id, { item_type: 'part', description: 'Brake pads', quantity: 2, unit_cost: 150 });
      const res = await request(app)
        .post(`/api/workshop/job-cards/${job.body.id}/complete`).set(authHeader(admin)).send(completeBody);

      expect(res.status).toBe(200);
    });
  });

  describe('quotes', () => {
    const approve = (id) => request(app).post(`/api/workshop/job-cards/${id}/quote/approve`).set(authHeader(admin));

    it('records the figure the job stood at when it was approved', async () => {
      const job = await create({ bike_id: bike.id, job_type: 'repair' });
      await addItem(job.body.id, { item_type: 'part', description: 'Chain', quantity: 1, unit_cost: 400 });
      await addItem(job.body.id, { item_type: 'labor', description: 'Fit chain', quantity: 2, unit_cost: 275 });

      const res = await approve(job.body.id);
      expect(res.status).toBe(200);
      expect(res.body.quote_amount).toBe(950);
    });

    it('holds that figure when the job grows afterwards', async () => {
      const job = await create({ bike_id: bike.id, job_type: 'repair' });
      await addItem(job.body.id, { item_type: 'part', description: 'Chain', quantity: 1, unit_cost: 400 });
      await approve(job.body.id);
      await addItem(job.body.id, { item_type: 'part', description: 'Sprocket', quantity: 1, unit_cost: 600 });

      const { rows } = await pgDb.query('SELECT quote_amount FROM job_cards WHERE id = $1', [job.body.id]);
      // An approval that tracked the live total would have silently agreed to
      // R1,000 — a figure nobody ever signed off.
      expect(Number(rows[0].quote_amount)).toBe(400);
    });

    it('has nothing to approve on an empty job', async () => {
      const job = await create({ bike_id: bike.id, job_type: 'repair' });
      expect((await approve(job.body.id)).status).toBe(400);
    });

    it('will not approve the same quote twice', async () => {
      const job = await create({ bike_id: bike.id, job_type: 'repair' });
      await addItem(job.body.id, { item_type: 'part', description: 'Chain', quantity: 1, unit_cost: 400 });
      expect((await approve(job.body.id)).status).toBe(200);
      expect((await approve(job.body.id)).status).toBe(400);
    });
  });
});

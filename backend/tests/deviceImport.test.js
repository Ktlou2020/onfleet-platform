import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// Loading a batch of trackers onto a fleet's bikes.
//
// Devices arrive from a supplier as a list. The single-device form means
// opening it once per tracker, which on a fifty-unit order is fifty chances
// to fumble an IMEI. This is the operator's routine job on a telematics
// deployment, so it takes the list.
//
// The behaviour worth pinning down is what happens when part of a batch is
// wrong, because that is the normal case: a supplier list with one duplicate
// in it, or a registration that does not match anything.

const IMEI = (n) => `35320195${String(100000 + n)}`;

describe.skipIf(!process.env.DATABASE_URL)('importing a batch of trackers', () => {
  let admin, tech, org;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });
    org = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    await createPgBike({ registration: 'RAP001GP', organization_id: org.id });
    await createPgBike({ registration: 'RAP002GP', organization_id: org.id });
  });

  const preview = (text) => request(app).post('/api/tracking/devices/import/preview')
    .set(authHeader(admin.user)).send({ text });
  const load = (text, opts = {}) => request(app).post('/api/tracking/devices/import')
    .set(authHeader(admin.user)).send({ text, ...opts });

  const GOOD = `${IMEI(1)},RAP001GP,FMB920\n${IMEI(2)},RAP002GP,FMB920`;

  describe('a clean list', () => {
    it('previews as loadable, and changes nothing yet', async () => {
      const res = await preview(GOOD);
      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({ total: 2, ok: 2, problems: 0 });

      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM tracking_devices');
      expect(rows[0].n, 'preview wrote something').toBe(0);
    });

    it('loads onto the right bikes', async () => {
      const res = await load(GOOD);
      expect(res.status).toBe(201);
      expect(res.body.count).toBe(2);

      const { rows } = await pgDb.query(
        `SELECT d.imei, b.registration FROM tracking_devices d
           JOIN bikes b ON b.id = d.bike_id ORDER BY d.imei`);
      expect(rows).toEqual([
        { imei: IMEI(1), registration: 'RAP001GP' },
        { imei: IMEI(2), registration: 'RAP002GP' },
      ]);
    });

    it('tolerates a header, tabs and stray spacing', async () => {
      const messy = `IMEI,Registration,Model\n  ${IMEI(1)}\t rap001gp \tFMB920  `;
      const res = await load(messy);
      expect(res.status).toBe(201);
      expect(res.body.count).toBe(1);
      const { rows } = await pgDb.query(
        `SELECT b.registration FROM tracking_devices d JOIN bikes b ON b.id = d.bike_id`);
      expect(rows[0].registration).toBe('RAP001GP');
    });

    // A tracker with no registration is stock, which is a normal thing to
    // receive and not the same as a registration that matches nothing.
    it('takes a tracker into stock when no bike is named', async () => {
      const res = await load(`${IMEI(9)}`);
      expect(res.status).toBe(201);
      const { rows } = await pgDb.query('SELECT bike_id FROM tracking_devices WHERE imei = $1', [IMEI(9)]);
      expect(rows[0].bike_id).toBeNull();
    });
  });

  describe('a list with something wrong in it', () => {
    it('names the bad line rather than the batch', async () => {
      const res = await preview(`${IMEI(1)},RAP001GP\n${IMEI(2)},NOSUCH99`);
      expect(res.body.summary).toMatchObject({ total: 2, ok: 1, problems: 1 });
      expect(res.body.rows[1].problems[0]).toMatch(/No bike with registration NOSUCH99/);
    });

    it('catches a duplicate inside the list itself', async () => {
      const res = await preview(`${IMEI(1)},RAP001GP\n${IMEI(1)},RAP002GP`);
      expect(res.body.rows[1].problems.join(' ')).toMatch(/Same IMEI as line 1/);
    });

    it('catches a tracker that is already registered', async () => {
      await load(`${IMEI(1)},RAP001GP`);
      const res = await preview(`${IMEI(1)},RAP002GP`);
      expect(res.body.rows[0].problems).toContain('Already registered');
    });

    it('catches a bike that already has one', async () => {
      await load(`${IMEI(1)},RAP001GP`);
      const res = await preview(`${IMEI(5)},RAP001GP`);
      expect(res.body.rows[0].problems.join(' ')).toMatch(/already has tracker/);
    });

    it('rejects an IMEI that is not one', async () => {
      const res = await preview('12345,RAP001GP');
      expect(res.body.rows[0].problems.join(' ')).toMatch(/10 to 20 digits/);
    });

    // The header rule used to be "the first field mentions IMEI", which ate a
    // first row reading IMEI123456789 — a real shape for a supplier list, and
    // a tracker dropped without a word.
    it('does not mistake a data row for a header', async () => {
      const res = await preview(`IMEI${'1'.repeat(12)},RAP001GP`);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.header_skipped).toBeNull();
    });

    it('and says so when it does skip a header', async () => {
      const res = await preview(`IMEI,Registration\n${'3'.repeat(15)},RAP001GP`);
      expect(res.body.header_skipped).toBe('IMEI,Registration');
      expect(res.body.rows).toHaveLength(1);
    });

    // The important one. A half-loaded batch cannot be re-run and cannot be
    // undone, so it is refused outright unless somebody has seen the preview
    // and said to load the rest.
    it('loads nothing at all rather than part of it', async () => {
      const res = await load(`${IMEI(1)},RAP001GP\n${IMEI(2)},NOSUCH99`);
      expect(res.status).toBe(400);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM tracking_devices');
      expect(rows[0].n, 'a bad batch loaded anyway').toBe(0);
    });

    it('but loads the good rows when told to skip the bad', async () => {
      const res = await load(`${IMEI(1)},RAP001GP\n${IMEI(2)},NOSUCH99`, { skip_problem_rows: true });
      expect(res.status).toBe(201);
      expect(res.body.count).toBe(1);
      expect(res.body.skipped).toBe(1);
    });
  });

  describe('who may do it', () => {
    it('not a technician', async () => {
      const res = await request(app).post('/api/tracking/devices/import')
        .set(authHeader(tech.user)).send({ text: GOOD });
      expect(res.status).toBe(403);
    });

    it('and it is written to the audit log', async () => {
      await load(GOOD);
      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'tracking.device_import'`);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].metadata).loaded).toBe(2);
    });
  });
});

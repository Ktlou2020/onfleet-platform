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

  // Which column is which.
  //
  // The three fields were read positionally as IMEI, registration, model. A
  // real supplier list arrived the other way round — registration first —
  // and every one of its twenty-two lines failed twice over: the plate
  // rejected for not being digits, and the IMEI reported as a registration
  // matching no bike. They are not confusable shapes, so order stops
  // mattering.
  describe('whatever order the supplier sends', () => {
    it('takes registration, IMEI, model', async () => {
      const res = await preview(`RAP001GP,${IMEI(1)},FMC920\nRAP002GP,${IMEI(2)},FMB920`);
      expect(res.status).toBe(200);
      expect(res.body.summary, 'a supplier list ordered the other way was rejected entirely')
        .toMatchObject({ total: 2, ok: 2, problems: 0 });
      expect(res.body.rows[0]).toMatchObject({ imei: IMEI(1), registration: 'RAP001GP', model: 'FMC920' });
    });

    it('still takes IMEI, registration, model', async () => {
      const res = await preview(GOOD);
      expect(res.body.summary).toMatchObject({ total: 2, ok: 2, problems: 0 });
      expect(res.body.rows[0]).toMatchObject({ imei: IMEI(1), registration: 'RAP001GP' });
    });

    it('takes the model first, which no supplier should do but one will', async () => {
      const res = await preview(`FMB920,${IMEI(1)},RAP001GP`);
      expect(res.body.rows[0]).toMatchObject({ imei: IMEI(1), registration: 'RAP001GP', model: 'FMB920' });
    });

    it('takes a tracker with no registration, in either order', async () => {
      const res = await preview(`${IMEI(1)},FMB920\nFMC920,${IMEI(2)}`);
      expect(res.body.summary).toMatchObject({ total: 2, ok: 2, problems: 0, to_stock: 2 });
      expect(res.body.rows[0]).toMatchObject({ imei: IMEI(1), registration: null, model: 'FMB920' });
      expect(res.body.rows[1]).toMatchObject({ imei: IMEI(2), registration: null, model: 'FMC920' });
    });

    it('and loads them onto the right bikes', async () => {
      const res = await load(`RAP001GP,${IMEI(1)},FMC920`);
      expect(res.status).toBe(201);
      const { rows } = await pgDb.query(
        `SELECT d.imei, b.registration FROM tracking_devices d JOIN bikes b ON b.id = d.bike_id`);
      expect(rows).toEqual([{ imei: IMEI(1), registration: 'RAP001GP' }]);
    });

    // When nothing is IMEI-shaped the complaint has to land on the field the
    // operator meant as the IMEI, not on whatever happened to be first.
    it('still blames the right field when there is no IMEI at all', async () => {
      // On line two, because a first line with no digits in its first field
      // is treated as a header — which is the right call and would otherwise
      // eat this fixture.
      const res = await preview(`${IMEI(1)},RAP001GP,FMB920\nNOTANIMEI,RAP002GP,FMB920`);
      const bad = res.body.rows.find((r) => r.line === 2);
      expect(bad.imei).toBe('NOTANIMEI');
      expect(bad.problems.join(' ')).toContain('IMEI should be 10 to 20 digits');
    });
  });

  // Bikes a tracker list names that the platform does not have.
  //
  // Off unless asked for. A tracker list carries no VIN, make or model, so
  // each bike created here is a skeleton someone finishes later — and on a
  // per-bike plan it is a chargeable row, so a mistyped plate would become a
  // phantom bike that bills.
  describe('creating the bikes a list names', () => {
    const UNKNOWN = `${IMEI(1)},NEWBIKE1GP,FMB920\n${IMEI(2)},NEWBIKE2GP,FMB920`;

    it('counts them in the preview without creating anything', async () => {
      const res = await preview(UNKNOWN);
      expect(res.body.summary).toMatchObject({ total: 2, ok: 0, problems: 2, missing_bikes: 2 });
      const { rows } = await pgDb.query("SELECT COUNT(*)::int AS n FROM bikes WHERE registration LIKE 'NEWBIKE%'");
      expect(rows[0].n, 'a preview created bikes').toBe(0);
    });

    it('creates nothing unless asked', async () => {
      await load(UNKNOWN, { skip_problem_rows: true });
      const { rows } = await pgDb.query("SELECT COUNT(*)::int AS n FROM bikes WHERE registration LIKE 'NEWBIKE%'");
      expect(rows[0].n).toBe(0);
    });

    it('creates them and loads the trackers onto them when asked', async () => {
      const res = await load(UNKNOWN, { create_missing_bikes: true });
      expect(res.status).toBe(201);
      expect(res.body.count).toBe(2);
      expect(res.body.created_bikes.map((b) => b.registration).sort()).toEqual(['NEWBIKE1GP', 'NEWBIKE2GP']);

      const { rows } = await pgDb.query(
        `SELECT b.registration, b.vin, b.make, d.imei
           FROM bikes b JOIN tracking_devices d ON d.bike_id = b.id
          WHERE b.registration LIKE 'NEWBIKE%' ORDER BY b.registration`);
      expect(rows).toHaveLength(2);
      // The VIN is required and unique and a tracker list has none, so it
      // says it is missing rather than inventing something that looks real.
      expect(rows[0].vin).toBe('AWAITING-VIN-NEWBIKE1GP');
      expect(rows[0].make).toBe('Unknown');
    });

    it('puts them on the named fleet', async () => {
      const res = await load(UNKNOWN, { create_missing_bikes: true, organization_id: org.id });
      expect(res.status).toBe(201);
      const { rows } = await pgDb.query(
        "SELECT organization_id FROM bikes WHERE registration = 'NEWBIKE1GP'");
      expect(rows[0].organization_id).toBe(org.id);
    });

    it('leaves them as platform stock when no fleet is named', async () => {
      await load(UNKNOWN, { create_missing_bikes: true });
      const { rows } = await pgDb.query(
        "SELECT organization_id FROM bikes WHERE registration = 'NEWBIKE1GP'");
      expect(rows[0].organization_id).toBeNull();
    });

    // Asserting the status alone proved nothing: this handler already
    // answers 400 when rows cannot load, so the test passed with the fleet
    // check deleted. It has to name the reason.
    it('refuses a fleet that does not exist rather than creating orphans', async () => {
      const res = await load(UNKNOWN, { create_missing_bikes: true, organization_id: 999999 });
      expect(res.status).toBe(400);
      expect(res.body.error, 'it failed for some other reason, so this proves nothing')
        .toBe('That fleet does not exist');
      const { rows } = await pgDb.query("SELECT COUNT(*)::int AS n FROM bikes WHERE registration LIKE 'NEWBIKE%'");
      expect(rows[0].n).toBe(0);
    });

    // Creating a bike does not fix a duplicate IMEI, so that line is not
    // one of the ones offered.
    it('does not offer to create for a line that is wrong for another reason too', async () => {
      const res = await preview(`${IMEI(1)},NEWBIKE1GP,FMB920\n${IMEI(1)},NEWBIKE2GP,FMB920`);
      const offered = res.body.rows.filter((r) => r.can_create_bike);
      expect(offered).toHaveLength(1);
      expect(res.body.summary.missing_bikes).toBe(1);
    });

    // The screen's own arithmetic, which is where this shipped broken: the
    // load button read "22 lines to fix first" and stayed disabled over a
    // list whose every problem was the one the operator had just ticked the
    // box to fix. The server was right and the button was wrong, so the
    // feature could not be reached from the page that offers it.
    //
    // Asserted on the numbers the button is built from rather than on the
    // button, because those are what the page gets wrong.
    it('leaves nothing to fix once the missing bikes are accounted for', async () => {
      const res = await preview(UNKNOWN);
      const { problems, missing_bikes: missing } = res.body.summary;
      expect(problems).toBe(2);
      expect(missing).toBe(2);
      expect(problems - missing, 'the screen would still say there are lines to fix').toBe(0);
    });

    it('and still has something to fix when a line is wrong for another reason', async () => {
      const res = await preview(`${IMEI(1)},NEWBIKE1GP,FMB920\n${IMEI(1)},NEWBIKE2GP,FMB920`);
      const { problems, missing_bikes: missing } = res.body.summary;
      expect(problems - missing, 'a duplicate IMEI is not fixed by creating a bike').toBeGreaterThan(0);
    });

    it('records what it created', async () => {
      await load(UNKNOWN, { create_missing_bikes: true, organization_id: org.id });
      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'tracking.import_created_bikes'`);
      expect(rows).toHaveLength(1);
      const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
      expect(meta.registrations.sort()).toEqual(['NEWBIKE1GP', 'NEWBIKE2GP']);
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

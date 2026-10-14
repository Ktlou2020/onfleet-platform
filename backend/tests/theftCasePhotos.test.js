import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, authHeader,
} from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const photos = load('../src/services/theftCasePhotos.js');
const UPLOAD_DIRS = load('../src/uploadPaths.js');
const fs = load('node:fs');
const nodePath = load('node:path');
const app = buildApp();

// Photographs on a theft case.
//
// The case could already say a bike was recovered. It could not show it, and
// "recovered" with nothing behind it is what an insurer asks about a year
// later. These cover the two things that matter more than the uploading:
//
// A fleet owner must never reach another fleet's photographs. The case is
// scoped before a byte is written or served, every refusal is a 404 so no one
// learns a case exists from the way they are told no, and swapping a photo id
// onto a case you do own must not work either.
//
// And the files must not be reachable without asking the platform. Everything
// under the upload tree is served by /uploads with no authorization check at
// all, so these live outside it — a test, because the next person to add an
// upload directory will copy whichever pattern they find.

// A real 1x1 PNG. Anything shorter is rejected before it reaches the filter
// being tested.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

describe.skipIf(!process.env.DATABASE_URL)('photographs on a theft case', () => {
  let orgA, orgB, ownerA, ownerB, admin, control, bikeA, bikeB, caseA, caseB;

  // Truncating the tables does not delete the files they pointed at, and this
  // suite writes a few hundred of them between the cap test and the mutants.
  // Left alone they pile up in a working tree forever, so the run cleans up
  // after itself — and only after itself: anything that was in the directory
  // before the suite started belongs to whoever is using this machine.
  const before = new Set(fs.existsSync(photos.PHOTO_DIR) ? fs.readdirSync(photos.PHOTO_DIR) : []);
  afterAll(() => {
    if (!fs.existsSync(photos.PHOTO_DIR)) return;
    for (const name of fs.readdirSync(photos.PHOTO_DIR)) {
      if (before.has(name)) continue;
      try { fs.unlinkSync(nodePath.join(photos.PHOTO_DIR, name)); } catch { /* best effort */ }
    }
    try { fs.rmSync(nodePath.join(UPLOAD_DIRS.base, 'private'), { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const openCase = async (bikeId) => {
    const { rows } = await pgDb.query(
      `INSERT INTO theft_cases (bike_id, opened_reason, status) VALUES ($1,'Reported stolen','open') RETURNING *`,
      [bikeId]);
    return rows[0];
  };

  beforeEach(async () => {
    await resetAllPgTables();
    orgA = await createPgOrg({ name: 'Rapid Wheels' });
    orgB = await createPgOrg({ name: 'Kasi Couriers' });
    await pgDb.query(
      `UPDATE organizations SET status='active', subscription_status='active', subscription_tier='complete'
        WHERE id = ANY($1)`, [[orgA.id, orgB.id]]);

    admin = (await createPgUser({ role: 'superadmin' })).user;
    control = (await createPgUser({ role: 'control_room' })).user;
    ownerA = (await createPgUser({ role: 'fleet_owner_admin', organization_id: orgA.id })).user;
    ownerB = (await createPgUser({ role: 'fleet_owner_admin', organization_id: orgB.id })).user;

    bikeA = await createPgBike({ registration: 'RAP001GP', organization_id: orgA.id, status: 'stolen' });
    bikeB = await createPgBike({ registration: 'KAS001GP', organization_id: orgB.id, status: 'stolen' });
    caseA = await openCase(bikeA.id);
    caseB = await openCase(bikeB.id);
  });

  const attach = (path_, who, { stage, caption, file = PNG, name = 'recovered.png' } = {}) => {
    let req = request(app).post(path_).set(authHeader(who)).attach('photo', file, name);
    if (stage) req = req.field('stage', stage);
    if (caption) req = req.field('caption', caption);
    return req;
  };

  const opPath = (c = caseA) => `/api/tracking/theft-cases/${c.id}/photos`;
  const fleetPath = (c = caseA) => `/api/fleet/theft-cases/${c.id}/photos`;

  describe('the operator console', () => {
    it('attaches one to a case', async () => {
      const res = await attach(opPath(), admin, { stage: 'outcome', caption: 'Found in Alex' });
      expect(res.status).toBe(201);
      expect(res.body.photo).toMatchObject({ stage: 'outcome', caption: 'Found in Alex' });
      expect(res.body.photo.url).toContain(`/theft-cases/${caseA.id}/photos/`);
    });

    it('and it comes back on the case', async () => {
      await attach(opPath(), admin, { stage: 'outcome' });
      const res = await request(app).get(`/api/tracking/theft-cases/${caseA.id}`).set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.photos).toHaveLength(1);
      expect(res.body.photos[0].stage).toBe('outcome');
    });

    it('and the image itself is served', async () => {
      const { body } = await attach(opPath(), admin);
      const res = await request(app).get(`/api${body.photo.url}`).set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });

    // The control room works these cases at two in the morning. Notes and
    // closing are already open to them; a photograph of the bike in a yard is
    // worth no less for being taken by whoever found it.
    it('lets the control room attach one', async () => {
      expect((await attach(opPath(), control)).status).toBe(201);
    });

    // Deleting evidence is a different thing from adding it.
    it('but only an admin may delete one', async () => {
      const { body } = await attach(opPath(), admin);
      const url = `/api/tracking/theft-cases/${caseA.id}/photos/${body.photo.id}`;
      expect((await request(app).delete(url).set(authHeader(control))).status).toBe(403);
      expect((await request(app).delete(url).set(authHeader(admin))).status).toBe(200);
    });

    it('refuses a file that is not an image', async () => {
      const res = await attach(opPath(), admin, { file: Buffer.from('%PDF-1.4'), name: 'report.pdf' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not an image/i);
    });

    it('refuses a stage it does not recognise', async () => {
      const res = await attach(opPath(), admin, { stage: 'whenever' });
      expect(res.status).toBe(400);
    });

    it('refuses more than the cap', async () => {
      for (let i = 0; i < photos.MAX_PER_CASE; i += 1) {
        expect((await attach(opPath(), admin)).status).toBe(201);
      }
      const res = await attach(opPath(), admin);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already has/i);
    });

    it('and 404s on a case that does not exist', async () => {
      const res = await attach('/api/tracking/theft-cases/999999/photos', admin);
      expect(res.status).toBe(404);
    });
  });

  // The number goes on the closing event itself, because "closed as recovered"
  // and "closed as recovered, four photographs" are different claims when the
  // insurer asks and nobody should have to count rows to tell them apart.
  describe('closing the case', () => {
    it('records how many photographs were attached', async () => {
      await attach(opPath(), admin, { stage: 'outcome' });
      await attach(opPath(), admin, { stage: 'outcome' });

      const res = await request(app).put(`/api/tracking/theft-cases/${caseA.id}/status`)
        .set(authHeader(admin)).send({ status: 'recovered', note: 'Found in Alex' });
      expect(res.status).toBe(200);

      const { rows } = await pgDb.query(
        `SELECT summary, detail FROM theft_case_events WHERE case_id = $1 AND kind = 'closed'`, [caseA.id]);
      expect(rows[0].summary).toBe('Closed as recovered — 2 photographs');
      expect(rows[0].detail.photos).toBe(2);
    });

    it('and says so in the singular for one', async () => {
      await attach(opPath(), admin, { stage: 'outcome' });
      await request(app).put(`/api/tracking/theft-cases/${caseA.id}/status`)
        .set(authHeader(admin)).send({ status: 'recovered' });
      const { rows } = await pgDb.query(
        `SELECT summary FROM theft_case_events WHERE case_id = $1 AND kind = 'closed'`, [caseA.id]);
      expect(rows[0].summary).toBe('Closed as recovered — 1 photograph');
    });

    it('and leaves the wording alone when there are none', async () => {
      await request(app).put(`/api/tracking/theft-cases/${caseA.id}/status`)
        .set(authHeader(admin)).send({ status: 'recovered' });
      const { rows } = await pgDb.query(
        `SELECT summary FROM theft_case_events WHERE case_id = $1 AND kind = 'closed'`, [caseA.id]);
      expect(rows[0].summary).toBe('Closed as recovered');
    });
  });

  describe('the fleet portal', () => {
    it('lets an owner attach one to their own case', async () => {
      const res = await attach(fleetPath(caseA), ownerA, { stage: 'outcome' });
      expect(res.status).toBe(201);
    });

    it('and read it back on the case', async () => {
      await attach(fleetPath(caseA), ownerA, { stage: 'outcome' });
      const res = await request(app).get(`/api/fleet/theft-cases/${caseA.id}`).set(authHeader(ownerA));
      expect(res.status).toBe(200);
      expect(res.body.photos).toHaveLength(1);
    });

    // Every refusal below is 404 rather than 403: a fleet must not be able to
    // learn that another fleet's case exists from the way it is told no.
    it('refuses an upload to another fleet\'s case', async () => {
      const res = await attach(fleetPath(caseB), ownerA, { stage: 'outcome' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int AS n FROM theft_case_photos WHERE case_id = $1', [caseB.id]);
      expect(rows[0].n, 'a photograph was written onto another fleet\'s case').toBe(0);
    });

    it('refuses to serve another fleet\'s photograph', async () => {
      const { body } = await attach(fleetPath(caseB), ownerB, { stage: 'outcome' });
      const res = await request(app)
        .get(`/api/fleet/theft-cases/${caseB.id}/photos/${body.photo.id}/image`).set(authHeader(ownerA));
      expect(res.status).toBe(404);
    });

    it('refuses to delete another fleet\'s photograph', async () => {
      const { body } = await attach(fleetPath(caseB), ownerB, { stage: 'outcome' });
      const res = await request(app)
        .delete(`/api/fleet/theft-cases/${caseB.id}/photos/${body.photo.id}`).set(authHeader(ownerA));
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int AS n FROM theft_case_photos WHERE id = $1', [body.photo.id]);
      expect(rows[0].n, 'another fleet deleted the evidence').toBe(1);
    });

    // The sideways route: a case id you are allowed to see, with a photo id
    // you are not. The photo is looked up by both or not at all.
    it('refuses a photo id borrowed from another case', async () => {
      const { body } = await attach(fleetPath(caseB), ownerB, { stage: 'outcome' });
      const res = await request(app)
        .get(`/api/fleet/theft-cases/${caseA.id}/photos/${body.photo.id}/image`).set(authHeader(ownerA));
      expect(res.status).toBe(404);
    });
  });

  // These files sit outside the upload tree precisely so that route cannot
  // reach them, and app.js refuses the prefix as well so an object store
  // cannot reopen what the disk layout closes.
  describe('the unauthenticated /uploads route', () => {
    // A real file, planted inside the public tree under a private/ prefix.
    //
    // The photographs themselves live outside that tree, so asking for one
    // there 404s whether the prefix is refused or not — which is a test that
    // proves nothing. What the guard actually promises is that the prefix is
    // refused, and the only way to see that is to put something reachable
    // behind it and watch the route decline to serve it anyway.
    const planted = nodePath.join(UPLOAD_DIRS.base, 'private', 'theft-case-photos');

    beforeEach(() => {
      fs.mkdirSync(planted, { recursive: true });
      fs.writeFileSync(nodePath.join(planted, 'planted.png'), PNG);
    });

    it('will not serve a private path', async () => {
      const res = await request(app).get('/uploads/private/theft-case-photos/planted.png');
      expect(res.status, 'a private file was served with no authorization at all').toBe(404);
    });

    it('nor to a HEAD request', async () => {
      const res = await request(app).head('/uploads/private/theft-case-photos/planted.png');
      expect(res.status).toBe(404);
    });

    it('nor one that climbs into it', async () => {
      const res = await request(app).get('/uploads/foo/../private/theft-case-photos/planted.png');
      expect(res.status).toBe(404);
    });

    // The guard must not swallow the rest of the tree with it.
    it('but still serves an ordinary upload', async () => {
      const ordinary = nodePath.join(UPLOAD_DIRS.base, 'part-photos');
      fs.mkdirSync(ordinary, { recursive: true });
      fs.writeFileSync(nodePath.join(ordinary, 'ordinary.png'), PNG);
      const res = await request(app).get('/uploads/part-photos/ordinary.png');
      expect(res.status, 'the private guard broke every other upload').toBe(200);
    });
  });

  it('photographs go when the case goes', async () => {
    const { body } = await attach(opPath(), admin);
    await pgDb.query('DELETE FROM theft_cases WHERE id = $1', [caseA.id]);
    const { rows } = await pgDb.query('SELECT COUNT(*)::int AS n FROM theft_case_photos WHERE id = $1', [body.photo.id]);
    expect(rows[0].n).toBe(0);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// Telling the technician what the control room already knows.
//
// A bike throwing towing alerts because the ignition feed is on the wrong
// terminal is a fact the control room reads off the map. The technician who
// opens the bike up learns it from nobody: bike_notes was written and read
// only from the tracking side. So the bike came in, got a service, and went
// out still miswired, and the alerts carried on.

const WIRING = 'Towing alerts firing — ignition feed to the tracker is on the wrong terminal, needs rewiring.';
const RIDER_CHASE = 'Rider says he will settle the arrears on Friday.';

describe.skipIf(!process.env.DATABASE_URL)('an instruction left for the workshop', () => {
  let admin, tech, bike, jobCardId;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });
    bike = await createPgBike({ status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, status, created_by, description)
       VALUES ($1,'open',$2,'Routine service') RETURNING id`, [bike.id, admin.user.id]);
    jobCardId = rows[0].id;
  });

  const leaveNote = (note, forWorkshop) =>
    request(app).post(`/api/tracking/bikes/${bike.id}/notes`)
      .set(authHeader(admin.user)).send({ note, for_workshop: forWorkshop });

  const openJobCard = () =>
    request(app).get(`/api/workshop/job-cards/${jobCardId}`).set(authHeader(tech.user));

  it('reaches the technician who opens the job card', async () => {
    await leaveNote(WIRING, true);
    const res = await openJobCard();
    expect(res.status).toBe(200);
    expect(res.body.job_card.bike_flags).toHaveLength(1);
    expect(res.body.job_card.bike_flags[0].note).toBe(WIRING);
  });

  it('says who raised it, so the technician knows who to ask', async () => {
    await leaveNote(WIRING, true);
    const res = await openJobCard();
    expect(res.body.job_card.bike_flags[0].raised_by).toBe(admin.user.full_name);
  });

  // The whole value of the banner is that everything in it is worth reading.
  // Control-room notes about money are not a workshop's business, and burying
  // the wiring note under them is how the panel gets ignored.
  it('leaves ordinary control-room notes out of it', async () => {
    await leaveNote(RIDER_CHASE, false);
    await leaveNote(WIRING, true);
    const res = await openJobCard();
    expect(res.body.job_card.bike_flags).toHaveLength(1);
    expect(res.body.job_card.bike_flags[0].note).toBe(WIRING);
  });

  it('is not marked for the workshop unless somebody says so', async () => {
    await request(app).post(`/api/tracking/bikes/${bike.id}/notes`)
      .set(authHeader(admin.user)).send({ note: RIDER_CHASE });
    const res = await openJobCard();
    expect(res.body.job_card.bike_flags).toHaveLength(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('once the work is done', () => {
  let admin, tech, bike, jobCardId, noteId;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });
    bike = await createPgBike({ status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, status, created_by, description)
       VALUES ($1,'open',$2,'Routine service') RETURNING id`, [bike.id, admin.user.id]);
    jobCardId = rows[0].id;
    const made = await request(app).post(`/api/tracking/bikes/${bike.id}/notes`)
      .set(authHeader(admin.user)).send({ note: WIRING, for_workshop: true });
    noteId = made.body.id;
  });

  const resolve = () =>
    request(app).post(`/api/workshop/bike-notes/${noteId}/resolve`).set(authHeader(tech.user));

  it('the technician can close it from the job card they are standing at', async () => {
    const res = await resolve();
    expect(res.status).toBe(200);
    expect(res.body.resolved.resolved_at).toBeTruthy();
  });

  // An instruction that cannot be closed is one every future technician learns
  // to scroll past, which is the failure mode of every notes panel ever built.
  it('it stops appearing on the next job card', async () => {
    await resolve();
    const res = await request(app).get(`/api/workshop/job-cards/${jobCardId}`).set(authHeader(tech.user));
    expect(res.body.job_card.bike_flags).toHaveLength(0);
  });

  it('but is kept, because what was wrong with a bike is its history', async () => {
    await resolve();
    const { rows } = await pgDb.query('SELECT note, resolved_at, resolved_by FROM bike_notes WHERE id = $1', [noteId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe(WIRING);
    expect(rows[0].resolved_by).toBe(tech.user.id);
  });

  it('and the control room can see it was dealt with, and by whom', async () => {
    await resolve();
    const res = await request(app).get(`/api/tracking/bikes/${bike.id}/notes`).set(authHeader(admin.user));
    const note = res.body.find((n) => n.id === noteId);
    expect(note.resolved_at).toBeTruthy();
    expect(note.resolved_by_name).toBe(tech.user.full_name);
  });

  // Two technicians ticking the same thing is not an error worth shouting
  // about, but it must not silently rewrite who did it or when.
  it('a second tick changes nothing', async () => {
    await resolve();
    const { rows: before } = await pgDb.query('SELECT resolved_at FROM bike_notes WHERE id = $1', [noteId]);
    const again = await resolve();
    expect(again.status).toBe(404);
    const { rows: after } = await pgDb.query('SELECT resolved_at FROM bike_notes WHERE id = $1', [noteId]);
    expect(after[0].resolved_at).toEqual(before[0].resolved_at);
  });
});

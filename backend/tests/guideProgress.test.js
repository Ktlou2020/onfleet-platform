import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// The guide lives in the product and remembers where each person got to, so a
// manager can see who has been brought on — kept on the server rather than in
// one phone's browser.
describe.skipIf(!process.env.DATABASE_URL)('the workshop guide\'s progress', () => {
  let technician;
  let admin;
  const tick = (user, body) => request(app).put('/api/workshop/guide/progress').set(authHeader(user)).send(body);
  const read = (user) => request(app).get('/api/workshop/guide/progress').set(authHeader(user));

  beforeEach(async () => {
    await resetAllPgTables();
    technician = (await createPgUser({ role: 'technician', full_name: 'Sipho N' })).user;
    admin = (await createPgUser({ role: 'admin', full_name: 'Kagiso T' })).user;
  });

  it('remembers a ticked step, and untickng it', async () => {
    expect((await read(technician)).body.done).toEqual([]);

    const ticked = await tick(technician, { step_key: 'job-card.odometer' });
    expect(ticked.status).toBe(200);
    expect(ticked.body.done).toEqual(['job-card.odometer']);
    expect((await read(technician)).body.done).toEqual(['job-card.odometer']);

    const unticked = await tick(technician, { step_key: 'job-card.odometer', done: false });
    expect(unticked.body.done).toEqual([]);
  });

  it('does not count the same step twice', async () => {
    await tick(technician, { step_key: 'parts.name' });
    await tick(technician, { step_key: 'parts.name' });
    expect((await read(technician)).body.done).toEqual(['parts.name']);
  });

  it('keeps each person\'s progress to themselves', async () => {
    await tick(technician, { step_key: 'job-card.start' });
    expect((await read(admin)).body.done).toEqual([]);
    expect((await read(technician)).body.done).toEqual(['job-card.start']);
  });

  it('refuses a step with no name', async () => {
    expect((await tick(technician, { step_key: '   ' })).status).toBe(400);
  });

  it('shows an admin who has worked through it, including people who have not started', async () => {
    await tick(technician, { step_key: 'job-card.open' });
    await tick(technician, { step_key: 'job-card.start' });
    const res = await request(app).get('/api/workshop/guide/progress/team').set(authHeader(admin));
    expect(res.status).toBe(200);
    const sipho = res.body.find((p) => p.full_name === 'Sipho N');
    const kagiso = res.body.find((p) => p.full_name === 'Kagiso T');
    expect(sipho.steps_done).toBe(2);
    expect(sipho.last_activity).toBeTruthy();
    expect(kagiso).toMatchObject({ steps_done: 0, last_activity: null });
  });

  it('keeps the team view to admins', async () => {
    expect((await request(app).get('/api/workshop/guide/progress/team').set(authHeader(technician))).status).toBe(403);
  });

  it('is not open to riders', async () => {
    const rider = (await createPgUser({ role: 'rider' })).user;
    expect((await read(rider)).status).toBe(403);
  });

  it('keeps separate guides apart', async () => {
    await tick(technician, { guide: 'workshop', step_key: 'parts.name' });
    await tick(technician, { guide: 'tracking', step_key: 'alerts.close' });
    const workshop = await request(app).get('/api/workshop/guide/progress?guide=workshop').set(authHeader(technician));
    const tracking = await request(app).get('/api/workshop/guide/progress?guide=tracking').set(authHeader(technician));
    expect(workshop.body.done).toEqual(['parts.name']);
    expect(tracking.body.done).toEqual(['alerts.close']);
  });
});

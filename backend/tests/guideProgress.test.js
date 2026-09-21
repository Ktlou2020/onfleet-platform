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
  const tick = (user, body) => request(app).put('/api/guide/progress').set(authHeader(user)).send(body);
  const read = (user, guide = 'workshop') => request(app).get(`/api/guide/progress?guide=${guide}`).set(authHeader(user));

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
    const res = await request(app).get('/api/guide/progress/team?guide=workshop').set(authHeader(admin));
    expect(res.status).toBe(200);
    const sipho = res.body.find((p) => p.full_name === 'Sipho N');
    const kagiso = res.body.find((p) => p.full_name === 'Kagiso T');
    expect(sipho.steps_done).toBe(2);
    expect(sipho.last_activity).toBeTruthy();
    expect(kagiso).toMatchObject({ steps_done: 0, last_activity: null });
  });

  it('keeps the team view to admins', async () => {
    expect((await request(app).get('/api/guide/progress/team?guide=workshop').set(authHeader(technician))).status).toBe(403);
  });

  it('is not open to riders', async () => {
    const rider = (await createPgUser({ role: 'rider' })).user;
    expect((await read(rider)).status).toBe(403);
  });

  it('keeps the workshop guide and the tracking guide apart', async () => {
    await tick(technician, { guide: 'workshop', step_key: 'parts.name' });
    await tick(technician, { guide: 'tracking', step_key: 'alerts.close' });
    expect((await read(technician, 'workshop')).body.done).toEqual(['parts.name']);
    expect((await read(technician, 'tracking')).body.done).toEqual(['alerts.close']);
  });

  // The tracking guide is read by the control room, who are not workshop staff
  // and have no business in a job card.
  it('lets the control room keep its own progress', async () => {
    const controlRoom = (await createPgUser({ role: 'control_room', full_name: 'Night Desk' })).user;
    const ticked = await tick(controlRoom, { guide: 'tracking', step_key: 'theft.follow' });
    expect(ticked.status).toBe(200);
    expect((await read(controlRoom, 'tracking')).body.done).toEqual(['theft.follow']);

    const team = await request(app).get('/api/guide/progress/team?guide=tracking').set(authHeader(admin));
    expect(team.body.find((p) => p.full_name === 'Night Desk')).toMatchObject({ steps_done: 1 });
  });

  it('refuses a guide it does not have', async () => {
    expect((await tick(technician, { guide: 'nonsense', step_key: 'a.b' })).status).toBe(400);
    expect((await read(technician, 'nonsense')).status).toBe(400);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const partPhotos = load('../src/services/partPhotos.js');

const app = buildApp();

// A phone that queued a write while offline sends it again when the signal
// comes back — and sends it again after that, because a request that reached
// the server and lost its reply is indistinguishable from one that never
// arrived. The whole point of these tests is that the second send changes
// nothing.
//
// Getting this wrong does not look like a bug. It looks like a job card that
// quietly grew a second oil filter, found weeks later by whoever reconciles
// the parts order.
describe.skipIf(!process.env.DATABASE_URL)('replaying a write that was queued offline', () => {
  let tech;
  let bike;
  let card;

  const addItem = (body) =>
    request(app).post(`/api/workshop/job-cards/${card}/items`).set(authHeader(tech)).send(body);

  const countItems = async () =>
    (await pgDb.query('SELECT COUNT(*)::int n FROM job_card_items WHERE job_card_id = $1', [card])).rows[0].n;

  beforeEach(async () => {
    await resetAllPgTables();
    tech = (await createPgUser({ role: 'technician' })).user;
    bike = await createPgBike({ registration: 'WS-01GP' });
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, make, model, job_type, description, status, technician_id, created_by)
       VALUES ($1,'Honda','ACE 125','service','x','open',$2,$2) RETURNING id`, [bike.id, tech.id]);
    card = rows[0].id;
  });

  it('stores one line item however many times the phone sends it', async () => {
    const body = { item_type: 'part', description: 'FILTER, OIL', quantity: 1, unit_cost: 62, client_request_id: 'req-abc-123' };

    expect((await addItem(body)).status).toBe(200);
    expect((await addItem(body)).status).toBe(200);
    expect((await addItem(body)).status).toBe(200);

    expect(await countItems()).toBe(1);
  });

  it('answers the replay with success, not an error', async () => {
    const body = { description: 'FILTER, OIL', client_request_id: 'req-abc-123' };
    await addItem(body);
    const replay = await addItem(body);
    expect(replay.status).toBe(200);
    expect(replay.body.job_card.items).toHaveLength(1);
  });

  // Without this, two genuinely different parts fitted in the same dead spot
  // would collapse into one.
  it('keeps writes that carry different ids apart', async () => {
    await addItem({ description: 'FILTER, OIL', client_request_id: 'req-1' });
    await addItem({ description: 'PAD SET, REAR BRAKE', client_request_id: 'req-2' });
    expect(await countItems()).toBe(2);
  });

  // Somebody at a desk adding the same part twice on purpose must still get
  // two lines. Only queued writes carry an id, which is why the index is
  // partial and NULLs do not collide.
  it('does not deduplicate ordinary writes that carry no id', async () => {
    await addItem({ description: 'FILTER, OIL' });
    await addItem({ description: 'FILTER, OIL' });
    expect(await countItems()).toBe(2);
  });

  it('accepts the id from a header as well as the body', async () => {
    const send = () => request(app)
      .post(`/api/workshop/job-cards/${card}/items`)
      .set(authHeader(tech))
      .set('X-Client-Request-Id', 'req-header-1')
      .send({ description: 'CHAIN, CAM' });
    await send();
    await send();
    expect(await countItems()).toBe(1);
  });

  // A replay arriving after the job was closed should be refused for being
  // late, not swallowed — the technician needs to know it did not land.
  it('still refuses a replay onto a completed job', async () => {
    await pgDb.query(`UPDATE job_cards SET status = 'completed' WHERE id = $1`, [card]);
    const res = await addItem({ description: 'FILTER, OIL', client_request_id: 'req-late' });
    expect(res.status).toBe(400);
    expect(await countItems()).toBe(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('replaying a part photograph', () => {
  let tech;

  const add = (over = {}) => partPhotos.addPhoto({
    make: 'Honda', model: 'ACE 125', partNumber: '15410-KWB-601',
    filePath: 'part-1.jpg', userId: tech.id, ...over,
  });

  const count = async () =>
    (await pgDb.query('SELECT COUNT(*)::int n FROM part_photos')).rows[0].n;

  beforeEach(async () => {
    await resetAllPgTables();
    tech = (await createPgUser({ role: 'technician' })).user;
  });

  it('stores one photograph however many times it is sent', async () => {
    await add({ clientRequestId: 'photo-req-1' });
    await add({ clientRequestId: 'photo-req-1', filePath: 'part-1-again.jpg' });
    expect(await count()).toBe(1);
  });

  // The phone should see the success it actually had, so its queue can clear.
  it('hands back the photo that is already stored', async () => {
    const first = await add({ clientRequestId: 'photo-req-1' });
    const replay = await add({ clientRequestId: 'photo-req-1', filePath: 'ignored.jpg' });
    expect(replay.id).toBe(first.id);
    expect(replay.url).toBe(first.url);
  });

  it('still stores two genuinely different photographs of the same part', async () => {
    await add({ clientRequestId: 'photo-req-1', filePath: 'a.jpg' });
    await add({ clientRequestId: 'photo-req-2', filePath: 'b.jpg' });
    expect(await count()).toBe(2);
  });

  it('leaves photos taken on a working connection alone', async () => {
    await add({ filePath: 'a.jpg' });
    await add({ filePath: 'b.jpg' });
    expect(await count()).toBe(2);
  });
});

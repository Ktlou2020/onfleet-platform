import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const { servicePlanFor } = require('../src/services/servicePlan.js');
const app = buildApp();

// The schedule the migration seeds is Hero's own: 11 services from 500 km to
// 30 500 km, repeating every 3 000 km after that, with the part to fit at each
// kilometre mark.
async function seedSchedule() {
  const services = [[1, 500, 750], [2, 3000, 3500], [3, 6000, 6500], [4, 9000, 9500], [5, 12000, 12500]];
  for (const [no, from, to] of services) {
    await pgDb.query(`INSERT INTO service_schedules (make, model, service_no, km_from, km_to)
                      VALUES ('Hero','Eco 150',$1,$2,$3) ON CONFLICT DO NOTHING`, [no, from, to]);
  }
  await pgDb.query(`INSERT INTO service_schedule_tasks (make, model, item, service_no, actions, note) VALUES
      ('Hero','Eco 150','Spark Plug',5,'R',NULL),
      ('Hero','Eco 150','Spark Plug',2,'I,C,A',NULL),
      ('Hero','Eco 150','Engine Oil**',5,'O','Replace engine oil once in every 6000 km.')
    ON CONFLICT DO NOTHING`);
  await pgDb.query(`INSERT INTO service_schedule_parts (make, model, description, part_number, at_km, qty) VALUES
      ('Hero','Eco 150','Engine oil','SPDMCYL09SEES', ARRAY[500,6500,12500]::int[], 1),
      ('Hero','Eco 150','Spark Plug','31916KRM4099S', ARRAY[12500,24500]::int[], 1),
      ('Hero','Eco 150','Brake Pads Front','K06431KTNA701S', ARRAY[12500,24500]::int[], 1),
      ('Hero','Eco 150','Chain and Sprocket kit','20K910S', ARRAY[15500,30500]::int[], 1)
    ON CONFLICT DO NOTHING`);
  await pgDb.query(`INSERT INTO parts_catalog (make, model, group_code, group_name, part_number, description, price_ex_vat, source)
    VALUES ('Hero','Eco 150','KIT','KITS','31916KRM4099S','SPARK PLUG', 45.50, 'dealer_list'),
           ('Hero','Eco 150','KIT','KITS','K06431KTNA701S','KIT, BRAKE SHOE', 115.34, 'dealer_list')
    ON CONFLICT DO NOTHING`);
}

describe.skipIf(!process.env.DATABASE_URL)('what a bike needs at its odometer reading', () => {
  beforeEach(async () => {
    await resetAllPgTables();
    await seedSchedule();
  });

  const plan = (km, bikeId = null) => servicePlanFor({ make: 'Hero', model: 'Eco 150', odometerKm: km, bikeId });

  it('works out which service the bike is at', async () => {
    expect((await plan(600)).service).toMatchObject({ service_no: 1, km_from: 500, km_to: 750 });
    expect((await plan(12400)).service).toMatchObject({ service_no: 5 });
  });

  it('lists what the manufacturer says to do at that service, in plain words', async () => {
    const p = await plan(12400);
    const spark = p.tasks.find((t) => t.item === 'Spark Plug');
    expect(spark).toMatchObject({ actions: 'R', actions_text: 'Replace', replaces: true });
    expect(p.tasks.find((t) => t.item === 'Engine Oil**').actions_text).toBe('Oil change');
  });

  it('lists the parts due now, with prices from the dealer list', async () => {
    const p = await plan(12500);
    expect(p.parts_due.map((x) => x.part_number).sort())
      .toEqual(['31916KRM4099S', 'K06431KTNA701S', 'SPDMCYL09SEES']);
    const spark = p.parts_due.find((x) => x.part_number === '31916KRM4099S');
    expect(spark).toMatchObject({ price_ex_vat: 45.5, in_catalogue: true });
    // Engine oil isn't in the dealer list, and says so rather than pretending
    expect(p.parts_due.find((x) => x.part_number === 'SPDMCYL09SEES').in_catalogue).toBe(false);
    expect(p.parts_due_total_ex_vat).toBe(160.84); // 45.50 + 115.34
  });

  // The chart gives each service a 500 km window; a bike booked in at 12 200
  // is the same service as one at 12 500.
  it('treats a reading near the mark as that service', async () => {
    expect((await plan(12200)).parts_due.map((x) => x.part_number)).toContain('31916KRM4099S');
    expect((await plan(11000)).parts_due.map((x) => x.part_number)).not.toContain('31916KRM4099S');
  });

  it('flags what is close enough to do while the bike is on the ramp', async () => {
    const p = await plan(14500);
    expect(p.parts_due).toHaveLength(0);
    expect(p.parts_soon.map((x) => x.part_number)).toEqual(['20K910S']);
    expect(p.parts_soon[0].km_until).toBe(1000);
  });

  it('does not recommend a part that was just fitted', async () => {
    const bike = await createPgBike({ make: 'Hero', model: 'Eco 150' });
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, job_type, status, odometer_km, completed_at, created_at)
       VALUES ($1,'service','completed',12400, NOW(), NOW()) RETURNING id`, [bike.id]);
    await pgDb.query(
      `INSERT INTO job_card_items (job_card_id, item_type, description, quantity, unit_cost, part_number)
       VALUES ($1,'part','SPARK PLUG',1,45.50,'31916KRM4099S')`, [rows[0].id]);

    const p = await plan(12500, bike.id);
    expect(p.parts_due.map((x) => x.part_number)).not.toContain('31916KRM4099S');
    expect(p.parts_due.map((x) => x.part_number)).toContain('K06431KTNA701S');
  });

  it('keeps going past the published chart, repeating its pattern', async () => {
    const p = await plan(16000); // past the 5 seeded services
    expect(p.service.service_no).toBeGreaterThan(5);
    expect(p.service.repeat_of).toBeTruthy();
  });

  it('says plainly when a model has no schedule', async () => {
    const p = await servicePlanFor({ make: 'Honda', model: 'Ace 125', odometerKm: 5000 });
    expect(p).toMatchObject({ has_schedule: false, tasks: [], parts_due: [] });
  });

  it('refuses a reading that is not a number', async () => {
    expect((await servicePlanFor({ make: 'Hero', model: 'Eco 150', odometerKm: 'abc' })).error).toMatch(/kilometres/i);
  });

  describe('from the workshop', () => {
    it('plans from the bike, using the odometer the trackers keep', async () => {
      const workshop = (await createPgUser({ role: 'technician' })).user;
      const bike = await createPgBike({ make: 'Hero', model: 'Eco 150', registration: 'LW78MDGP' });
      await pgDb.query('UPDATE bikes SET odometer_km = 12500 WHERE id = $1', [bike.id]);
      const res = await request(app).get(`/api/workshop/service-plan?bike_id=${bike.id}`).set(authHeader(workshop));
      expect(res.status).toBe(200);
      expect(res.body.odometer_km).toBe(12500);
      expect(res.body.parts_due.length).toBeGreaterThan(0);
    });

    it('re-plans for the reading the technician actually types in', async () => {
      const workshop = (await createPgUser({ role: 'technician' })).user;
      const bike = await createPgBike({ make: 'Hero', model: 'Eco 150' });
      await pgDb.query('UPDATE bikes SET odometer_km = 4000 WHERE id = $1', [bike.id]);
      const res = await request(app).get(`/api/workshop/service-plan?bike_id=${bike.id}&odometer_km=12500`).set(authHeader(workshop));
      expect(res.body.odometer_km).toBe(12500);
      expect(res.body.service.service_no).toBe(5);
    });
  });
});

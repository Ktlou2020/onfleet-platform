import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike, createPgUser, createPgAgreement, createPgOrg } from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const { bikesDueForService, describe: describeDue } = require('../src/services/serviceDue.js');

const daysAgo = (d) => new Date(Date.now() - d * 86400000);
const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function bikeWith({ odometer, nextKm, nextDate = null, status = 'active', org = null }) {
  const bike = await createPgBike({ status });
  await pgDb.query(
    'UPDATE bikes SET odometer_km=$1, next_service_km=$2, next_service_date=$3, organization_id=$4 WHERE id=$5',
    [odometer, nextKm, nextDate, org, bike.id]);
  return bike;
}
async function ridesOf(bikeId, kmPerDay, days = 14) {
  for (let i = 0; i < days; i += 1) {
    await pgDb.query(
      `INSERT INTO trips (bike_id, started_at, ended_at, distance_km, duration_sec) VALUES ($1,$2,$3,$4,3600)`,
      [bikeId, daysAgo(i), daysAgo(i), kmPerDay]);
  }
}

// Servicing was driven by next_service_date alone, while next_service_km sat
// unused — so a bike doing 90 km a day was serviced weeks late.
describe.skipIf(!process.env.DATABASE_URL)('when a bike is due for service', () => {
  beforeEach(resetAllPgTables);

  it('flags a bike that has passed its service distance, whatever its date says', async () => {
    const bike = await bikeWith({ odometer: 9200, nextKm: 9000, nextDate: isoIn(60) });
    const [due] = await bikesDueForService();
    expect(due.id).toBe(bike.id);
    expect(due).toMatchObject({ state: 'overdue', km_remaining: -200, reason: 'distance' });
  });

  it('flags a bike closing on its service distance before it gets there', async () => {
    await bikeWith({ odometer: 8800, nextKm: 9000, nextDate: isoIn(60) });
    const [due] = await bikesDueForService();
    expect(due).toMatchObject({ state: 'due_soon', km_remaining: 200 });
  });

  it('leaves a bike with plenty of road and time alone', async () => {
    await bikeWith({ odometer: 5000, nextKm: 9000, nextDate: isoIn(60) });
    expect(await bikesDueForService()).toHaveLength(0);
  });

  it('still flags a bike by date when no distance is set', async () => {
    await bikeWith({ odometer: null, nextKm: null, nextDate: isoIn(3) });
    const [due] = await bikesDueForService();
    expect(due).toMatchObject({ state: 'due_soon', reason: 'date', km_remaining: null });
  });

  it('predicts the service date from how hard the bike is actually ridden', async () => {
    const bike = await bikeWith({ odometer: 8700, nextKm: 9000, nextDate: isoIn(90) });
    await ridesOf(bike.id, 30); // 30 km a day for a fortnight
    const [due] = await bikesDueForService();
    expect(due.km_per_day).toBe(30);
    expect(due.days_to_service_km).toBe(10); // 300 km left at 30 km/day
    expect(due.projected_service_date).toBe(isoIn(10));
    expect(describeDue(due)).toMatch(/300 km to go/);
    expect(describeDue(due)).toMatch(/30 km\/day/);
  });

  it('invents no date for a bike that is standing still', async () => {
    const bike = await bikeWith({ odometer: 8900, nextKm: 9000, nextDate: isoIn(60) });
    await ridesOf(bike.id, 0.1, 2);
    const [due] = await bikesDueForService();
    expect(due.days_to_service_km).toBeNull();
    expect(due.projected_service_date).toBeNull();
  });

  it('ignores bikes that are sold, written off or stolen', async () => {
    for (const status of ['sold', 'written_off', 'stolen']) {
      await bikeWith({ odometer: 9500, nextKm: 9000, status });
    }
    expect(await bikesDueForService()).toHaveLength(0);
  });

  it('puts the overdue bikes first', async () => {
    await bikeWith({ odometer: 8900, nextKm: 9000 });   // due soon
    const late = await bikeWith({ odometer: 9600, nextKm: 9000 }); // overdue
    const due = await bikesDueForService();
    expect(due.map((b) => b.id)[0]).toBe(late.id);
  });

  it('names the rider on the bike, so a reminder can reach them', async () => {
    const rider = (await createPgUser({ role: 'rider', full_name: 'Thandi M', phone: '0821234567' })).user;
    const bike = await bikeWith({ odometer: 9100, nextKm: 9000 });
    await createPgAgreement({ bike_id: bike.id, user_id: rider.id, status: 'active' });
    const [due] = await bikesDueForService();
    expect(due).toMatchObject({ rider_id: rider.id, rider_name: 'Thandi M', rider_phone: '0821234567' });
  });

  it('can be narrowed to one fleet owner, or to OnFleet\'s own bikes', async () => {
    const orgId = (await createPgOrg({ name: 'Acme Deliveries' })).id;
    const orgBike = await bikeWith({ odometer: 9100, nextKm: 9000, org: orgId });
    const ownBike = await bikeWith({ odometer: 9100, nextKm: 9000 });
    expect((await bikesDueForService({ organizationId: orgId })).map((b) => b.id)).toEqual([orgBike.id]);
    expect((await bikesDueForService({ ownFleetOnly: true })).map((b) => b.id)).toEqual([ownBike.id]);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAlert, authHeader } from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const theftCases = require('../src/services/theftCaseService.js');
const app = buildApp();

// 85 bikes are marked stolen and the platform could not say how many were
// recovered, because a theft was only ever a row in the alerts list.
describe.skipIf(!process.env.DATABASE_URL)('theft cases', () => {
  let admin;
  let bike;
  const cases = async () => (await pgDb.query('SELECT * FROM theft_cases ORDER BY id')).rows;
  const events = async (caseId) => (await pgDb.query('SELECT * FROM theft_case_events WHERE case_id=$1 ORDER BY id', [caseId])).rows;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    bike = await createPgBike({ registration: 'LW78MDGP' });
  });

  describe('opening', () => {
    it('opens itself on an alert that means a bike may be being taken', async () => {
      const alert = await createPgAlert({ bike_id: bike.id, alert_type: 'tamper' });
      await theftCases.onAlert(alert);
      const [opened] = await cases();
      expect(opened).toMatchObject({ bike_id: bike.id, status: 'open', trigger_alert_id: alert.id });
      expect(opened.opened_by).toBeNull(); // automatic
      expect(opened.follow_until).toBeTruthy();
      expect((await events(opened.id))[0]).toMatchObject({ kind: 'opened' });
    });

    it('does not open on everyday alerts', async () => {
      for (const type of ['idle', 'low_battery', 'long_trip', 'geofence_enter']) {
        await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: type }));
      }
      expect(await cases()).toHaveLength(0);
    });

    it('treats a burst of alerts as one theft, and adds them to the story', async () => {
      await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: 'tamper' }));
      await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: 'movement' }));
      await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: 'towing' }));
      const all = await cases();
      expect(all).toHaveLength(1);
      expect((await events(all[0].id)).filter((e) => e.kind === 'alert')).toHaveLength(2);
    });

    it('adds unrelated alerts on that bike to the open case too', async () => {
      await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: 'tamper' }));
      await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: 'idle' }));
      const [theftCase] = await cases();
      expect((await events(theftCase.id)).some((e) => e.summary === 'idle')).toBe(true);
    });

    it('opens on a critical theft-risk score but not a lesser one', async () => {
      const low = await createPgAlert({ bike_id: bike.id, alert_type: 'theft_risk', payload: { level: 'high' } });
      await theftCases.onAlert(low);
      expect(await cases()).toHaveLength(0);
      const critical = await createPgAlert({ bike_id: bike.id, alert_type: 'theft_risk', payload: { level: 'critical' } });
      await theftCases.onAlert(critical);
      expect(await cases()).toHaveLength(1);
    });

    it('opens a fresh case once the previous one is closed', async () => {
      await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: 'tamper' }));
      const [first] = await cases();
      await theftCases.closeCase({ caseId: first.id, status: 'false_alarm', actorId: admin.id });
      await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: 'tamper' }));
      expect(await cases()).toHaveLength(2);
    });
  });

  describe('working the case', () => {
    let openCase;
    beforeEach(async () => {
      await theftCases.onAlert(await createPgAlert({ bike_id: bike.id, alert_type: 'tamper' }));
      [openCase] = await cases();
    });

    it('records notes, police handover and recovery, in order', async () => {
      const auth = authHeader(admin);
      await request(app).post(`/api/tracking/theft-cases/${openCase.id}/notes`).set(auth).send({ note: 'Rider says it was taken outside Pick n Pay' });
      await request(app).put(`/api/tracking/theft-cases/${openCase.id}/status`).set(auth).send({ status: 'with_police', police_reference: 'CAS 123/09/2026' });
      const closed = await request(app).put(`/api/tracking/theft-cases/${openCase.id}/status`).set(auth)
        .send({ status: 'recovered', note: 'Found in Alexandra, rider has it back' });
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ status: 'recovered', police_reference: 'CAS 123/09/2026' });
      expect(closed.body.closed_by).toBe(admin.id);
      expect((await events(openCase.id)).map((e) => e.kind)).toEqual(['opened', 'note', 'status', 'closed']);
    });

    it('will not reopen or re-close a closed case', async () => {
      await theftCases.closeCase({ caseId: openCase.id, status: 'recovered', actorId: admin.id });
      const res = await request(app).put(`/api/tracking/theft-cases/${openCase.id}/status`).set(authHeader(admin)).send({ status: 'false_alarm' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT status FROM theft_cases WHERE id=$1', [openCase.id]);
      expect(rows[0].status).toBe('recovered');
    });

    it('refuses a status that is not a real outcome', async () => {
      const res = await request(app).put(`/api/tracking/theft-cases/${openCase.id}/status`).set(authHeader(admin)).send({ status: 'sold_for_parts' });
      expect(res.status).toBe(400);
    });

    it('stops and restarts the live follow', async () => {
      const stopped = await request(app).delete(`/api/tracking/theft-cases/${openCase.id}/follow`).set(authHeader(admin));
      expect(stopped.body.follow_until).toBeNull();
      const again = await request(app).post(`/api/tracking/theft-cases/${openCase.id}/follow`).set(authHeader(admin)).send({ minutes: 30 });
      expect(new Date(again.body.follow_until).getTime()).toBeGreaterThan(Date.now());
    });

    it('follows only open cases with a tracker, inside their window', async () => {
      // A bike with no tracker can't be followed at all
      expect(await theftCases.casesToFollow()).toHaveLength(0);

      await pgDb.query(
        `INSERT INTO tracking_devices (imei, model, bike_id) VALUES ('353201352317926','FMB920',$1)`, [bike.id]);
      expect((await theftCases.casesToFollow()).map((r) => r.imei)).toEqual(['353201352317926']);

      // Past its window: following costs SIM data, so it stops on its own
      await pgDb.query("UPDATE theft_cases SET follow_until = NOW() - INTERVAL '1 minute' WHERE id=$1", [openCase.id]);
      expect(await theftCases.casesToFollow()).toHaveLength(0);

      // Back inside the window, but closed: nothing is followed
      await pgDb.query("UPDATE theft_cases SET follow_until = NOW() + INTERVAL '10 minutes' WHERE id=$1", [openCase.id]);
      expect(await theftCases.casesToFollow()).toHaveLength(1);
      await theftCases.closeCase({ caseId: openCase.id, status: 'recovered', actorId: admin.id });
      expect(await theftCases.casesToFollow()).toHaveLength(0);
    });

    it('attaches to the case already open instead of starting a second one', async () => {
      const again = await theftCases.openCase({ bikeId: bike.id, reason: 'Someone reported it stolen', actorId: admin.id });
      expect(again.created).toBe(false);
      expect(again.theftCase.id).toBe(openCase.id);
      expect(await cases()).toHaveLength(1);
    });

    it('refuses to close a case as something that is not an outcome', async () => {
      await expect(theftCases.closeCase({ caseId: openCase.id, status: 'open', actorId: admin.id })).rejects.toThrow(/cannot close/i);
      await expect(theftCases.setStatus({ caseId: openCase.id, status: 'recovered', actorId: admin.id })).rejects.toThrow(/not a status/i);
    });

    it('shows the case with its timeline and the pings since it opened', async () => {
      await pgDb.query(
        `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at) VALUES ($1, -26.2, 28.0, 60, NOW())`, [bike.id]);
      const res = await request(app).get(`/api/tracking/theft-cases/${openCase.id}`).set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.case).toMatchObject({ registration: 'LW78MDGP', status: 'open' });
      expect(res.body.events.length).toBeGreaterThan(0);
      expect(res.body.pings).toHaveLength(1);
      expect(res.body.alerts.length).toBeGreaterThan(0);
    });
  });

  describe('recovery rate', () => {
    it('counts recoveries against genuine thefts, ignoring false alarms', async () => {
      const bikes = [bike, await createPgBike(), await createPgBike(), await createPgBike()];
      const outcomes = ['recovered', 'recovered', 'written_off', 'false_alarm'];
      for (const [i, b] of bikes.entries()) {
        const { theftCase } = await theftCases.openCase({ bikeId: b.id, reason: 'test' });
        await theftCases.closeCase({ caseId: theftCase.id, status: outcomes[i], actorId: admin.id });
      }
      const res = await request(app).get('/api/tracking/theft-cases/stats').set(authHeader(admin));
      expect(res.body).toMatchObject({ total: 4, open: 0, recovered: 2, written_off: 1, false_alarms: 1 });
      expect(res.body.recovery_rate_pct).toBe(67); // 2 of 3 genuine thefts
    });
  });
});

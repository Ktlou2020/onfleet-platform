import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// A fleet working its own theft cases and insurance claims.
//
// These were the platform operator's to run and a fleet could only watch,
// which is the wrong way round: the bike is theirs, and they are the ones
// holding the police reference and the insurer's letter.
//
// Everything here scopes through the bike, because the bike is the only thing
// a case or a claim is attached to. The tests that matter most are the ones
// where a fleet reaches for a case that is not theirs.

// Weeks laid out from today, the shape buildPaymentSchedule produces, so the
// waiving and restoring have something real to act on.
async function buildSchedule(agreementId, weeks, weekly) {
  for (let i = 0; i < weeks; i += 1) {
    await pgDb.query(
      `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due)
       VALUES ($1,$2, CURRENT_DATE + ($3 || ' days')::interval, $4)`,
      [agreementId, i + 1, String(i * 7), weekly]);
  }
}

describe.skipIf(!process.env.DATABASE_URL)('a fleet working its own theft cases', () => {
  let rapid, kasi, rapidOwner, kasiOwner, viewer, rapidBike, kasiBike, rider;

  const report = (user, body) =>
    request(app).post('/api/fleet/theft-cases').set(authHeader(user)).send(body);
  const setStatus = (user, id, body) =>
    request(app).put(`/api/fleet/theft-cases/${id}/status`).set(authHeader(user)).send(body);
  const note = (user, id, body) =>
    request(app).post(`/api/fleet/theft-cases/${id}/notes`).set(authHeader(user)).send(body);

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    rapidOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: rapid.id });
    kasiOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: kasi.id });
    viewer = await createPgUser({ role: 'fleet_owner_viewer', organization_id: rapid.id });
    rider = await createPgUser({ role: 'rider', organization_id: rapid.id });

    rapidBike = await createPgBike({ registration: 'RAP001GP', organization_id: rapid.id });
    kasiBike = await createPgBike({ registration: 'KAS001GP', organization_id: kasi.id });
  });

  describe('reporting one', () => {
    it('opens a case on its own bike', async () => {
      const res = await report(rapidOwner.user, { bike_id: rapidBike.id, reason: 'Taken from outside the depot' });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.case).toMatchObject({ bike_id: rapidBike.id, status: 'open' });

      const { rows } = await pgDb.query(
        `SELECT kind, summary FROM theft_case_events WHERE case_id = $1`, [res.body.case.id]);
      expect(rows[0]).toMatchObject({ kind: 'opened', summary: 'Taken from outside the depot' });
    });

    // Reporting a theft twice is what a worried person does, and the database
    // allows one open case per bike. The second report joins the first.
    it('and reporting it again joins the case already open', async () => {
      const first = await report(rapidOwner.user, { bike_id: rapidBike.id, reason: 'Gone' });
      const second = await report(rapidOwner.user, { bike_id: rapidBike.id, reason: 'Still gone' });
      expect(second.status).toBe(200);
      expect(second.body.created).toBe(false);
      expect(second.body.case.id).toBe(first.body.case.id);

      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM theft_cases WHERE bike_id = $1', [rapidBike.id]);
      expect(rows[0].n).toBe(1);
    });

    it('not on another fleet\'s bike', async () => {
      const res = await report(rapidOwner.user, { bike_id: kasiBike.id, reason: 'Mine now' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM theft_cases');
      expect(rows[0].n, 'a case was opened on another fleet\'s bike').toBe(0);
    });

    it('and says so when no reason is given', async () => {
      const res = await report(rapidOwner.user, { bike_id: rapidBike.id, reason: '' });
      expect(res.status).toBe(400);
    });

    it('a viewer may not report one', async () => {
      const res = await report(viewer.user, { bike_id: rapidBike.id, reason: 'Gone' });
      expect(res.status).toBe(403);
    });

    it('and it is written to the audit log', async () => {
      await report(rapidOwner.user, { bike_id: rapidBike.id, reason: 'Gone' });
      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'fleet_owner.theft_case_open'`);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].metadata).organization_id).toBe(rapid.id);
    });
  });

  describe('working it', () => {
    let caseId;

    beforeEach(async () => {
      const res = await report(rapidOwner.user, { bike_id: rapidBike.id, reason: 'Taken overnight' });
      caseId = res.body.case.id;
    });

    it('marks it with the police, and keeps the reference', async () => {
      const res = await setStatus(rapidOwner.user, caseId, { status: 'with_police', police_reference: 'CAS 114/09/2026' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'with_police', police_reference: 'CAS 114/09/2026' });
    });

    it('closes it as recovered, with the note and the follow switched off', async () => {
      const res = await setStatus(rapidOwner.user, caseId, { status: 'recovered', note: 'Found in Katlehong, rider unhurt' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('recovered');
      expect(res.body.closed_at).toBeTruthy();
      expect(res.body.closing_note).toBe('Found in Katlehong, rider unhurt');
      expect(res.body.follow_until, 'a closed case is still being followed').toBeNull();
    });

    it('a closed case cannot be reopened through the same door', async () => {
      await setStatus(rapidOwner.user, caseId, { status: 'written_off' });
      const res = await setStatus(rapidOwner.user, caseId, { status: 'open' });
      expect(res.status).toBe(409);
      const { rows } = await pgDb.query('SELECT status FROM theft_cases WHERE id = $1', [caseId]);
      expect(rows[0].status).toBe('written_off');
    });

    it('refuses a status that is not one', async () => {
      const res = await setStatus(rapidOwner.user, caseId, { status: 'probably_fine' });
      expect(res.status).toBe(400);
    });

    it('adds a note to the story', async () => {
      const res = await note(rapidOwner.user, caseId, { note: 'Spoke to the rider, last seen 21:40' });
      expect(res.status).toBe(201);
      const { rows } = await pgDb.query(
        `SELECT summary FROM theft_case_events WHERE case_id = $1 AND kind = 'note'`, [caseId]);
      expect(rows[0].summary).toBe('Spoke to the rider, last seen 21:40');
    });

    it('and reads the whole story back', async () => {
      await setStatus(rapidOwner.user, caseId, { status: 'with_police', police_reference: 'CAS 1/1/2026' });
      await note(rapidOwner.user, caseId, { note: 'Statement taken' });
      const res = await request(app).get(`/api/fleet/theft-cases/${caseId}`).set(authHeader(rapidOwner.user));
      expect(res.status).toBe(200);
      expect(res.body.events.map((e) => e.kind)).toEqual(['opened', 'status', 'note']);
    });
  });

  // Closing a case and the bike it is about are one thing, not two.
  //
  // Before this, a fleet could close a case as "gone for good" and the rider
  // would carry on being billed every week for a bike that no longer existed,
  // because the bike's own screen was the only place that knew.
  describe('what closing it does to the bike', () => {
    let caseId, agreement;

    beforeEach(async () => {
      agreement = await createPgAgreement({
        bike_id: rapidBike.id, user_id: rider.user.id, status: 'active',
        weekly_amount: 850, total_weeks: 8,
      });
      await buildSchedule(agreement.id, 8, 850);
      await pgDb.query(`UPDATE bikes SET status='active' WHERE id=$1`, [rapidBike.id]);
      const res = await report(rapidOwner.user, { bike_id: rapidBike.id, reason: 'Taken overnight' });
      caseId = res.body.case.id;
    });

    describe('gone for good', () => {
      it('marks the bike stolen and stops the agreement', async () => {
        const res = await setStatus(rapidOwner.user, caseId, { status: 'written_off' });
        expect(res.status).toBe(200);
        expect(res.body.effects).toMatchObject({
          bike_status: 'stolen',
          discontinued_agreement_id: agreement.id,
          discontinued_agreement_no: agreement.agreement_no,
        });

        const { rows: bike } = await pgDb.query('SELECT status FROM bikes WHERE id=$1', [rapidBike.id]);
        expect(bike[0].status).toBe('stolen');
        const { rows: agr } = await pgDb.query(
          'SELECT status, discontinued_reason FROM agreements WHERE id=$1', [agreement.id]);
        expect(agr[0]).toMatchObject({ status: 'discontinued', discontinued_reason: 'bike_stolen' });
      });

      // The point of the whole thing: nobody is billed for a bike that is gone.
      it('and waives the weeks still to come', async () => {
        const res = await setStatus(rapidOwner.user, caseId, { status: 'written_off' });
        expect(res.body.effects.waived_weeks).toBeGreaterThan(0);
        const { rows } = await pgDb.query(
          `SELECT COUNT(*)::int n FROM payment_schedules
            WHERE agreement_id = $1 AND due_date >= CURRENT_DATE AND status <> 'waived'`, [agreement.id]);
        expect(rows[0].n, 'a rider is still being billed for a bike that is gone').toBe(0);
      });

      it('writes what it did onto the case', async () => {
        await setStatus(rapidOwner.user, caseId, { status: 'written_off' });
        const { rows } = await pgDb.query(
          `SELECT summary FROM theft_case_events WHERE case_id = $1 AND kind = 'bike'`, [caseId]);
        expect(rows[0].summary).toMatch(new RegExp(`${agreement.agreement_no} discontinued`));
      });

      it('and copes with a bike nobody was riding', async () => {
        await pgDb.query(`UPDATE agreements SET status='completed' WHERE id=$1`, [agreement.id]);
        const res = await setStatus(rapidOwner.user, caseId, { status: 'written_off' });
        expect(res.status).toBe(200);
        expect(res.body.effects).toMatchObject({ bike_status: 'stolen', discontinued_agreement_id: null });
      });
    });

    describe('recovered', () => {
      // A case that went all the way to written off and then the bike turns
      // up. Both halves have to come back, or the rider is off the hook for a
      // bike they have back.
      beforeEach(async () => {
        await setStatus(rapidOwner.user, caseId, { status: 'written_off' });
        const res = await report(rapidOwner.user, { bike_id: rapidBike.id, reason: 'Found, closing properly' });
        caseId = res.body.case.id;
      });

      it('puts the bike back and the agreement with it', async () => {
        const res = await setStatus(rapidOwner.user, caseId, { status: 'recovered', note: 'Found in Katlehong' });
        expect(res.status).toBe(200);
        expect(res.body.effects).toMatchObject({
          bike_status: 'active', reinstated_agreement_no: agreement.agreement_no,
        });

        const { rows: agr } = await pgDb.query('SELECT status FROM agreements WHERE id=$1', [agreement.id]);
        expect(agr[0].status).toBe('active');
        const { rows: sched } = await pgDb.query(
          `SELECT COUNT(*)::int n FROM payment_schedules
            WHERE agreement_id = $1 AND due_date >= CURRENT_DATE AND status = 'waived'`, [agreement.id]);
        expect(sched[0].n, 'the weeks stayed waived on a bike that came back').toBe(0);
      });

      it('or leaves the agreement alone when told to', async () => {
        const res = await setStatus(rapidOwner.user, caseId, { status: 'recovered', reinstate: false });
        expect(res.body.effects.bike_status).toBe('ready_to_go');
        expect(res.body.effects.reinstate_skipped).toBeTruthy();
        const { rows } = await pgDb.query('SELECT status FROM agreements WHERE id=$1', [agreement.id]);
        expect(rows[0].status).toBe('discontinued');
      });

      // While the bike was gone the rider was put on another one. Reinstating
      // would leave them on two agreements at once, which is worse than the
      // problem being fixed.
      it('and will not put a rider on two agreements at once', async () => {
        const spare = await createPgBike({ registration: 'RAP009GP', organization_id: rapid.id, status: 'active' });
        const replacement = await createPgAgreement({ bike_id: spare.id, user_id: rider.user.id, status: 'active' });

        const res = await setStatus(rapidOwner.user, caseId, { status: 'recovered' });
        expect(res.body.effects.reinstate_skipped).toMatch(new RegExp(replacement.agreement_no));
        const { rows } = await pgDb.query(
          `SELECT COUNT(*)::int n FROM agreements WHERE user_id = $1 AND status = 'active'`, [rider.user.id]);
        expect(rows[0].n, 'the rider ended up on two agreements').toBe(1);
      });

      it('a false alarm undoes it the same way', async () => {
        const res = await setStatus(rapidOwner.user, caseId, { status: 'false_alarm' });
        expect(res.body.effects.reinstated_agreement_no).toBe(agreement.agreement_no);
      });
    });

    // A case that never touched the bike must not touch it on the way out.
    it('recovering a bike that was never marked stolen changes nothing', async () => {
      const res = await setStatus(rapidOwner.user, caseId, { status: 'recovered' });
      expect(res.body.effects).toEqual({});
      const { rows } = await pgDb.query('SELECT status FROM bikes WHERE id=$1', [rapidBike.id]);
      expect(rows[0].status).toBe('active');
    });

    it('and the case detail says in advance what closing will cost', async () => {
      const res = await request(app).get(`/api/fleet/theft-cases/${caseId}`).set(authHeader(rapidOwner.user));
      expect(res.body.bike).toMatchObject({ registration: 'RAP001GP', status: 'active' });
      expect(res.body.bike.agreement).toMatchObject({ agreement_no: agreement.agreement_no });
      expect(res.body.bike.agreement.unpaid_weeks).toBeGreaterThan(0);
    });
  });

  describe('another fleet\'s case', () => {
    let kasiCase;

    beforeEach(async () => {
      const res = await report(kasiOwner.user, { bike_id: kasiBike.id, reason: 'Taken from the rank' });
      kasiCase = res.body.case.id;
    });

    it('cannot be read', async () => {
      const res = await request(app).get(`/api/fleet/theft-cases/${kasiCase}`).set(authHeader(rapidOwner.user));
      expect(res.status).toBe(404);
    });

    it('cannot be closed', async () => {
      const res = await setStatus(rapidOwner.user, kasiCase, { status: 'false_alarm' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT status FROM theft_cases WHERE id = $1', [kasiCase]);
      expect(rows[0].status, 'another fleet\'s case was closed').toBe('open');
    });

    it('cannot be written on', async () => {
      const res = await note(rapidOwner.user, kasiCase, { note: 'Nothing to see here' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query(
        `SELECT COUNT(*)::int n FROM theft_case_events WHERE case_id = $1 AND kind = 'note'`, [kasiCase]);
      expect(rows[0].n).toBe(0);
    });

    it('and does not show up in the list', async () => {
      const res = await request(app).get('/api/fleet/theft-cases').set(authHeader(rapidOwner.user));
      expect(res.body.theft_cases.map((c) => c.id)).not.toContain(kasiCase);
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('a fleet filing its own claims', () => {
  let rapid, kasi, rapidOwner, kasiOwner, viewer, rapidBike, kasiBike, rider;

  const file = (user, body) =>
    request(app).post('/api/fleet/claims').set(authHeader(user)).send(body);
  const update = (user, id, body) =>
    request(app).put(`/api/fleet/claims/${id}`).set(authHeader(user)).send(body);

  const A_CLAIM = { claim_type: 'theft', description: 'Taken from outside the depot', incident_date: '2026-09-20' };

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    rapidOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: rapid.id });
    kasiOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: kasi.id });
    viewer = await createPgUser({ role: 'fleet_owner_viewer', organization_id: rapid.id });
    rider = await createPgUser({ role: 'rider', organization_id: rapid.id });

    rapidBike = await createPgBike({ registration: 'RAP001GP', organization_id: rapid.id });
    kasiBike = await createPgBike({ registration: 'KAS001GP', organization_id: kasi.id });
  });

  describe('filing one', () => {
    it('files it against its own bike', async () => {
      const res = await file(rapidOwner.user, { bike_id: rapidBike.id, ...A_CLAIM });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        bike_id: rapidBike.id, claim_type: 'theft', status: 'filed', filed_by: rapidOwner.user.id,
      });
    });

    // A claim and the money still owed on that bike are read together later,
    // so the agreement it was on is caught at the time rather than guessed at.
    it('and catches the agreement the bike was on', async () => {
      const agreement = await createPgAgreement({ bike_id: rapidBike.id, user_id: rider.user.id, status: 'active' });
      const res = await file(rapidOwner.user, { bike_id: rapidBike.id, ...A_CLAIM });
      expect(res.body.agreement_id).toBe(agreement.id);
    });

    it('not against another fleet\'s bike', async () => {
      const res = await file(rapidOwner.user, { bike_id: kasiBike.id, ...A_CLAIM });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM insurance_claims');
      expect(rows[0].n).toBe(0);
    });

    it('refuses a kind of claim that is not one', async () => {
      const res = await file(rapidOwner.user, { bike_id: rapidBike.id, ...A_CLAIM, claim_type: 'sadness' });
      expect(res.status).toBe(400);
    });

    it('refuses one with nothing written on it', async () => {
      const res = await file(rapidOwner.user, { bike_id: rapidBike.id, claim_type: 'damage', description: '' });
      expect(res.status).toBe(400);
    });

    it('a viewer may not file one', async () => {
      expect((await file(viewer.user, { bike_id: rapidBike.id, ...A_CLAIM })).status).toBe(403);
    });
  });

  describe('recording what the insurer said', () => {
    let claimId;

    beforeEach(async () => {
      const res = await file(rapidOwner.user, { bike_id: rapidBike.id, ...A_CLAIM });
      claimId = res.body.id;
    });

    it('approved, with the amount', async () => {
      const res = await update(rapidOwner.user, claimId, { status: 'approved', payout_amount: 24500 });
      expect(res.status).toBe(200);
      expect(Number(res.body.payout_amount)).toBe(24500);
      expect(res.body.resolved_at, 'a decided claim has no date on it').toBeTruthy();
    });

    it('paid, once the money has arrived', async () => {
      await update(rapidOwner.user, claimId, { status: 'approved', payout_amount: 24500 });
      const res = await update(rapidOwner.user, claimId, { status: 'paid', payout_amount: 24500 });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('paid');
    });

    // "Paid" with no amount is a word, not a record. A year later, when
    // somebody is reconciling the bike against the insurer, it says nothing.
    it('but not paid without an amount', async () => {
      const res = await update(rapidOwner.user, claimId, { status: 'paid' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/needs the amount/);
      const { rows } = await pgDb.query('SELECT status FROM insurance_claims WHERE id = $1', [claimId]);
      expect(rows[0].status).toBe('filed');
    });

    it('nor a payout on a claim nobody has approved', async () => {
      const res = await update(rapidOwner.user, claimId, { status: 'investigating', payout_amount: 24500 });
      expect(res.status).toBe(400);
      const { rows } = await pgDb.query('SELECT payout_amount FROM insurance_claims WHERE id = $1', [claimId]);
      expect(rows[0].payout_amount).toBeNull();
    });

    it('rejected, which resolves it and pays nothing', async () => {
      const res = await update(rapidOwner.user, claimId, { status: 'rejected', notes: 'Tracker was disconnected' });
      expect(res.status).toBe(200);
      expect(res.body.payout_amount).toBeNull();
      expect(res.body.resolved_at).toBeTruthy();
      expect(res.body.notes).toBe('Tracker was disconnected');
    });

    it('and an insurer changing their mind is allowed', async () => {
      await update(rapidOwner.user, claimId, { status: 'rejected' });
      const res = await update(rapidOwner.user, claimId, { status: 'approved', payout_amount: 19000 });
      expect(res.status).toBe(200);
      expect(Number(res.body.payout_amount)).toBe(19000);
    });

    // A file somebody has finished with must not be quietly rewritten.
    it('a closed claim stays closed', async () => {
      await update(rapidOwner.user, claimId, { status: 'closed' });
      const res = await update(rapidOwner.user, claimId, { status: 'approved', payout_amount: 50000 });
      expect(res.status).toBe(409);
      const { rows } = await pgDb.query('SELECT status, payout_amount FROM insurance_claims WHERE id = $1', [claimId]);
      expect(rows[0]).toMatchObject({ status: 'closed', payout_amount: null });
    });

    it('refuses a status that is not one', async () => {
      expect((await update(rapidOwner.user, claimId, { status: 'nearly' })).status).toBe(400);
    });

    it('a viewer may not record anything', async () => {
      const res = await update(viewer.user, claimId, { status: 'approved', payout_amount: 100 });
      expect(res.status).toBe(403);
    });

    it('and it is written to the audit log', async () => {
      await update(rapidOwner.user, claimId, { status: 'approved', payout_amount: 24500 });
      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'fleet_owner.claim_update'`);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].metadata).payout_amount).toBe(24500);
    });
  });

  describe('another fleet\'s claim', () => {
    let kasiClaim;

    beforeEach(async () => {
      const res = await file(kasiOwner.user, { bike_id: kasiBike.id, ...A_CLAIM });
      kasiClaim = res.body.id;
    });

    it('cannot be decided', async () => {
      const res = await update(rapidOwner.user, kasiClaim, { status: 'rejected' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT status FROM insurance_claims WHERE id = $1', [kasiClaim]);
      expect(rows[0].status, 'another fleet\'s claim was decided').toBe('filed');
    });

    it('and does not show up in the list', async () => {
      const res = await request(app).get('/api/fleet/claims').set(authHeader(rapidOwner.user));
      expect(res.body.claims.map((c) => c.id)).not.toContain(kasiClaim);
    });
  });
});

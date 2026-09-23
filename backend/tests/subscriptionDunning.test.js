import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const dunning = load('../src/services/subscriptionDunning.js');
const billing = load('../src/services/subscriptionBilling.js');
const notifier = load('../src/services/notifierPg.js');
const axios = load('axios');

// What happens when a fleet's card is declined.
//
// Three things have to hold, and every test below is one of them: try again on
// a schedule rather than every morning, tell the fleet the same deadline we
// are going to act on, and never pause an account that has paid.

describe('the retry schedule', () => {
  const periodStart = '2026-09-01';
  // Pinned, because the schedule is relative to the day it is worked out on
  // and a test that reads the clock would mean something different tomorrow.
  const onTheFirst = new Date('2026-09-01T06:00:00Z');

  it('spreads three more attempts over twelve days', () => {
    const at = (n) => dunning.scheduleAfterFailure({
      failureCount: n, periodStart, when: new Date('2026-09-01T06:00:00Z'),
    }).retryAt;
    expect([at(1), at(2), at(3)]).toEqual(['2026-09-04', '2026-09-08', '2026-09-13']);
  });

  // The point of the whole column: without it a daily run re-presents a
  // declined card every morning, which is how a merchant account gets flagged.
  it('stops asking after the fourth failure', () => {
    expect(dunning.scheduleAfterFailure({ failureCount: 4, periodStart }).retryAt).toBeNull();
    expect(dunning.scheduleAfterFailure({ failureCount: 9, periodStart }).retryAt).toBeNull();
  });

  it('gives the fleet a fortnight before access stops', () => {
    expect(dunning.scheduleAfterFailure({ failureCount: 1, periodStart }).graceUntil).toBe('2026-09-15');
  });

  // Two days between the last attempt and the cut-off, so the final email is
  // not also the moment the account goes dark.
  it('leaves room between the last attempt and the deadline', () => {
    const s = dunning.scheduleAfterFailure({ failureCount: 3, periodStart, when: onTheFirst });
    expect(new Date(s.graceUntil) > new Date(s.retryAt)).toBe(true);
  });

  // Pushing a late retry forward can carry it past the deadline. An attempt
  // booked for a day the account is already paused is not an attempt, so
  // there is none, and the fleet is told that rather than promised one.
  it('books no further attempt once the deadline has passed', () => {
    const s = dunning.scheduleAfterFailure({
      failureCount: 1, periodStart, when: new Date('2026-09-30T06:00:00Z'),
    });
    expect(s.retryAt).toBeNull();
    expect(s.attemptsLeft).toBe(0);
  });

  // A period charged by hand a week late must still wait, not be retried by a
  // run that starts in three hours.
  it('never schedules a retry in the past', () => {
    const s = dunning.scheduleAfterFailure({
      failureCount: 1, periodStart, when: new Date('2026-09-10T06:00:00Z'),
    });
    expect(s.retryAt).toBe('2026-09-11');
  });

  it('counts down the attempts that are left', () => {
    expect(dunning.scheduleAfterFailure({ failureCount: 1, periodStart, when: onTheFirst }).attemptsLeft).toBe(3);
    expect(dunning.scheduleAfterFailure({ failureCount: 4, periodStart, when: onTheFirst }).attemptsLeft).toBe(0);
  });
});

describe('what the fleet is told', () => {
  const org = { name: 'Blue Sky Deliveries', billing_card_last4: '4081', billing_card_brand: 'visa' };
  const invoice = { amount: 15160, description: 'Pillion Complete — 40 bikes x R379' };

  // en-ZA groups thousands with a non-breaking space, which is right on the
  // page and invisible in an assertion. Normalised here so a failure means the
  // number is wrong rather than the whitespace.
  const norm = (s) => s.replace(/[\u00a0\u202f]/g, ' ');

  it('names the amount, the card and the deadline', () => {
    const body = dunning.noticeBody({
      org, invoice, reason: 'Insufficient funds', attemptsLeft: 2, graceUntil: '2026-09-15',
    });
    // en-ZA writes the decimal with a comma, which is what a South African
    // fleet expects to read on its own invoice.
    expect(norm(body)).toContain('R15 160,00');
    expect(body).toContain('visa ending 4081');
    expect(body).toContain('15 September 2026');
    expect(body).toContain('Insufficient funds');
  });

  // "Payment failed" with no date makes the fleet phone us to find out when.
  it('says when the last automatic attempt has been used up', () => {
    const body = dunning.noticeBody({ org, invoice, attemptsLeft: 0, graceUntil: '2026-09-15' });
    expect(body).toContain('last automatic attempt');
    expect(body).toContain('15 September 2026');
  });

  // A fleet that has been paused needs to know its data is still there, or it
  // assumes the worst and phones anyway.
  it('tells a paused fleet nothing has been deleted', () => {
    const body = dunning.noticeBody({ org, invoice, suspended: true, graceUntil: '2026-09-15' });
    expect(body).toMatch(/nothing has been deleted/i);
    expect(body).toMatch(/paused/i);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('chasing a declined card', () => {
  let org;
  let owner;
  let sendSpy;

  const KEY = Buffer.alloc(32, 5).toString('hex');
  const AUTH = { authorization_code: 'AUTH_abc123xyz', last4: '4081', brand: 'visa', exp_month: 12, exp_year: 2030, reusable: true };
  const WHEN = new Date('2026-09-01T06:00:00Z');

  beforeEach(async () => {
    await resetAllPgTables();
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_platform_0000000';
    org = await createPgOrg({ name: 'Blue Sky Deliveries', status: 'active' });
    ({ user: owner } = await createPgUser({ organization_id: org.id, role: 'fleet_owner_admin' }));
    for (let i = 0; i < 40; i += 1) await createPgBike({ organization_id: org.id, status: 'active' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', subscription_cycle='monthly', subscription_status='active' WHERE id=$1`,
      [org.id]);
    await billing.rememberAuthorization({ organizationId: org.id, authorization: AUTH, email: 'ops@bluesky.co.za' });
    sendSpy = vi.spyOn(notifier, 'sendNotification').mockResolvedValue(1);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  const paystackDeclines = (response = 'Insufficient funds') =>
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { status: true, data: { status: 'failed', gateway_response: response, reference: 'ref_x' } } });

  const paystackSucceeds = () =>
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { status: true, data: { status: 'success', reference: 'ref_ok' } } });

  const orgRow = async () => (await pgDb.query('SELECT * FROM organizations WHERE id=$1', [org.id])).rows[0];

  it('marks the subscription past due and books the next attempt', async () => {
    paystackDeclines();
    await billing.chargeOrganization(org.id, { when: WHEN });

    const row = await orgRow();
    expect(row.subscription_status).toBe('past_due');
    expect(row.billing_failure_count).toBe(1);
    expect(String(row.billing_retry_at).slice(0, 10)).toBe('2026-09-04');
    expect(String(row.billing_grace_until).slice(0, 10)).toBe('2026-09-15');
  });

  // The fleet is still working. A limit or an expired card is not a reason to
  // take a fleet's tracking away the same morning.
  it('does not touch access on the first failure', async () => {
    paystackDeclines();
    await billing.chargeOrganization(org.id, { when: WHEN });
    expect((await orgRow()).status).toBe('active');
  });

  it('emails the billing contact with the reason', async () => {
    paystackDeclines('Insufficient funds');
    await billing.chargeOrganization(org.id, { when: WHEN });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ userId: owner.id, channel: 'email', type: 'subscription_payment_failed' });
    expect(sent.message).toContain('Insufficient funds');
  });

  it('tells the billing role as well as the owner', async () => {
    const { user: billingUser } = await createPgUser({ organization_id: org.id, role: 'fleet_owner_billing' });
    paystackDeclines();
    await billing.chargeOrganization(org.id, { when: WHEN });

    const notified = sendSpy.mock.calls.map((c) => c[0].userId).sort();
    expect(notified).toEqual([owner.id, billingUser.id].sort());
  });

  // A re-run of the scheduler must not send the same warning twice.
  it('does not repeat a notice it has already sent', async () => {
    paystackDeclines();
    await billing.chargeOrganization(org.id, { when: WHEN });
    sendSpy.mockClear();

    await dunning.recordFailure({
      organizationId: org.id,
      invoice: { period_start: '2026-09-01', amount: 15160 },
      reason: 'Insufficient funds',
      when: WHEN,
    });
    // The count moved on, so this is a different notice and does go out.
    expect(sendSpy).toHaveBeenCalledTimes(1);

    sendSpy.mockClear();
    const row = await orgRow();
    await dunning.sendNotice({ org: row, invoice: null, attemptsLeft: 2, graceUntil: row.billing_grace_until });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // The date in the email has to be the date the scheduler acts on, or the
  // fleet is warned about one deadline and cut off on another.
  it('keeps the deadline set by the first failure', async () => {
    paystackDeclines();
    await billing.chargeOrganization(org.id, { when: WHEN });
    const first = (await orgRow()).billing_grace_until;

    await billing.chargeOrganization(org.id, { when: new Date('2026-09-04T06:00:00Z') });
    expect((await orgRow()).billing_grace_until).toEqual(first);
  });

  // The one that matters: the next month's charge fails too, and its own
  // period would put the deadline two weeks further out. If the deadline
  // moved with each failure a fleet that never pays would never be paused —
  // the cut-off would always be a fortnight away.
  it('does not let a later failure push the deadline out', async () => {
    paystackDeclines();
    await billing.chargeOrganization(org.id, { when: WHEN });
    expect(String((await orgRow()).billing_grace_until).slice(0, 10)).toBe('2026-09-15');

    await dunning.recordFailure({
      organizationId: org.id,
      invoice: { period_start: '2026-10-01', amount: 15160 },
      reason: 'Insufficient funds',
      when: new Date('2026-10-01T06:00:00Z'),
    });

    expect(String((await orgRow()).billing_grace_until).slice(0, 10)).toBe('2026-09-15');
  });

  describe('who the daily run charges', () => {
    it('leaves a fleet alone on a day its schedule does not name', async () => {
      paystackDeclines();
      await billing.chargeOrganization(org.id, { when: WHEN });

      const due = await billing.organizationsDue({ when: new Date('2026-09-02T06:00:00Z') });
      expect(due).not.toContain(org.id);
    });

    it('picks it up again on the day it is due', async () => {
      paystackDeclines();
      await billing.chargeOrganization(org.id, { when: WHEN });

      const due = await billing.organizationsDue({ when: new Date('2026-09-04T06:00:00Z') });
      expect(due).toContain(org.id);
    });

    // Once the attempts are used up the card is left alone entirely — the
    // fleet is waiting to be paused, or for someone to come and fix the card.
    it('stops presenting the card once the attempts are used up', async () => {
      await pgDb.query(
        `UPDATE organizations SET subscription_status='past_due', billing_failure_count=4,
                billing_retry_at=NULL, billing_grace_until='2026-09-15' WHERE id=$1`, [org.id]);
      const due = await billing.organizationsDue({ when: new Date('2026-09-14T06:00:00Z') });
      expect(due).not.toContain(org.id);
    });
  });

  describe('pausing an account that never paid', () => {
    beforeEach(async () => {
      await pgDb.query(
        `UPDATE organizations SET subscription_status='past_due', billing_failure_count=4,
                billing_retry_at=NULL, billing_grace_until='2026-09-15' WHERE id=$1`, [org.id]);
    });

    it('leaves it alone while the grace period is still running', async () => {
      expect(await dunning.suspendExpired({ when: new Date('2026-09-15T06:00:00Z') })).toEqual([]);
      expect((await orgRow()).status).toBe('active');
    });

    it('pauses it the day after the deadline', async () => {
      expect(await dunning.suspendExpired({ when: new Date('2026-09-16T06:00:00Z') })).toEqual([org.id]);
      expect((await orgRow()).status).toBe('suspended');
    });

    it('tells the fleet it has been paused', async () => {
      await dunning.suspendExpired({ when: new Date('2026-09-16T06:00:00Z') });
      expect(sendSpy.mock.calls[0][0]).toMatchObject({ type: 'subscription_suspended' });
    });

    it('does not pause the same account twice', async () => {
      await dunning.suspendExpired({ when: new Date('2026-09-16T06:00:00Z') });
      expect(await dunning.suspendExpired({ when: new Date('2026-09-17T06:00:00Z') })).toEqual([]);
    });

    // A fleet that has paid must never be caught by the suspension pass.
    it('does not pause a fleet whose subscription is active', async () => {
      await pgDb.query(`UPDATE organizations SET subscription_status='active' WHERE id=$1`, [org.id]);
      expect(await dunning.suspendExpired({ when: new Date('2026-09-16T06:00:00Z') })).toEqual([]);
    });
  });

  describe('when the money finally arrives', () => {
    it('clears the chase and gives access back', async () => {
      await pgDb.query(
        `UPDATE organizations SET status='suspended', subscription_status='past_due', billing_failure_count=4,
                billing_grace_until='2026-09-15', billing_last_notice='suspended' WHERE id=$1`, [org.id]);

      paystackSucceeds();
      await billing.chargeOrganization(org.id, { when: new Date('2026-09-20T06:00:00Z') });

      expect(await orgRow()).toMatchObject({
        status: 'active', subscription_status: 'active', billing_failure_count: 0,
        billing_retry_at: null, billing_grace_until: null, billing_last_notice: null,
      });
    });

    // The bug this was written for: paying us set `subscription_status` but
    // never `status`, so a paid-up fleet was locked out the day its trial
    // expired.
    it('lifts the paywall for a fleet still marked as trialing', async () => {
      await pgDb.query(`UPDATE organizations SET status='trialing' WHERE id=$1`, [org.id]);
      paystackSucceeds();
      await billing.chargeOrganization(org.id, { when: WHEN });
      expect((await orgRow()).status).toBe('active');
    });

    // A fleet that cancelled and was never charged again should stay
    // cancelled, not be quietly reactivated by an unrelated write.
    it('does not resurrect an account nobody paid for', async () => {
      await pgDb.query(`UPDATE organizations SET status='cancelled', subscription_status='cancelled' WHERE id=$1`, [org.id]);
      expect(await billing.chargeOrganization(org.id, { when: WHEN }))
        .toMatchObject({ skipped: 'subscription cancelled' });
      expect((await orgRow()).status).toBe('cancelled');
    });
  });

  describe('the daily run as a whole', () => {
    it('charges who is due and pauses who has run out', async () => {
      const lapsed = await createPgOrg({ name: 'Lapsed Fleet', slug: 'lapsed-fleet', status: 'active' });
      await createPgUser({ organization_id: lapsed.id, role: 'fleet_owner_admin' });
      await pgDb.query(
        `UPDATE organizations SET subscription_tier='track', subscription_status='past_due',
                billing_failure_count=4, billing_retry_at=NULL, billing_grace_until='2026-09-15' WHERE id=$1`,
        [lapsed.id]);

      paystackSucceeds();
      const { charges, suspended } = await billing.runBillingRun({ when: new Date('2026-09-16T06:00:00Z') });

      expect(charges.filter((c) => c.charged).map((c) => c.organizationId)).toEqual([org.id]);
      expect(suspended).toEqual([lapsed.id]);
    });
  });
});

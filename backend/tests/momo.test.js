import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement,
} from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const client = load('../src/services/momo/client.js');
const momo = load('../src/services/momo/payments.js');

// MTN MoMo, in and out.
//
// Nothing here calls MTN. What is being tested is the half that is ours: that
// a transaction is written down before it is sent, that a payment is never
// counted twice however the news of it arrives, and that a rider who pays for
// a bike that will not start gets a bike that starts.
//
// The thing these guard hardest is the asymmetry of the two directions. A
// collection that goes wrong costs a rider a retry. A disbursement that goes
// wrong is money in a stranger's wallet, and there is no part of this system
// that can get it back — which is why a number is verified before it is ever
// stored, and why that check is tested from both ends.

describe.skipIf(!process.env.DATABASE_URL)('MTN MoMo', () => {
  let org, rider, bike, agreement, device;

  const tx = async (referenceId) => {
    const { rows } = await pgDb.query('SELECT * FROM momo_transactions WHERE reference_id = $1', [referenceId]);
    return rows[0];
  };
  const wallet = async () => {
    const { rows } = await pgDb.query('SELECT * FROM fleet_wallets WHERE organization_id = $1', [org.id]);
    return rows[0] || { balance: '0' };
  };
  const deviceRow = async () => {
    const { rows } = await pgDb.query('SELECT * FROM tracking_devices WHERE id = $1', [device.id]);
    return rows[0];
  };
  const cutForArrears = async () => pgDb.query(
    `UPDATE tracking_devices SET engine_cut_active = TRUE, engine_cut_reason = 'Arrears', engine_cut_at = NOW()
      WHERE id = $1`, [device.id]);

  beforeEach(async () => {
    await resetAllPgTables();
    vi.restoreAllMocks();
    org = await createPgOrg({ name: 'Moyo Bikes' });
    rider = (await createPgUser({ role: 'rider', full_name: 'Thabo Mokoena' })).user;
    bike = await createPgBike({ registration: 'MOY001GP', organization_id: org.id, status: 'active' });
    agreement = await createPgAgreement({ bike_id: bike.id, user_id: rider.id, status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, model, connected) VALUES ('350000000000900',$1,'FMB920',true) RETURNING *`,
      [bike.id]);
    device = rows[0];
    await pgDb.query(`UPDATE users SET momo_msisdn = '27821234567' WHERE id = $1`, [rider.id]);
  });

  // A number typed by a person, in any of the ways a person types one.
  describe('reading a phone number', () => {
    it.each([
      ['082 123 4567', '27821234567'],
      ['+27 82 123 4567', '27821234567'],
      ['0027821234567', '27821234567'],
      ['27821234567', '27821234567'],
      ['821234567', '27821234567'],
    ])('makes %s into %s', (input, expected) => {
      expect(momo.normaliseMsisdn(input)).toBe(expected);
    });

    // Refused rather than guessed at. A guess here is money sent to whoever
    // owns the guess.
    it.each(['', 'not a number', '12', null])('refuses %s', (input) => {
      expect(momo.normaliseMsisdn(input)).toBeNull();
    });
  });

  describe('asking a rider to pay', () => {
    it('writes the transaction down before calling MTN', async () => {
      // Throws on the way out. The row must still be there afterwards: a
      // request we sent and did not record is money we cannot ask about.
      let seenAtCallTime = null;
      vi.spyOn(client, 'requestToPay').mockImplementation(async ({ referenceId }) => {
        seenAtCallTime = await tx(referenceId);
        return { referenceId, status: 'PENDING' };
      });
      const out = await momo.collectFromRider({
        userId: rider.id, organizationId: org.id, agreementId: agreement.id,
        amount: 650, msisdn: '0821234567',
      });
      expect(seenAtCallTime, 'MTN was called before the row existed').not.toBeNull();
      expect(seenAtCallTime.status).toBe('pending');
      expect(out.reference_id).toBe(seenAtCallTime.reference_id);
    });

    it('records a refusal against the transaction rather than losing it', async () => {
      vi.spyOn(client, 'requestToPay').mockRejectedValue(new Error('PAYER_NOT_FOUND'));
      await expect(momo.collectFromRider({
        userId: rider.id, organizationId: org.id, agreementId: agreement.id,
        amount: 650, msisdn: '0821234567',
      })).rejects.toThrow(/PAYER_NOT_FOUND/);
      const { rows } = await pgDb.query(`SELECT * FROM momo_transactions WHERE status = 'failed'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].momo_reason).toMatch(/PAYER_NOT_FOUND/);
    });

    // A rider on a patchy connection taps Pay, sees nothing, and taps again.
    // Two prompts on the handset is two payments if they approve both, and
    // the second is money we have to give back.
    it('does not start a second prompt while one is in flight', async () => {
      const calls = [];
      vi.spyOn(client, 'requestToPay').mockImplementation(async (a) => { calls.push(a); return { status: 'PENDING' }; });
      const args = {
        userId: rider.id, organizationId: org.id, agreementId: agreement.id,
        amount: 650, msisdn: '0821234567',
      };
      const first = await momo.collectFromRider(args);
      const second = await momo.collectFromRider(args);

      expect(calls, 'the rider got two payment prompts').toHaveLength(1);
      expect(second.reference_id, 'the second tap started a different payment').toBe(first.reference_id);
      expect(second.already_pending).toBe(true);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int AS n FROM momo_transactions');
      expect(rows[0].n).toBe(1);
    });

    // Once the old one is dead, a fresh attempt is allowed through.
    it('but does allow a fresh attempt once the old prompt has expired', async () => {
      vi.spyOn(client, 'requestToPay').mockResolvedValue({ status: 'PENDING' });
      const args = {
        userId: rider.id, organizationId: org.id, agreementId: agreement.id,
        amount: 650, msisdn: '0821234567',
      };
      const first = await momo.collectFromRider(args);
      await pgDb.query(
        `UPDATE momo_transactions SET requested_at = NOW() - ($1 || ' minutes')::interval WHERE id = $2`,
        [String(momo.DUPLICATE_WINDOW_MINUTES + 1), first.id]);
      const second = await momo.collectFromRider(args);
      expect(second.reference_id).not.toBe(first.reference_id);
    });

    it('will not collect against a number it cannot read', async () => {
      await expect(momo.collectFromRider({
        userId: rider.id, organizationId: org.id, amount: 650, msisdn: 'nonsense',
      })).rejects.toThrow(/no usable momo number/i);
    });

    it('nor an amount of nothing', async () => {
      await expect(momo.collectFromRider({
        userId: rider.id, organizationId: org.id, amount: 0, msisdn: '0821234567',
      })).rejects.toThrow(/nothing to collect/i);
    });
  });

  describe('when the money lands', () => {
    const paid = async () => {
      vi.spyOn(client, 'requestToPay').mockResolvedValue({ status: 'PENDING' });
      const t = await momo.collectFromRider({
        userId: rider.id, organizationId: org.id, agreementId: agreement.id,
        amount: 650, msisdn: '0821234567',
      });
      return tx(t.reference_id);
    };

    it('credits the fleet wallet, net of the fee', async () => {
      const t = await paid();
      await momo.applyStatus(t, { status: 'SUCCESSFUL' });
      const fee = +(650 * momo.PLATFORM_FEE_RATE + momo.PLATFORM_FEE_FIXED).toFixed(2);
      expect(Number((await wallet()).balance)).toBeCloseTo(650 - fee, 2);
    });

    // The point of the whole integration: a rider standing next to a bike that
    // will not start pays from the phone in their hand and rides away.
    it('and the bike starts again', async () => {
      await cutForArrears();
      const t = await paid();
      await momo.applyStatus(t, { status: 'SUCCESSFUL' });
      const d = await deviceRow();
      expect(d.engine_cut_active, 'the rider paid and the bike stayed dead').toBe(false);
      expect(d.night_lock_active).toBe(false);
    });

    // A bike stopped because it was stolen does not start again because the
    // rent arrived.
    it('but a bike cut for theft stays cut', async () => {
      await pgDb.query(
        `UPDATE tracking_devices SET engine_cut_active = TRUE, engine_cut_reason = 'Reported stolen' WHERE id = $1`,
        [device.id]);
      const t = await paid();
      await momo.applyStatus(t, { status: 'SUCCESSFUL' });
      expect((await deviceRow()).engine_cut_active, 'rent money released a stolen bike').toBe(true);
    });

    // MTN sends a callback AND the reconciler asks. Both are supposed to be
    // safe, and the rider's money is counted once.
    it('is counted once however many times we are told', async () => {
      const t = await paid();
      await momo.applyStatus(t, { status: 'SUCCESSFUL' });
      const after = Number((await wallet()).balance);
      await momo.applyStatus(await tx(t.reference_id), { status: 'SUCCESSFUL' });
      await momo.settleCollection(t);
      expect(Number((await wallet()).balance), 'the same payment was banked twice').toBeCloseTo(after, 2);
    });

    it('and a failure credits nothing', async () => {
      await cutForArrears();
      const t = await paid();
      await momo.applyStatus(t, { status: 'FAILED', reason: 'PAYER_LIMIT_REACHED' });
      expect(Number((await wallet()).balance)).toBe(0);
      expect((await deviceRow()).engine_cut_active, 'a failed payment unlocked a bike').toBe(true);
      expect((await tx(t.reference_id)).momo_reason).toMatch(/LIMIT/);
    });

    it('while PENDING leaves everything exactly as it was', async () => {
      await cutForArrears();
      const t = await paid();
      expect(await momo.applyStatus(t, { status: 'PENDING' })).toBeNull();
      expect(Number((await wallet()).balance)).toBe(0);
      expect((await deviceRow()).engine_cut_active).toBe(true);
    });
  });

  describe('paying a fleet owner out', () => {
    const payoutRequest = async () => {
      const { rows } = await pgDb.query(
        `INSERT INTO fleet_payout_requests
           (organization_id, requested_by, amount_requested, net_payout, status, payout_method, momo_msisdn)
         VALUES ($1,$2,$3,$4,'pending','momo','27831234567') RETURNING *`,
        [org.id, rider.id, 1000, 1000]);
      return rows[0];
    };

    it('records the transfer against the request', async () => {
      vi.spyOn(client, 'transfer').mockResolvedValue({ status: 'PENDING' });
      const req = await payoutRequest();
      const t = await momo.payOutToFleet({
        payoutRequestId: req.id, organizationId: org.id, amount: 1000, msisdn: '0831234567',
      });
      const { rows } = await pgDb.query('SELECT * FROM fleet_payout_requests WHERE id = $1', [req.id]);
      expect(rows[0].momo_transaction_id).toBe(t.id);
      expect(t.external_id).toBe(`PAYOUT-${req.id}`);
    });

    it('and marks it paid only once MTN says so', async () => {
      vi.spyOn(client, 'transfer').mockResolvedValue({ status: 'PENDING' });
      const req = await payoutRequest();
      const t = await momo.payOutToFleet({
        payoutRequestId: req.id, organizationId: org.id, amount: 1000, msisdn: '0831234567',
      });
      const still = await pgDb.query('SELECT status FROM fleet_payout_requests WHERE id = $1', [req.id]);
      expect(still.rows[0].status, 'a payout was marked paid before the money moved').toBe('pending');

      await momo.applyStatus(await tx(t.reference_id), { status: 'SUCCESSFUL' });
      const done = await pgDb.query('SELECT status FROM fleet_payout_requests WHERE id = $1', [req.id]);
      expect(done.rows[0].status).toBe('paid');
    });

    it('refuses a number it cannot read rather than guessing', async () => {
      const req = await payoutRequest();
      await expect(momo.payOutToFleet({
        payoutRequestId: req.id, organizationId: org.id, amount: 1000, msisdn: '12',
      })).rejects.toThrow(/no usable momo number/i);
    });
  });

  describe('checking a number before money is sent to it', () => {
    it('passes a live wallet and brings back the name', async () => {
      vi.spyOn(client, 'isConfigured').mockReturnValue(true);
      vi.spyOn(client, 'isAccountActive').mockResolvedValue(true);
      vi.spyOn(client, 'accountHolderName').mockResolvedValue('Thabo Mokoena');
      expect(await momo.verifyMsisdn('082 123 4567'))
        .toMatchObject({ ok: true, msisdn: '27821234567', name: 'Thabo Mokoena' });
    });

    it('fails a number MTN does not know', async () => {
      vi.spyOn(client, 'isConfigured').mockReturnValue(true);
      vi.spyOn(client, 'isAccountActive').mockResolvedValue(false);
      const out = await momo.verifyMsisdn('082 123 4567');
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/does not recognise/i);
    });

    it('and says so plainly when MoMo is not connected at all', async () => {
      vi.spyOn(client, 'isConfigured').mockReturnValue(false);
      expect(await momo.verifyMsisdn('0821234567')).toMatchObject({ ok: false, unconfigured: true });
    });
  });

  describe('the reconciler', () => {
    it('settles what MTN says has settled', async () => {
      vi.spyOn(client, 'requestToPay').mockResolvedValue({ status: 'PENDING' });
      vi.spyOn(client, 'isConfigured').mockReturnValue(true);
      const t = await momo.collectFromRider({
        userId: rider.id, organizationId: org.id, agreementId: agreement.id,
        amount: 650, msisdn: '0821234567',
      });
      vi.spyOn(client, 'requestToPayStatus').mockResolvedValue({ status: 'SUCCESSFUL' });

      const out = await momo.reconcile();
      expect(out.settled).toBe(1);
      expect((await tx(t.reference_id)).status).toBe('successful');
      expect(Number((await wallet()).balance)).toBeGreaterThan(0);
    });

    // A transaction MTN cannot be asked about must not block the ones behind
    // it, and must not be quietly marked anything.
    it('leaves a transaction it cannot check alone, and carries on', async () => {
      vi.spyOn(client, 'requestToPay').mockResolvedValue({ status: 'PENDING' });
      vi.spyOn(client, 'isConfigured').mockReturnValue(true);
      const t = await momo.collectFromRider({
        userId: rider.id, organizationId: org.id, amount: 650, msisdn: '0821234567',
      });
      vi.spyOn(client, 'requestToPayStatus').mockRejectedValue(new Error('gateway timeout'));

      const out = await momo.reconcile();
      expect(out.checked).toBe(1);
      expect(out.settled).toBe(0);
      const after = await tx(t.reference_id);
      expect(after.status).toBe('pending');
      expect(after.checked_at, 'the attempt was not recorded').not.toBeNull();
    });

    it('does nothing at all when MoMo is not configured', async () => {
      vi.spyOn(client, 'isConfigured').mockReturnValue(false);
      expect(await momo.reconcile()).toMatchObject({ skipped: 'not configured' });
    });
  });
});

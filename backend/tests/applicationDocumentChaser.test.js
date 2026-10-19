import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgUser } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const chaser = load('../src/services/applicationDocumentChaser.js');

// Asking applicants for the documents they still owe.
//
// The queue this replaces was read by a person: 108 of 116 applications
// sitting in 'submitted' were incomplete, and somebody typed each email by
// hand. So the two things these tests care about most are not the sending.
//
// Nobody is emailed twice. The row is marked before the send precisely so a
// provider that throws after accepting the message cannot put a rider into a
// loop with a sweep that runs every quarter of an hour.
//
// And nobody is emailed who should not be: not while they may still be
// uploading, not months after they applied, not once somebody is reviewing
// their application, and not when the thing being asked for has already
// arrived.

describe.skipIf(!process.env.DATABASE_URL)('chasing outstanding application documents', () => {
  let rider;

  const minutesAgo = (n) => new Date(Date.now() - n * 60_000);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

  const application = async ({
    userId, status = 'submitted', submittedAt = minutesAgo(90), chasedAt = null,
  } = {}) => {
    const { rows } = await pgDb.query(
      `INSERT INTO applications (user_id, status, submitted_at, documents_chased_at)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [userId || rider.id, status, submittedAt, chasedAt]);
    return rows[0];
  };

  const addDoc = async (applicationId, docType, userId) =>
    pgDb.query(
      `INSERT INTO application_documents (application_id, user_id, doc_type, file_path, status)
       VALUES ($1,$2,$3,$4,'uploaded')`,
      [applicationId, userId || rider.id, docType, `/tmp/${docType}-${Math.random()}.pdf`]);

  const complete = async (app) => {
    await addDoc(app.id, 'id_document');
    await addDoc(app.id, 'drivers_license');
    for (let i = 0; i < 3; i += 1) await addDoc(app.id, 'payslip');
  };

  const chasedAt = async (id) => {
    const { rows } = await pgDb.query('SELECT documents_chased_at FROM applications WHERE id = $1', [id]);
    return rows[0].documents_chased_at;
  };
  const emailsSent = async () => {
    const { rows } = await pgDb.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'application_documents_outstanding'`);
    return rows[0].n;
  };

  beforeEach(async () => {
    await resetAllPgTables();
    await chaser.setEnabled(true);
    rider = (await createPgUser({ role: 'rider', full_name: 'Thabo Mokoena' })).user;
    vi.restoreAllMocks();
  });

  describe('what it says is missing', () => {
    it('asks for everything when nothing has arrived', () => {
      const missing = chaser.missingFrom({});
      expect(missing.map((m) => m.key)).toEqual(['id_document', 'drivers_license', 'payslip']);
      expect(missing[2].label).toContain('last 3 payslips');
    });

    // The case that prompted all this: ID and licence in, payslips not.
    it('asks only for payslips when the identity documents are in', () => {
      const missing = chaser.missingFrom({ id_document: 1, drivers_license: 1, payslip: 0 });
      expect(missing.map((m) => m.key)).toEqual(['payslip']);
    });

    it('counts the payslips already sent', () => {
      expect(chaser.missingFrom({ id_document: 1, drivers_license: 1, payslip: 2 })[0].label)
        .toBe('1 more payslip (you have sent 2)');
      expect(chaser.missingFrom({ id_document: 1, drivers_license: 1, payslip: 1 })[0].label)
        .toBe('2 more payslips (you have sent 1)');
    });

    it('and asks for nothing when the file is complete', () => {
      expect(chaser.missingFrom({ id_document: 1, drivers_license: 1, payslip: 3 })).toEqual([]);
    });
  });

  describe('the email', () => {
    it('reads as one thing when one thing is missing', () => {
      const { subject, body } = chaser.composeEmail({
        fullName: 'Thabo Mokoena',
        missing: chaser.missingFrom({ id_document: 1, drivers_license: 1 }),
      });
      expect(subject).toMatch(/one more thing/i);
      expect(body).toContain('Hi Thabo,');
      expect(body).toMatch(/just one thing/i);
    });

    it('and as a list when several are', () => {
      const { subject, body } = chaser.composeEmail({
        fullName: 'Thabo Mokoena', missing: chaser.missingFrom({}),
      });
      expect(subject).toMatch(/a few things/i);
      expect(body).toContain('• a clear photo of your ID');
      expect(body).toContain("• a photo of your driver's licence");
    });

    // On its own line after a colon, which is what turns it into the button
    // rather than a bare link buried in a sentence.
    it('carries the upload link', () => {
      const { body } = chaser.composeEmail({ fullName: 'X', missing: chaser.missingFrom({}) });
      expect(body).toMatch(/You can upload them here: https?:\/\/\S+\/application/);
    });

    it('and copes with a rider whose name we never got', () => {
      expect(chaser.composeEmail({ fullName: null, missing: chaser.missingFrom({}) }).body)
        .toContain('Hi there,');
    });
  });

  describe('who gets chased', () => {
    it('an incomplete application that has gone quiet', async () => {
      const app = await application();
      await addDoc(app.id, 'id_document');
      const due = await chaser.candidates();
      expect(due.map((d) => d.id)).toEqual([app.id]);
      expect(due[0].missing.map((m) => m.key)).toEqual(['drivers_license', 'payslip']);
    });

    // Four out of five applicants upload within the same minute. Emailing them
    // mid-upload to ask for what they are uploading is how this becomes an
    // email nobody reads.
    it('but not one submitted minutes ago', async () => {
      await application({ submittedAt: minutesAgo(5) });
      expect(await chaser.candidates()).toEqual([]);
    });

    it('nor one from months back', async () => {
      await application({ submittedAt: daysAgo(chaser.MAX_AGE_DAYS + 1) });
      expect(await chaser.candidates()).toEqual([]);
    });

    it('nor a complete one', async () => {
      const app = await application();
      await complete(app);
      expect(await chaser.candidates()).toEqual([]);
    });

    // Somebody is already looking at it; it is not the rider's move.
    it('nor one already under review, approved or rejected', async () => {
      for (const status of ['under_review', 'approved', 'rejected']) {
        await application({ status });
      }
      expect(await chaser.candidates()).toEqual([]);
    });

    it('nor one already chased', async () => {
      await application({ chasedAt: new Date() });
      expect(await chaser.candidates()).toEqual([]);
    });

    it('nor a rider with no email address', async () => {
      const noEmail = (await createPgUser({ role: 'rider' })).user;
      await pgDb.query(`UPDATE users SET email = '' WHERE id = $1`, [noEmail.id]);
      await application({ userId: noEmail.id });
      expect(await chaser.candidates()).toEqual([]);
    });

    it('nor a closed account', async () => {
      const gone = (await createPgUser({ role: 'rider' })).user;
      await pgDb.query(`UPDATE users SET deleted_at = NOW() WHERE id = $1`, [gone.id]);
      await application({ userId: gone.id });
      expect(await chaser.candidates()).toEqual([]);
    });
  });

  describe('sending', () => {
    it('emails the applicant and records that it did', async () => {
      const app = await application();
      const res = await chaser.run();
      expect(res.sent).toBe(1);
      expect(await chasedAt(app.id)).not.toBeNull();
      expect(await emailsSent()).toBe(1);
    });

    // The one that matters. The sweep runs every fifteen minutes.
    it('never emails the same applicant twice', async () => {
      await application();
      expect((await chaser.run()).sent).toBe(1);
      expect((await chaser.run()).sent).toBe(0);
      expect((await chaser.run()).sent).toBe(0);
      expect(await emailsSent()).toBe(1);
    });

    // A provider that accepts the message and then throws must not leave the
    // row looking unchased, or the next sweep sends it again.
    it('and not even when the send throws after the fact', async () => {
      const app = await application();
      const res = await chaser.run({ send: () => Promise.reject(new Error('provider timed out')) });
      expect(res.failed).toBe(1);
      expect(await chasedAt(app.id), 'a failed send left the rider open to being chased again').not.toBeNull();
      expect((await chaser.run()).sent, 'the rider was chased a second time').toBe(0);
    });

    // Read from the database every sweep, so switching it off takes effect on
    // the next one rather than on the next deploy.
    it('sends nothing at all while it is switched off', async () => {
      await chaser.setEnabled(false);
      await application();
      const res = await chaser.run();
      expect(res.skipped).toBe('disabled');
      expect(await emailsSent()).toBe(0);
    });

    // How this gets looked at against real applicants before it is ever
    // switched on.
    it('a dry run shows the emails without sending or marking anything', async () => {
      const app = await application();
      await chaser.setEnabled(false);
      const res = await chaser.run({ dryRun: true });
      expect(res.would_send).toBe(1);
      expect(res.applications[0].id).toBe(app.id);
      expect(res.applications[0].subject).toBeTruthy();
      expect(await emailsSent()).toBe(0);
      expect(await chasedAt(app.id)).toBeNull();
    });
  });
});

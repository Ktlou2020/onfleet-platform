'use strict';

const pgDb = require('../pgDb');
const { brand } = require('../brand');
const { sendNotification } = require('./notifierPg');

// Asking a rider for the documents their application is still missing.
//
// Submitting creates the application; the three things actually needed — ID,
// driver's licence, three payslips — are uploaded afterwards, against it. Most
// people do that in the same minute. The rest used to be chased by somebody
// reading the queue and typing an email, which is why 108 of the 116
// applications sitting in 'submitted' were incomplete when this was written.
//
// WHY THIS WAITS AN HOUR RATHER THAN FIRING ON SUBMISSION
//
// At the moment an application is created it has no documents, by
// construction. An email sent then could only ever say "send all three" — to
// everybody, including the four in five who are at that moment in the middle
// of uploading. The measured gap between submitting and the last document is a
// median of under a minute, and 2493 of 2574 applicants finish inside an hour.
// So the useful email is the one that arrives after the people who were going
// to do it have done it, naming only what is genuinely outstanding.
const QUIET_MINUTES = Number(process.env.APPLICATION_CHASE_AFTER_MINUTES || 60);

// And how far back to reach. Somebody who applied in May has moved on, and an
// email about it now is archaeology rather than onboarding.
const MAX_AGE_DAYS = Number(process.env.APPLICATION_CHASE_MAX_AGE_DAYS || 30);

const REQUIRED_PAYSLIPS = 3;

// Absent means off, like the night lock and for the same reason: this one
// sends email to real applicants, and deploying it should not be what starts
// that happening. Somebody turns it on, having looked at who it would reach.
const SETTING_KEY = 'application_doc_chaser_enabled';

// Read fresh every sweep, deliberately not cached.
//
// Caching it would save one indexed lookup every fifteen minutes and cost the
// thing that actually goes wrong: a value held in a process cannot be changed
// from outside it. Switching this on in the database and finding the running
// service still believes it is off — because something read the setting once
// at boot — is a trap this codebase has now sprung twice in a day, on the
// night lock and on the alert settings. A query per quarter hour is not worth
// a switch that does not switch.
async function isEnabled() {
  try {
    const { rows } = await pgDb.query(
      'SELECT setting_value FROM app_settings WHERE setting_key = $1', [SETTING_KEY]);
    return rows.length ? rows[0].setting_value === 'true' : false;
  } catch {
    return false;
  }
}

async function setEnabled(on) {
  await pgDb.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [SETTING_KEY, on ? 'true' : 'false']);
}

/**
 * What this application still needs, in the words the rider will read.
 *
 * Phrased as the thing to go and do rather than the field that is empty: "two
 * more payslips" is an instruction, "payslip_count < 3" is a schema.
 */
function missingFrom({ id_document = 0, drivers_license = 0, payslip = 0 }) {
  const missing = [];
  if (!id_document) missing.push({ key: 'id_document', label: 'a clear photo of your ID' });
  if (!drivers_license) missing.push({ key: 'drivers_license', label: "a photo of your driver's licence" });

  const short = REQUIRED_PAYSLIPS - payslip;
  if (short > 0) {
    missing.push({
      key: 'payslip',
      label: payslip === 0
        ? `your last ${REQUIRED_PAYSLIPS} payslips`
        : `${short} more payslip${short === 1 ? '' : 's'} (you have sent ${payslip})`,
    });
  }
  return missing;
}

/** The email itself. Plain text: emailLayout turns it into the branded one. */
function composeEmail({ fullName, missing }) {
  const first = String(fullName || '').trim().split(' ')[0] || 'there';
  const subject = missing.length === 1
    ? `One more thing for your ${brand.name} application`
    : `A few things still needed for your ${brand.name} application`;

  const lead = missing.length === 1
    ? "Thanks for applying. We are ready to look at your application — there is just one thing still to send:"
    : `Thanks for applying. We are ready to look at your application — we just need ${missing.length} more things from you:`;

  const body = [
    `Hi ${first},`,
    lead,
    missing.map((m) => `• ${m.label}`).join('\n'),
    `You can upload them here: ${brand.portalUrl}/application`,
    'As soon as they are in, your application goes into review. If you have already sent something and it is listed above, reply to this email and we will take a look.',
  ].join('\n\n');

  return { subject, body };
}

/**
 * Applications waiting on documents, oldest first.
 *
 * Deliberately narrow. Only 'submitted' — an application somebody is already
 * reviewing, or has decided, is not the rider's to act on. Only those past the
 * quiet period, only those inside the age window, only those never chased, and
 * only riders with an address to write to and an account still open.
 */
async function candidates({ at = new Date(), db = pgDb } = {}) {
  const { rows } = await db.query(`
    SELECT a.id, a.user_id, a.submitted_at, u.full_name, u.email,
           COUNT(ad.id) FILTER (WHERE ad.doc_type = 'id_document')    AS id_document,
           COUNT(ad.id) FILTER (WHERE ad.doc_type = 'drivers_license') AS drivers_license,
           COUNT(ad.id) FILTER (WHERE ad.doc_type = 'payslip')         AS payslip
      FROM applications a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN application_documents ad ON ad.application_id = a.id
     WHERE a.status = 'submitted'
       AND a.documents_chased_at IS NULL
       AND u.deleted_at IS NULL
       AND u.status = 'active'
       AND COALESCE(u.email, '') <> ''
       AND a.submitted_at <= $1::timestamptz - ($2 || ' minutes')::interval
       AND a.submitted_at >= $1::timestamptz - ($3 || ' days')::interval
     GROUP BY a.id, a.user_id, a.submitted_at, u.full_name, u.email
     ORDER BY a.submitted_at`,
  [at.toISOString(), String(QUIET_MINUTES), String(MAX_AGE_DAYS)]);

  // Counts come back as strings from COUNT(); the shape below is what every
  // caller reads, so they are numbers exactly once, here.
  return rows
    .map((r) => ({
      ...r,
      id_document: Number(r.id_document),
      drivers_license: Number(r.drivers_license),
      payslip: Number(r.payslip),
    }))
    .map((r) => ({ ...r, missing: missingFrom(r) }))
    .filter((r) => r.missing.length > 0);
}

/**
 * Send one round of chases.
 *
 * `dryRun` returns exactly what would be sent without sending or marking
 * anything, which is how this gets looked at against real applicants before it
 * is ever switched on.
 *
 * `send` is injectable so a test can make delivery fail on purpose. The thing
 * worth proving is what happens when a provider accepts a message and then
 * throws, and there is no honest way to stage that against the real one.
 */
async function run({ at = new Date(), dryRun = false, limit = 200, send = sendNotification } = {}) {
  if (!dryRun && !(await isEnabled())) return { sent: 0, failed: 0, skipped: 'disabled' };

  const due = (await candidates({ at })).slice(0, limit);
  if (dryRun) {
    return {
      dry_run: true,
      would_send: due.length,
      applications: due.map((d) => ({
        id: d.id,
        submitted_at: d.submitted_at,
        missing: d.missing.map((m) => m.key),
        ...composeEmail({ fullName: d.full_name, missing: d.missing }),
      })),
    };
  }

  let sent = 0;
  let failed = 0;
  for (const app of due) {
    const { subject, body } = composeEmail({ fullName: app.full_name, missing: app.missing });
    try {
      // Marked before sending, not after. A send that throws half way — the
      // provider timing out after it has already accepted the message — must
      // not leave the row looking unchased, because the next sweep is fifteen
      // minutes away and the rider would get it again. One missed chase is a
      // person we email tomorrow by hand; a loop is a person we harass.
      await pgDb.query('UPDATE applications SET documents_chased_at = NOW() WHERE id = $1', [app.id]);
      await send({
        userId: app.user_id,
        channel: 'email',
        type: 'application_documents_outstanding',
        title: subject,
        message: body,
        entityType: 'applications',
        entityId: app.id,
        throwOnError: true,
      });
      sent += 1;
    } catch (e) {
      failed += 1;
      console.error(`[application-chaser] could not chase application ${app.id}:`, e.message);
    }
  }

  if (sent || failed) {
    console.log(`[application-chaser] asked ${sent} applicant(s) for documents${failed ? `, ${failed} failed` : ''}`);
  }
  return { sent, failed };
}

module.exports = {
  run, candidates, missingFrom, composeEmail,
  isEnabled, setEnabled,
  SETTING_KEY, QUIET_MINUTES, MAX_AGE_DAYS, REQUIRED_PAYSLIPS,
};

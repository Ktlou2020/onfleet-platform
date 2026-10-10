'use strict';

// Postgres equivalent of testDb.js — for the routes/services already
// migrated off SQLite (claims, riderScoring, dunningService, backupService,
// and eventually auth/wallet). Requires a real (throwaway) database at
// process.env.DATABASE_URL; every test file using this skips itself via
// describe.skipIf(!process.env.DATABASE_URL) if one isn't configured. See
// backend/tests/README.md (test:pg script) for how to set one up locally —
// CI provides one automatically via the postgres service container.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pgDb = require('../../src/pgDb');

const TEST_PASSWORD = 'Password123!';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4); // low cost factor — tests only

// Routes legitimately write after they respond — workshop.js sends its JSON and
// then runs logAudit() and notifyAdmins() without awaiting them. A test that has
// its response and moves straight on leaves those inserts in flight.
//
// The previous version took the lock with a short timeout and retried, on the
// grounds that waiting the stragglers out was not possible because nothing
// hands back a handle. It is possible: Postgres knows which of its own
// connections are mid-query, and pg_stat_activity will say so. Retrying only
// ever fixed the case where TRUNCATE lost the race — when TRUNCATE won it took
// the tables out from under a request that was still running, which surfaced
// as a 500 inside the route ("deadlock detected", or a row that had just been
// committed and could no longer be found). fleetJourney.test.js failed five to
// six of its seven cases on most runs because of it.
//
// So: wait for the pool to go quiet first, then truncate, and keep the retry
// for the stragglers that start after the check.
const QUIET_TIMEOUT_MS = 3000;

async function waitForQuiet(timeoutMs = QUIET_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pgDb.query(
      `SELECT COUNT(*)::int AS busy
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          -- 'idle in transaction' matters as much as 'active': a connection
          -- sitting inside an open transaction still holds every lock it has
          -- taken, and TRUNCATE will deadlock against it exactly as it would
          -- against a query still running.
          AND state IN ('active', 'idle in transaction')`);
    if (!rows[0].busy) return true;
    // Past the deadline the truncate goes ahead anyway: a test that hangs for
    // three seconds on a stuck query should fail on its own assertion, not
    // here, with a message about the fixture.
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function resetAllPgTables(attempt = 0) {
  const { rows } = await pgDb.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'pgmigrations'`
  );
  if (!rows.length) return;
  const tableList = rows.map((r) => `"${r.tablename}"`).join(', ');

  // waitForQuiet's answer was being thrown away, so a pool that never went
  // quiet truncated anyway and the next test started against a database
  // something else was still writing to. That is the shape of the failure
  // seen twice in full runs and never in isolation: a row created by a
  // fixture, then removed by a straggler, and a request answering 404 for a
  // record the test had just made.
  //
  // It still truncates in the end — a stuck query should fail on its own
  // assertion rather than here — but it waits twice as long first and says
  // so, which turns a mystery into a line in the output naming the file that
  // leaked the work.
  if (!(await waitForQuiet())) {
    const stillBusy = await waitForQuiet(QUIET_TIMEOUT_MS * 2);
    if (!stillBusy) {
      console.warn(
        '[testPgDb] pool still busy after 9s — truncating anyway. A test is leaving '
        + 'database work running after it finishes (an un-awaited promise, or a '
        + 'setImmediate the test did not wait for). Expect flakiness here.');
    }
  }

  try {
    // Plain SET, not SET LOCAL: LOCAL only applies inside a transaction, and
    // this runs outside one, so the timeout it was meant to impose never
    // actually applied.
    await pgDb.query(`SET lock_timeout = '2s'`);
    await pgDb.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
  } catch (err) {
    // 40P01 deadlock_detected, 55P03 lock_not_available
    if ((err.code === '40P01' || err.code === '55P03') && attempt < 4) {
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      return resetAllPgTables(attempt + 1);
    }
    throw err;
  } finally {
    await pgDb.query('SET lock_timeout = DEFAULT').catch(() => {});
  }
}

let seq = 0;
function nextSeq() { return ++seq; }

async function createPgOrg(overrides = {}) {
  const n = nextSeq();
  const { rows } = await pgDb.query(
    `INSERT INTO organizations (name, slug, plan_key, status) VALUES ($1,$2,$3,$4) RETURNING *`,
    [overrides.name || `Test Org ${n}`, overrides.slug || `test-org-${n}`, overrides.plan_key || 'small', overrides.status || 'active']
  );
  return rows[0];
}

async function createPgUser(overrides = {}) {
  const n = nextSeq();
  const passwordHash = overrides.password ? bcrypt.hashSync(overrides.password, 4) : TEST_PASSWORD_HASH;
  const { rows } = await pgDb.query(
    `INSERT INTO users (email, phone, password_hash, full_name, role, organization_id, status, address_match_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      overrides.email || `user${n}@example.test`,
      overrides.phone || null,
      passwordHash,
      overrides.full_name || `Test User ${n}`,
      overrides.role || 'rider',
      overrides.organization_id || null,
      overrides.status || 'active',
      overrides.address_match_status || 'unverified',
    ]
  );
  return { user: rows[0], password: overrides.password || TEST_PASSWORD };
}

async function createPgBike(overrides = {}) {
  const n = nextSeq();
  const { rows } = await pgDb.query(
    `INSERT INTO bikes (vin, registration, make, model, rental_weekly, total_weeks, status, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      overrides.vin || `VIN${n}TEST`,
      overrides.registration || `REG${n}`,
      overrides.make || 'TestMake',
      overrides.model || 'TestModel',
      overrides.rental_weekly ?? 850,
      overrides.total_weeks ?? 78,
      overrides.status || 'active',
      overrides.organization_id || null,
    ]
  );
  return rows[0];
}

async function createPgAgreement(overrides = {}) {
  const n = nextSeq();
  const bikeId = overrides.bike_id || (await createPgBike()).id;
  const userId = overrides.user_id || (await createPgUser({ role: 'rider' })).user.id;
  const weeklyAmount = overrides.weekly_amount ?? 850;
  const totalWeeks = overrides.total_weeks ?? 78;
  const { rows } = await pgDb.query(
    `INSERT INTO agreements (agreement_no, user_id, bike_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      overrides.agreement_no || `OF-TEST-${n}`,
      userId, bikeId, weeklyAmount, totalWeeks,
      overrides.total_amount ?? weeklyAmount * totalWeeks,
      overrides.start_date || '2026-01-05',
      overrides.end_date || '2027-06-28',
      overrides.status || 'active',
    ]
  );
  return rows[0];
}

async function createPgPaymentSchedule(overrides = {}) {
  const { rows } = await pgDb.query(
    `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due, amount_paid, status, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      overrides.agreement_id,
      overrides.week_number ?? 1,
      overrides.due_date || '2026-01-05',
      overrides.amount_due ?? 850,
      overrides.amount_paid ?? 0,
      overrides.status || 'pending',
      overrides.paid_at || null,
    ]
  );
  return rows[0];
}

async function createPgAlert(overrides = {}) {
  const { rows } = await pgDb.query(
    `INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at)
     VALUES ($1,$2,$3,$4,COALESCE($5, NOW())) RETURNING *`,
    [overrides.bike_id, overrides.device_id || null, overrides.alert_type, JSON.stringify(overrides.payload || {}), overrides.created_at || null]
  );
  return rows[0];
}

function signTestToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  });
}

function authHeader(user) {
  return { Authorization: `Bearer ${signTestToken(user)}` };
}

module.exports = {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement,
  createPgPaymentSchedule, createPgAlert, signTestToken, authHeader, TEST_PASSWORD,
};

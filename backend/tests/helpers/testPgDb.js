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

async function resetAllPgTables() {
  const { rows } = await pgDb.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'pgmigrations'`
  );
  if (!rows.length) return;
  const tableList = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pgDb.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
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

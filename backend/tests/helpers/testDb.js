'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../src/db');

const TEST_PASSWORD = 'Password123!';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4); // low cost factor — tests only

// Deletes all rows from every user-defined table (keeps schema/migrations intact),
// for a clean slate between tests within the same file's shared :memory: db.
function resetAllTables() {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all();
  db.pragma('foreign_keys = OFF');
  for (const { name } of tables) {
    db.prepare(`DELETE FROM ${name}`).run();
  }
  db.pragma('foreign_keys = ON');
}

let seq = 0;
function nextSeq() { return ++seq; }

function createOrg(overrides = {}) {
  const n = nextSeq();
  const info = db.prepare(`INSERT INTO organizations (name, slug, plan_key, status)
    VALUES (?, ?, ?, ?)`).run(
    overrides.name || `Test Org ${n}`,
    overrides.slug || `test-org-${n}`,
    overrides.plan_key || 'small',
    overrides.status || 'active'
  );
  return db.prepare('SELECT * FROM organizations WHERE id = ?').get(info.lastInsertRowid);
}

// role: 'rider' | 'admin' | 'superadmin' | 'fleet_owner_admin' | ... | 'control_room' | 'technician'
function createUser(overrides = {}) {
  const n = nextSeq();
  const passwordHash = overrides.password ? bcrypt.hashSync(overrides.password, 4) : TEST_PASSWORD_HASH;
  const info = db.prepare(`INSERT INTO users (email, phone, password_hash, full_name, role, organization_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    overrides.email || `user${n}@example.test`,
    overrides.phone || null,
    passwordHash,
    overrides.full_name || `Test User ${n}`,
    overrides.role || 'rider',
    overrides.organization_id || null,
    overrides.status || 'active'
  );
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return { user, password: overrides.password || TEST_PASSWORD };
}

// Mints a JWT identical in shape to auth.js's signToken(), without going through
// the rate-limited /login endpoint.
function signTestToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  });
}

function authHeader(user) {
  return { Authorization: `Bearer ${signTestToken(user)}` };
}

function createBike(overrides = {}) {
  const n = nextSeq();
  const info = db.prepare(`INSERT INTO bikes (vin, registration, make, model, rental_weekly, total_weeks, status, organization_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    overrides.vin || `VIN${n}TEST`,
    overrides.registration || `REG${n}`,
    overrides.make || 'TestMake',
    overrides.model || 'TestModel',
    overrides.rental_weekly ?? 850,
    overrides.total_weeks ?? 78,
    overrides.status || 'active',
    overrides.organization_id || null
  );
  return db.prepare('SELECT * FROM bikes WHERE id = ?').get(info.lastInsertRowid);
}

function createAgreement(overrides = {}) {
  const n = nextSeq();
  const bikeId = overrides.bike_id || createBike().id;
  const userId = overrides.user_id || createUser({ role: 'rider' }).user.id;
  const weeklyAmount = overrides.weekly_amount ?? 850;
  const totalWeeks = overrides.total_weeks ?? 78;
  const info = db.prepare(`INSERT INTO agreements
    (agreement_no, user_id, bike_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    overrides.agreement_no || `OF-TEST-${n}`,
    userId,
    bikeId,
    weeklyAmount,
    totalWeeks,
    overrides.total_amount ?? weeklyAmount * totalWeeks,
    overrides.start_date || '2026-01-05',
    overrides.end_date || '2027-06-28',
    overrides.status || 'active'
  );
  return db.prepare('SELECT * FROM agreements WHERE id = ?').get(info.lastInsertRowid);
}

function createPayment(overrides = {}) {
  const n = nextSeq();
  const info = db.prepare(`INSERT INTO payments
    (agreement_id, user_id, amount, method, reference, status, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    overrides.agreement_id,
    overrides.user_id,
    overrides.amount,
    overrides.method || 'eft',
    overrides.reference || `TEST-REF-${n}`,
    overrides.status || 'success',
    overrides.paid_at || new Date().toISOString()
  );
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = { db, resetAllTables, createOrg, createUser, createBike, createAgreement, createPayment, signTestToken, authHeader, TEST_PASSWORD };

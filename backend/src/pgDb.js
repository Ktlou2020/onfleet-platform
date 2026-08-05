'use strict';

const { Pool, types } = require('pg');

// Postgres returns DATE columns (oid 1082) as JS Date objects by default.
// This codebase was ported from SQLite, where dates were TEXT ('YYYY-MM-DD'),
// and every consumer — helpersPg.js, fleet.js, agreementLifecyclePg.js, etc.
// — compares due_date/start_date/end_date as plain strings (e.g.
// `s.due_date <= today`). A JS Date compared to a string coerces via
// Date.toString() (locale-formatted), not toISOString(), silently producing
// wrong results. Keep DATE as the raw wire string instead, matching every
// existing comparison's assumption.
types.setTypeParser(1082, (val) => val);

if (!process.env.DATABASE_URL) {
  console.warn('[pgDb] DATABASE_URL not set — Postgres tracking features will be disabled');
}

// Railway internal URLs and local dev Postgres don't support/require TLS;
// public Postgres URLs may.
const NO_SSL_HOSTS = ['.railway.internal', 'localhost', '127.0.0.1'];
const ssl = process.env.DATABASE_URL && !NO_SSL_HOSTS.some(h => process.env.DATABASE_URL.includes(h))
  ? { rejectUnauthorized: false }
  : false;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

if (pool) {
  pool.on('error', (err) => console.error('[pgDb] pool error:', err.message));
}

async function query(sql, params) {
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL missing)');
  return pool.query(sql, params);
}

// Runs fn(client) inside a single BEGIN/COMMIT/ROLLBACK transaction on one
// checked-out connection — the async equivalent of better-sqlite3's
// db.transaction(fn)(), which has no direct Postgres counterpart since a
// pooled connection has to be explicitly checked out and released.
//
// `client` exposes the same `.query(sql, params)` shape as this module's own
// `query()`, so any helper written to accept a `db = pgDb` parameter (calling
// `db.query(...)` throughout) works identically whether called standalone
// (db defaults to pgDb, its own implicit transaction per statement) or from
// inside a transaction (pass the client through, so it shares this one).
async function withTransaction(fn) {
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL missing)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection may already be dead */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };

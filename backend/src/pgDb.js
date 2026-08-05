'use strict';

const { Pool } = require('pg');

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

module.exports = { pool, query };

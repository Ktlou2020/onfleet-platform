'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[pgDb] DATABASE_URL not set — Postgres tracking features will be disabled');
}

// Railway internal URLs don't require TLS; public Postgres URLs may
const ssl = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('.railway.internal')
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

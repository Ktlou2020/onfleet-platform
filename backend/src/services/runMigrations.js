'use strict';

/**
 * Runs pending node-pg-migrate migrations at boot.
 *
 * Why here and not in the container's start command: several migrations
 * reference tables created by migrations/trackingPgSchema.js, which runs
 * in-process at startup. Migrating before the process starts fails on a fresh
 * database with `relation "tracking_devices" does not exist`. server.js
 * therefore calls this only once runTrackingSchema() has resolved.
 *
 * Why at boot at all: the Postgres host is only reachable from inside Railway's
 * network, so migrations previously had to be run by hand from a laptop against
 * the public proxy URL — and a forgotten run left production serving code whose
 * schema didn't exist yet.
 *
 * Shells out to the CLI rather than using the programmatic API so the behaviour
 * is identical to the manual `npm run migrate` this replaces. node-pg-migrate
 * takes a Postgres advisory lock, so concurrent replicas starting together
 * serialise rather than racing.
 */

const path = require('path');
const { spawn } = require('child_process');

const MIGRATION_TIMEOUT_MS = 120_000;

function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.warn('[migrations] DATABASE_URL not set — skipping');
    return Promise.resolve({ skipped: true });
  }

  const bin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'node-pg-migrate');
  const cwd = path.join(__dirname, '..', '..');

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['up'], { cwd, env: process.env });
    let out = '';
    const capture = (chunk) => { out += chunk.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`migrations timed out after ${MIGRATION_TIMEOUT_MS / 1000}s`));
    }, MIGRATION_TIMEOUT_MS);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const applied = (out.match(/### MIGRATION .* \(UP\)/g) || []).length;
        console.log(applied ? `[migrations] applied ${applied} migration(s)` : '[migrations] up to date');
        resolve({ applied });
      } else {
        // Surface the actual SQL error — the exit code alone is useless when
        // this is the thing standing between a deploy and a healthy schema.
        console.error(`[migrations] FAILED (exit ${code}):\n${out.trim()}`);
        reject(new Error(`migrations failed with exit code ${code}`));
      }
    });
  });
}

module.exports = { runMigrations };

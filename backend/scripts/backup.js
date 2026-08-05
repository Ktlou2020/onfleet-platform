'use strict';

/**
 * On-demand backup of both databases: SQLite (business data) and Postgres
 * (tracking data). Writes to backend/backups/<UTC timestamp>/ with a JSON
 * manifest (sizes, SHA-256 checksums, row-count spot-checks).
 *
 * Usage:
 *   node scripts/backup.js                  # both databases
 *   node scripts/backup.js --sqlite-only
 *   node scripts/backup.js --postgres-only
 *
 * SQLite half uses better-sqlite3's native Online Backup API (WAL-aware,
 * transactionally consistent, safe to run against a live database with no
 * app downtime) — not a raw file copy, which could miss recently-committed
 * data still sitting only in the -wal file.
 *
 * Postgres half shells out to `pg_dump --format=custom`, verified afterward
 * with `pg_restore --list` (parses the archive's table of contents without
 * doing a full restore).
 *
 * Note: pg_dump/pg_restore are not guaranteed to be present in the
 * production container (Railway's default Node build image doesn't ship
 * Postgres client tools) — for now, run this from a machine that has them
 * (e.g. locally, pointed at the production DATABASE_URL/a copied onfleet.db).
 * Adding a postgresql-client build package is a documented follow-up, not
 * built this session.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const doSqlite = !args.includes('--postgres-only');
const doPostgres = !args.includes('--sqlite-only');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(__dirname, '..', 'backups', timestamp);

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fileInfo(filePath) {
  const { size } = fs.statSync(filePath);
  return { path: path.relative(path.join(__dirname, '..'), filePath), bytes: size, sha256: sha256(filePath) };
}

async function backupSqlite() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'onfleet.db');
  if (!fs.existsSync(dbPath)) {
    console.log(`[sqlite] no database file at ${dbPath} — skipping`);
    return null;
  }

  console.log(`[sqlite] backing up ${dbPath} ...`);
  const db = require('../src/db'); // opens (or reuses) the live connection at DB_PATH
  const destPath = path.join(outDir, 'onfleet.db');

  await db.backup(destPath, {
    progress: ({ totalPages, remainingPages }) => {
      process.stdout.write(`\r[sqlite] page ${totalPages - remainingPages}/${totalPages}`);
      return 200; // pages per step
    },
  });
  console.log('\r[sqlite] backup complete            ');

  // Integrity check on the OUTPUT file, not the live one — catches a
  // truncated/corrupt backup immediately rather than at restore time.
  const Database = require('better-sqlite3');
  const check = new Database(destPath, { readonly: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    check.close();
    throw new Error(`[sqlite] backup failed integrity_check: ${integrity}`);
  }
  const tableCounts = {};
  for (const { name } of check.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()) {
    tableCounts[name] = check.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n;
  }
  check.close();
  console.log(`[sqlite] integrity_check: ok — ${Object.keys(tableCounts).length} tables`);

  return { ...fileInfo(destPath), table_row_counts: tableCounts };
}

async function backupPostgres() {
  if (!process.env.DATABASE_URL) {
    console.log('[postgres] DATABASE_URL not set — skipping');
    return null;
  }

  console.log('[postgres] running pg_dump ...');
  const destPath = path.join(outDir, 'tracking.dump');
  try {
    execFileSync('pg_dump', [
      process.env.DATABASE_URL,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file', destPath,
    ], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`[postgres] pg_dump failed — is the postgresql client installed? (${err.message})`);
  }

  console.log('[postgres] verifying archive with pg_restore --list ...');
  const listing = execFileSync('pg_restore', ['--list', destPath], { encoding: 'utf8' });
  const tableLines = listing.split('\n').filter(l => /TABLE DATA/.test(l));
  if (!tableLines.length) throw new Error('[postgres] backup archive has no table data — treating as failed');
  console.log(`[postgres] archive verified — ${tableLines.length} tables with data`);

  const pgDb = require('../src/pgDb');
  const rowCounts = {};
  for (const line of tableLines) {
    const m = line.match(/TABLE DATA \S+ (\S+) /);
    if (!m) continue;
    const table = m[1];
    try {
      const { rows } = await pgDb.query(`SELECT COUNT(*) n FROM "${table}"`);
      rowCounts[table] = Number(rows[0].n);
    } catch { /* best-effort spot-check only */ }
  }

  return { ...fileInfo(destPath), table_row_counts: rowCounts };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Backing up to ${outDir}\n`);

  const manifest = {
    created_at: new Date().toISOString(),
    sqlite: null,
    postgres: null,
  };

  if (doSqlite) manifest.sqlite = await backupSqlite();
  if (doPostgres) manifest.postgres = await backupPostgres();

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to ${path.join(outDir, 'manifest.json')}`);
  console.log('Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('\nBackup failed:', err.message);
  process.exit(1);
});

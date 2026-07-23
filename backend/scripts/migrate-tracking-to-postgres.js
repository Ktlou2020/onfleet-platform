'use strict';

/**
 * One-shot migration: copies all tracking data from SQLite → Postgres,
 * then truncates the SQLite tracking tables and runs VACUUM.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/migrate-tracking-to-postgres.js
 *
 * Safe to re-run: uses ON CONFLICT DO NOTHING so duplicate rows are skipped.
 * Does NOT truncate SQLite until all Postgres inserts succeed.
 */

require('dotenv').config();

const db    = require('../src/db');
const pgDb  = require('../src/pgDb');

const BATCH = 500; // rows per INSERT batch

function rows(table, cols) {
  return db.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
}

async function insertBatched(pgTable, cols, data) {
  if (!data.length) { console.log(`  ${pgTable}: 0 rows (skipped)`); return; }

  let inserted = 0;
  for (let i = 0; i < data.length; i += BATCH) {
    const batch = data.slice(i, i + BATCH);
    const placeholders = batch.map((_, bi) =>
      '(' + cols.map((__, ci) => `$${bi * cols.length + ci + 1}`).join(', ') + ')'
    ).join(', ');
    const values = batch.flatMap(row => cols.map(c => {
      const v = row[c];
      // SQLite stores booleans as 0/1 integers — cast to boolean for Postgres
      if (c === 'connected' || c === 'active' || c === 'inside') return v === 1 || v === true;
      return v ?? null;
    }));
    await pgDb.query(
      `INSERT INTO ${pgTable} (${cols.join(', ')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      values
    );
    inserted += batch.length;
    process.stdout.write(`\r  ${pgTable}: ${inserted}/${data.length} rows`);
  }
  console.log(`\r  ${pgTable}: ${data.length} rows migrated`);
}

async function resetSequence(table, idCol = 'id') {
  await pgDb.query(
    `SELECT setval(pg_get_serial_sequence('${table}', '${idCol}'), COALESCE(MAX(${idCol}), 1)) FROM ${table}`
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  // Run schema to ensure tables exist
  await require('../src/migrations/trackingPgSchema').runTrackingSchema();

  console.log('\n── Migrating tracking data SQLite → Postgres ──\n');

  // ── 1. tracking_devices (no FK deps) ──────────────────────────────────────
  const deviceCols = ['id','imei','model','bike_id','label','firmware_version',
                      'connected','last_seen_at','created_at','updated_at','speed_limit_kmh'];
  await insertBatched('tracking_devices', deviceCols, rows('tracking_devices', deviceCols));
  await resetSequence('tracking_devices');

  // ── 2. geofences (no FK deps) ─────────────────────────────────────────────
  const gfCols = ['id','name','lat','lng','radius_m','bike_id','active','created_by','created_at'];
  await insertBatched('geofences', gfCols, rows('geofences', gfCols));
  await resetSequence('geofences');

  // ── 3. gps_pings (no FK deps, potentially large) ─────────────────────────
  const pingCols = ['id','bike_id','lat','lng','speed_kmh','heading','recorded_at',
                    'satellites','altitude','ignition','io_data'];
  await insertBatched('gps_pings', pingCols, rows('gps_pings', pingCols));
  await resetSequence('gps_pings', 'id');

  // ── 4. trips (no FK deps) ─────────────────────────────────────────────────
  const tripCols = ['id','bike_id','device_id','started_at','ended_at','start_lat','start_lng',
                    'end_lat','end_lng','distance_km','duration_sec','max_speed_kmh','avg_speed_kmh','created_at'];
  await insertBatched('trips', tripCols, rows('trips', tripCols));
  await resetSequence('trips');

  // ── 5. tracking_alerts (no FK deps) ───────────────────────────────────────
  const alertCols = ['id','bike_id','device_id','alert_type','payload','acknowledged_at','created_at'];
  await insertBatched('tracking_alerts', alertCols, rows('tracking_alerts', alertCols));
  await resetSequence('tracking_alerts');

  // ── 6. tracking_commands (FK → tracking_devices) ──────────────────────────
  const cmdCols = ['id','device_id','command','status','response','created_by',
                   'sent_at','responded_at','created_at'];
  await insertBatched('tracking_commands', cmdCols, rows('tracking_commands', cmdCols));
  await resetSequence('tracking_commands');

  // ── 7. geofence_states (FK → geofences, no serial PK) ────────────────────
  const gsCols = ['bike_id','geofence_id','inside','updated_at'];
  await insertBatched('geofence_states', gsCols, rows('geofence_states', gsCols));

  // ── Verify counts match ───────────────────────────────────────────────────
  console.log('\n── Verifying row counts ──\n');
  const tables = ['tracking_devices','gps_pings','tracking_commands',
                  'geofences','geofence_states','trips','tracking_alerts'];
  let allMatch = true;
  for (const t of tables) {
    const sqliteCount = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get().n;
    const { rows: pgRows } = await pgDb.query(`SELECT COUNT(*) as n FROM ${t}`);
    const pgCount = Number(pgRows[0].n);
    const match = sqliteCount === pgCount;
    if (!match) allMatch = false;
    console.log(`  ${t.padEnd(25)} SQLite: ${String(sqliteCount).padStart(8)}  Postgres: ${String(pgCount).padStart(8)}  ${match ? '✓' : '✗ MISMATCH'}`);
  }

  if (!allMatch) {
    console.error('\nMismatch detected — SQLite tables NOT truncated. Fix and re-run.');
    process.exit(1);
  }

  // ── Truncate SQLite tracking tables ───────────────────────────────────────
  console.log('\n── Clearing SQLite tracking tables ──\n');
  for (const t of tables) {
    db.prepare(`DELETE FROM ${t}`).run();
    console.log(`  cleared ${t}`);
  }

  console.log('\n── Running VACUUM on SQLite ──\n');
  db.prepare('VACUUM').run();

  const { size } = require('fs').statSync(require('path').join(__dirname, '../data/onfleet.db'));
  console.log(`  onfleet.db is now ${(size / 1024 / 1024).toFixed(1)} MB\n`);
  console.log('Migration complete.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});

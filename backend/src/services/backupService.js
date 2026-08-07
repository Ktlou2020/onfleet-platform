'use strict';

// Scheduled Postgres backups, written to the same persistent Railway volume
// uploads already live on (survives redeploys, unlike container-local disk).
// Not true off-host disaster-recovery storage — that needs the R2/S3
// migration (still pending, blocked on bucket creation) — but this protects
// against the far more common real-world case: a bad migration, a buggy
// script, or an accidental bulk update corrupting data in place.

const fs = require('fs');
const path = require('path');
const UPLOAD_DIRS = require('../uploadPaths');
const { backupPostgres, fileInfo } = require('../../scripts/backup');

const BACKUP_ROOT = path.join(UPLOAD_DIRS.base, '..', 'backups');
const RETENTION_COUNT = 14; // ~2 weeks of daily backups

function listBackupDirs() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs.readdirSync(BACKUP_ROOT)
    .filter((name) => fs.statSync(path.join(BACKUP_ROOT, name)).isDirectory())
    .sort(); // ISO-ish timestamp names sort chronologically
}

function pruneOldBackups() {
  const dirs = listBackupDirs();
  const toDelete = dirs.slice(0, Math.max(0, dirs.length - RETENTION_COUNT));
  for (const name of toDelete) {
    fs.rmSync(path.join(BACKUP_ROOT, name), { recursive: true, force: true });
    console.log(`[backup] pruned old backup: ${name}`);
  }
}

async function runScheduledBackup() {
  if (!process.env.DATABASE_URL) {
    console.log('[backup] DATABASE_URL not set — skipping scheduled backup');
    return null;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(BACKUP_ROOT, timestamp);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[backup] starting scheduled backup to ${outDir}`);
  const postgres = await backupPostgres(outDir);
  const manifest = { created_at: new Date().toISOString(), postgres };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[backup] scheduled backup complete: ${postgres?.bytes ?? 0} bytes, ${Object.keys(postgres?.table_row_counts || {}).length} tables`);

  pruneOldBackups();
  return manifest;
}

function listBackups() {
  return listBackupDirs().reverse().map((name) => {
    const manifestPath = path.join(BACKUP_ROOT, name, 'manifest.json');
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* unreadable/missing manifest */ }
    return { name, ...manifest };
  });
}

module.exports = { runScheduledBackup, listBackups };

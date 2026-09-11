'use strict';

// Scheduled Postgres backups, written to the same persistent Railway volume
// uploads already live on (survives redeploys, unlike container-local disk).
// Not true off-host disaster-recovery storage — that needs the R2/S3
// migration (still pending, blocked on bucket creation) — but this protects
// against the far more common real-world case: a bad migration, a buggy
// script, or an accidental bulk update corrupting data in place.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// A backup nobody has checked is a guess. Every backup writes a sha256 of its
// dump into the manifest, and until now nothing ever read it back — a dump that
// had been truncated, half-written by a failed run, or deleted out from under
// its manifest still listed as a perfectly good backup, and you would find out
// at restore time, which is the worst possible moment.
//
// The cheap checks run on every listing: the dump has to exist and still be the
// size the manifest claims. That alone catches deletion and truncation, which
// is most of what actually goes wrong. Hashing is not free — 51 MB a file, 14
// files — so the full sha256 comparison is on demand via verifyBackup().
function inspectBackup(name) {
  const dir = path.join(BACKUP_ROOT, name);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { /* unreadable/missing */ }
  if (!manifest) return { name, health: 'no_manifest', issue: 'No manifest — cannot tell what this backup should contain' };

  const rel = manifest.postgres?.path;
  if (!rel) return { name, ...manifest, health: 'no_dump_recorded', issue: 'Manifest records no dump file' };

  // The manifest records the dump's path relative to backend/ (see fileInfo in
  // scripts/backup.js), which is only meaningful from that working directory —
  // and meaningless once BACKUP_ROOT points somewhere else, as it does under
  // test. The dump is always written inside its own backup directory, so find
  // it by name there instead of trying to rebuild someone else's relative path.
  const dumpPath = path.join(BACKUP_ROOT, name, path.basename(rel));
  if (!fs.existsSync(dumpPath)) {
    return { name, ...manifest, health: 'missing', issue: 'The dump this manifest describes is gone' };
  }
  const actualBytes = fs.statSync(dumpPath).size;
  if (manifest.postgres.bytes && actualBytes !== manifest.postgres.bytes) {
    return {
      name, ...manifest, health: 'size_mismatch', actual_bytes: actualBytes,
      issue: `Dump is ${actualBytes} bytes, manifest says ${manifest.postgres.bytes} — likely truncated`,
    };
  }
  return { name, ...manifest, health: 'ok', actual_bytes: actualBytes };
}

function listBackups() {
  const backups = listBackupDirs().reverse().map(inspectBackup);
  const newest = backups[0];
  const ageHours = newest?.created_at
    ? Math.floor((Date.now() - new Date(newest.created_at).getTime()) / 3600000)
    : null;
  return {
    backups,
    summary: {
      count: backups.length,
      damaged: backups.filter((b) => b.health !== 'ok').length,
      latest_at: newest?.created_at || null,
      latest_age_hours: ageHours,
      // Daily at 03:00, so anything past ~36h means a run was missed entirely
      // and nobody was told.
      stale: ageHours === null || ageHours > 36,
    },
  };
}

// Reads the dump back and compares it to the hash recorded when it was written.
// This is the check that would actually catch silent corruption on the volume.
function verifyBackup(name) {
  const info = inspectBackup(name);
  if (info.health !== 'ok') return { ...info, verified: false };

  const dumpPath = path.join(BACKUP_ROOT, name, path.basename(info.postgres.path));
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(dumpPath));
  const actual = hash.digest('hex');
  const match = actual === info.postgres.sha256;

  return {
    ...info,
    verified: match,
    health: match ? 'ok' : 'checksum_mismatch',
    expected_sha256: info.postgres.sha256,
    actual_sha256: actual,
    issue: match ? undefined : 'Contents have changed since this backup was written — do not rely on it',
  };
}

module.exports = { runScheduledBackup, listBackups, verifyBackup };

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// BACKUP_ROOT is derived from UPLOAD_DIR at module load, so point it at a
// throwaway tree before requiring the service.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'onfleet-backups-'));
process.env.UPLOAD_DIR = path.join(ROOT, 'uploads');
const BACKUPS = path.join(ROOT, 'backups');

const { listBackups, verifyBackup } = await import('../src/services/backupService.js');

// Every backup records a sha256 of its dump, and nothing ever read one back. A
// dump that had been truncated, half-written, or deleted out from under its
// manifest still listed as a healthy backup — and you would find out at restore
// time, which is the worst moment to find out.
describe('backup integrity', () => {
  const writeBackup = (name, { bytes = 2048, createdAt = new Date(), corrupt = null, dropDump = false } = {}) => {
    const dir = path.join(BACKUPS, name);
    fs.mkdirSync(dir, { recursive: true });
    const body = Buffer.alloc(bytes, 'x');
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    if (!dropDump) fs.writeFileSync(path.join(dir, 'tracking.dump'), corrupt ?? body);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      created_at: createdAt.toISOString(),
      postgres: { path: `data/backups/${name}/tracking.dump`, bytes, sha256, table_row_counts: { agreements: 439 } },
    }));
    return { sha256, body };
  };

  beforeEach(() => {
    fs.rmSync(BACKUPS, { recursive: true, force: true });
    fs.mkdirSync(BACKUPS, { recursive: true });
  });
  afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('reports a good backup as healthy', () => {
    writeBackup('2026-09-11T03-00-00-000Z');
    const { backups, summary } = listBackups();
    expect(backups[0].health).toBe('ok');
    expect(summary.damaged).toBe(0);
    expect(summary.stale).toBe(false);
  });

  it('catches a dump that has been deleted out from under its manifest', () => {
    writeBackup('2026-09-11T03-00-00-000Z', { dropDump: true });
    const { backups, summary } = listBackups();
    expect(backups[0].health).toBe('missing');
    expect(summary.damaged).toBe(1);
  });

  it('catches a truncated dump without having to hash it', () => {
    writeBackup('2026-09-11T03-00-00-000Z', { bytes: 2048, corrupt: Buffer.alloc(500, 'x') });
    const { backups } = listBackups();
    expect(backups[0].health).toBe('size_mismatch');
    expect(backups[0].actual_bytes).toBe(500);
  });

  it('catches contents that changed while keeping the same size', () => {
    // The case a size check cannot see, and the reason the hash is recorded.
    writeBackup('2026-09-11T03-00-00-000Z', { bytes: 2048, corrupt: Buffer.alloc(2048, 'y') });
    expect(listBackups().backups[0].health).toBe('ok');          // size still matches
    const verified = verifyBackup('2026-09-11T03-00-00-000Z');
    expect(verified.verified).toBe(false);
    expect(verified.health).toBe('checksum_mismatch');
  });

  it('verifies an intact dump against its recorded hash', () => {
    writeBackup('2026-09-11T03-00-00-000Z');
    const verified = verifyBackup('2026-09-11T03-00-00-000Z');
    expect(verified.verified).toBe(true);
    expect(verified.actual_sha256).toBe(verified.expected_sha256);
  });

  it('flags a missed nightly run', () => {
    // Backups run daily at 03:00; past ~36h a run was skipped and nobody said so.
    writeBackup('2026-09-08T03-00-00-000Z', { createdAt: new Date(Date.now() - 50 * 3600 * 1000) });
    const { summary } = listBackups();
    expect(summary.stale).toBe(true);
    expect(summary.latest_age_hours).toBeGreaterThan(36);
  });

  it('reports newest first and counts them', () => {
    writeBackup('2026-09-09T03-00-00-000Z', { createdAt: new Date(Date.now() - 48 * 3600 * 1000) });
    writeBackup('2026-09-11T03-00-00-000Z');
    const { backups, summary } = listBackups();
    expect(summary.count).toBe(2);
    expect(backups[0].name).toBe('2026-09-11T03-00-00-000Z');
  });

  it('does not pretend a backup with no manifest is fine', () => {
    fs.mkdirSync(path.join(BACKUPS, 'half-written'), { recursive: true });
    const { backups, summary } = listBackups();
    expect(backups[0].health).toBe('no_manifest');
    expect(summary.damaged).toBe(1);
  });
});

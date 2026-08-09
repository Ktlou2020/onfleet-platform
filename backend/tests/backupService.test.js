import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// backupService derives its backup directory from UPLOAD_DIR (via
// uploadPaths.js), which is read once at module-load time — must be set
// before the first import of either module in this process.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onfleet-backup-test-'));
process.env.UPLOAD_DIR = path.join(tmpRoot, 'uploads');

describe.skipIf(!process.env.DATABASE_URL)('backupService', () => {
  let runScheduledBackup, listBackups, backupRoot;

  beforeAll(async () => {
    ({ runScheduledBackup, listBackups } = await import('../src/services/backupService.js'));
    backupRoot = path.join(tmpRoot, 'backups');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs a real pg_dump, verifies it, and writes a manifest', async () => {
    const manifest = await runScheduledBackup();
    expect(manifest).not.toBeNull();
    expect(manifest.postgres.bytes).toBeGreaterThan(0);
    expect(Object.keys(manifest.postgres.table_row_counts).length).toBeGreaterThan(0);
    expect(manifest.postgres.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('lists backups newest-first', async () => {
    const before = await runScheduledBackup();
    await new Promise((r) => setTimeout(r, 1100)); // ensure a distinct timestamp-named directory
    const after = await runScheduledBackup();

    const backups = listBackups();
    expect(backups.length).toBeGreaterThanOrEqual(2);
    expect(backups[0].postgres.sha256).toBe(after.postgres.sha256);
  });

  it('prunes backups beyond the retention count', async () => {
    fs.mkdirSync(backupRoot, { recursive: true });
    // Fabricate 20 old backup directories (cheaper than 20 real pg_dumps) —
    // names sort chronologically like the real timestamp-named ones.
    for (let i = 0; i < 20; i++) {
      const name = `2020-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z`;
      const dir = path.join(backupRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ created_at: name, postgres: { bytes: 1 } }));
    }

    await runScheduledBackup(); // triggers pruneOldBackups() as a side effect

    const remaining = fs.readdirSync(backupRoot).filter((n) => fs.statSync(path.join(backupRoot, n)).isDirectory());
    expect(remaining.length).toBe(14); // RETENTION_COUNT
    // The oldest fabricated dirs should be the ones pruned, not the newest real backup
    expect(remaining).not.toContain('2020-01-01T00-00-00-000Z');
  });
});

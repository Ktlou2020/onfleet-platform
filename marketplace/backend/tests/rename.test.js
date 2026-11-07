import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../src/db');

describe('renaming the platform to ClickNPuff', () => {
  it('moves accounts on the old demo domain and leaves everyone else alone', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-')), 'old.db');
    const db = open(file);
    const add = db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?, 'x', ?, 'customer')");
    add.run('customer@cloud9.africa', 'Old Demo');
    add.run('real.person@gmail.com', 'Real Person');
    add.run('dup@cloud9.africa', 'Would clash');
    add.run('dup@clicknpuff.africa', 'Already here');
    db.prepare("UPDATE users SET email = 'customer@cloud9.africa' WHERE email = 'customer@clicknpuff.africa'").run();
    db.close();

    const again = open(file); // the upgrade runs on open
    const emails = again.prepare('SELECT email FROM users ORDER BY id').all().map((r) => r.email);
    expect(emails).toEqual(['customer@clicknpuff.africa', 'real.person@gmail.com', 'dup@cloud9.africa', 'dup@clicknpuff.africa']);
    again.close();
  });
});

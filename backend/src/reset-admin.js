const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/onfleet.db');
const db = new Database(dbPath);

const email = (process.argv[2] || process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
const password = (process.argv[3] || process.env.SUPERADMIN_PASSWORD || '').trim();
const fullName = (process.argv[4] || process.env.SUPERADMIN_FULL_NAME || 'OnFleet Platform Super User').trim();
const phone = (process.argv[5] || process.env.SUPERADMIN_PHONE || '').trim() || null;

if (!email || !password) {
  console.error('❌ Missing superadmin credentials. Provide email/password via args or SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);

try {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare(`UPDATE users
      SET password_hash = ?, full_name = ?, phone = ?, role = 'superadmin', status = 'active', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(hash, fullName, phone, existing.id);
    console.log(`✅ Superadmin updated: ${email}`);
  } else {
    db.prepare(`INSERT INTO users (email, phone, password_hash, full_name, role, status)
      VALUES (?, ?, ?, ?, 'superadmin', 'active')`).run(email, phone, hash, fullName);
    console.log(`✅ Superadmin created: ${email}`);
  }
} catch (err) {
  console.error('❌ Error ensuring superadmin:', err.message);
  process.exitCode = 1;
} finally {
  db.close();
}

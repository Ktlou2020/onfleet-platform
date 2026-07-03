const bcrypt = require('bcryptjs');
const db = require('../db');

function clean(value) {
  return String(value || '').trim();
}

function ensureSuperadminFromEnv() {
  const email = clean(process.env.SUPERADMIN_EMAIL).toLowerCase();
  const password = clean(process.env.SUPERADMIN_PASSWORD);
  const fullName = clean(process.env.SUPERADMIN_FULL_NAME);
  const phone = clean(process.env.SUPERADMIN_PHONE);

  if (!email) return { skipped: true, reason: 'SUPERADMIN_EMAIL not set' };
  if (!password) return { skipped: true, reason: 'SUPERADMIN_PASSWORD not set' };

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  if (existing) {
    return { created: false, email };
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (email, phone, password_hash, full_name, role, status)
    VALUES (?, ?, ?, ?, 'superadmin', 'active')`).run(email, phone || null, passwordHash, fullName || email);
  return { created: true, email };
}

module.exports = { ensureSuperadminFromEnv };

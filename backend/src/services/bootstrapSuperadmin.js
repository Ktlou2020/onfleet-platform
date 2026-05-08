const bcrypt = require('bcryptjs');
const db = require('../db');

function clean(value) {
  return String(value || '').trim();
}

function ensureSuperadminFromEnv() {
  const email = clean(process.env.SUPERADMIN_EMAIL).toLowerCase();
  const password = clean(process.env.SUPERADMIN_PASSWORD);
  const fullName = clean(process.env.SUPERADMIN_FULL_NAME) || 'OnFleet Platform Super User';
  const phone = clean(process.env.SUPERADMIN_PHONE) || null;

  if (!email || !password) {
    return { skipped: true, reason: 'SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD not set' };
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  if (existing) {
    db.prepare(`UPDATE users
      SET password_hash = ?, full_name = ?, phone = ?, role = 'superadmin', status = 'active', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(passwordHash, fullName, phone, existing.id);
    return { created: false, email };
  }

  db.prepare(`INSERT INTO users (email, phone, password_hash, full_name, role, status)
    VALUES (?, ?, ?, ?, 'superadmin', 'active')`).run(email, phone, passwordHash, fullName);
  return { created: true, email };
}

module.exports = { ensureSuperadminFromEnv };

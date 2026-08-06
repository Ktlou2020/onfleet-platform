const bcrypt = require('bcryptjs');
const pgDb = require('../pgDb');

function clean(value) {
  return String(value || '').trim();
}

async function ensureSuperadminFromEnv() {
  const email = clean(process.env.SUPERADMIN_EMAIL).toLowerCase();
  const password = clean(process.env.SUPERADMIN_PASSWORD);
  const fullName = clean(process.env.SUPERADMIN_FULL_NAME);
  const phone = clean(process.env.SUPERADMIN_PHONE);

  if (!email) return { skipped: true, reason: 'SUPERADMIN_EMAIL not set' };
  if (!password) return { skipped: true, reason: 'SUPERADMIN_PASSWORD not set' };

  const { rows } = await pgDb.query('SELECT id FROM users WHERE email = $1', [email]);

  if (rows[0]) {
    return { created: false, email };
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  await pgDb.query(
    `INSERT INTO users (email, phone, password_hash, full_name, role, status)
     VALUES ($1, $2, $3, $4, 'superadmin', 'active')`,
    [email, phone || null, passwordHash, fullName || email]
  );
  return { created: true, email };
}

module.exports = { ensureSuperadminFromEnv };

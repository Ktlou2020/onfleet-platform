const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/onfleet.db');
const db = new Database(dbPath);

const email = 'admin@onfleet.africa';
const password = 'OnfleetAdmin2026!'; 
const hash = bcrypt.hashSync(password, 10);

try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
        // Fix: Use single quotes for string literals in the SQL command
        db.prepare("UPDATE users SET password_hash = ?, role = 'superadmin', status = 'active' WHERE id = ?")
          .run(hash, existing.id);
        console.log(`✅ Password updated for existing user: ${email}`);
    } else {
        db.prepare("INSERT INTO users (email, password_hash, full_name, role, status) VALUES (?, ?, 'OnFleet Admin', 'superadmin', 'active')")
          .run(email, hash);
        console.log(`✅ New admin user created: ${email}`);
    }
    console.log(`🚀 Final Credentials:\n   Email: ${email}\n   Password: ${password}`);
} catch (err) {
    console.error('❌ Error updating admin:', err.message);
} finally {
    db.close();
}

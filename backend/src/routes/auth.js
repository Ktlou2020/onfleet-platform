const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

router.post('/signup',
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  body('full_name').notEmpty(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, full_name, phone, id_number, address, city, province, postal_code,
            date_of_birth, emergency_contact_name, emergency_contact_phone } = req.body;

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`INSERT INTO users
      (email, password_hash, full_name, phone, id_number, address, city, province, postal_code,
       date_of_birth, emergency_contact_name, emergency_contact_phone, role)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'rider')`).run(
        email.toLowerCase(), hash, full_name, phone || null, id_number || null,
        address || null, city || null, province || null, postal_code || null,
        date_of_birth || null, emergency_contact_name || null, emergency_contact_phone || null
      );

    const user = db.prepare('SELECT id, email, full_name, role FROM users WHERE id = ?').get(info.lastInsertRowid);
    logAudit(user.id, 'user.signup', 'users', user.id, { email }, req.ip);
    res.json({ token: signToken(user), user });
  });

router.post('/login',
  body('email').isEmail(),
  body('password').notEmpty(),
  (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

    logAudit(user.id, 'user.login', 'users', user.id, {}, req.ip);
    const safe = { id: user.id, email: user.email, full_name: user.full_name, role: user.role };
    res.json({ token: signToken(safe), user: safe });
  });

router.get('/me', authRequired, (req, res) => {
  const u = db.prepare(`SELECT id, email, full_name, phone, role, status, id_number, date_of_birth,
                        address, city, province, postal_code, emergency_contact_name,
                        emergency_contact_phone, avatar_url, created_at
                        FROM users WHERE id = ?`).get(req.user.id);
  res.json({ user: u });
});

router.put('/me', authRequired, (req, res) => {
  const fields = ['full_name','phone','id_number','date_of_birth','address','city','province',
                  'postal_code','emergency_contact_name','emergency_contact_phone','avatar_url'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.json({ ok: true });
  values.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.post('/change-password', authRequired,
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 6 }),
  (req, res) => {
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(req.body.current_password, u.password_hash)) {
      return res.status(400).json({ error: 'Current password incorrect' });
    }
    const hash = bcrypt.hashSync(req.body.new_password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ ok: true });
  });

module.exports = router;

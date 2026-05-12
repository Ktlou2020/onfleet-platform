const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, fleetOwnerOnly, companyRoleAllowed } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');

const router = express.Router();
const FLEET_ROLE_VALUES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];
const MEMBER_STATUSES = ['active', 'suspended'];

router.use(authRequired, fleetOwnerOnly);

router.get('/account', (req, res) => {
  const organization = db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(req.user.organization_id);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });

  const members = db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at
    FROM users
    WHERE organization_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC`).all(req.user.organization_id);

  res.json({ organization, members });
});

router.post('/team-members', companyRoleAllowed(['fleet_owner_admin']), (req, res) => {
  const full_name = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const phone = String(req.body.phone || '').trim();
  const city = String(req.body.city || '').trim();
  const role = String(req.body.role || 'fleet_owner_viewer').trim();

  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'Full name, email, and password are required' });
  }
  if (!email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!FLEET_ROLE_VALUES.includes(role)) return res.status(400).json({ error: 'Invalid fleet-owner role' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const organization = db.prepare(`SELECT id, max_admin_users FROM organizations WHERE id = ?`).get(req.user.organization_id);
  const adminRoles = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'];
  const isAdminSeat = adminRoles.includes(role);
  if (isAdminSeat) {
    const usedSeats = db.prepare(`SELECT COUNT(*) c FROM users
      WHERE organization_id = ? AND deleted_at IS NULL AND role IN ('fleet_owner_admin','fleet_owner_ops','fleet_owner_billing')`).get(req.user.organization_id).c;
    if (usedSeats >= Number(organization?.max_admin_users || 0)) {
      return res.status(400).json({ error: 'Plan admin-seat limit reached for this organization' });
    }
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`INSERT INTO users
    (email, password_hash, full_name, phone, city, role, organization_id, status)
    VALUES (?,?,?,?,?,?,?, 'active')`).run(
      email,
      password_hash,
      full_name,
      phone || null,
      city || null,
      role,
      req.user.organization_id
    );

  logAudit(req.user.id, 'fleet_owner.team_member_create', 'users', info.lastInsertRowid, { role, organization_id: req.user.organization_id }, req.ip);
  const member = db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at FROM users WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, member });
});

router.patch('/team-members/:id', companyRoleAllowed(['fleet_owner_admin']), (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'Invalid team member id' });

  const member = db.prepare(`SELECT id, role, status, organization_id FROM users WHERE id = ? AND deleted_at IS NULL`).get(memberId);
  if (!member || member.organization_id !== req.user.organization_id) {
    return res.status(404).json({ error: 'Team member not found' });
  }
  if (member.id === req.user.id && req.body.status === 'suspended') {
    return res.status(400).json({ error: 'You cannot suspend your own account' });
  }

  const nextRole = req.body.role === undefined ? member.role : String(req.body.role).trim();
  const nextStatus = req.body.status === undefined ? member.status : String(req.body.status).trim();
  if (!FLEET_ROLE_VALUES.includes(nextRole)) return res.status(400).json({ error: 'Invalid role value' });
  if (!MEMBER_STATUSES.includes(nextStatus)) return res.status(400).json({ error: 'Invalid status value' });

  db.prepare(`UPDATE users SET role = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nextRole, nextStatus, memberId);
  logAudit(req.user.id, 'fleet_owner.team_member_update', 'users', memberId, {
    previous_role: member.role,
    next_role: nextRole,
    previous_status: member.status,
    next_status: nextStatus
  }, req.ip);

  const updated = db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at FROM users WHERE id = ?`).get(memberId);
  res.json({ ok: true, member: updated });
});

module.exports = router;

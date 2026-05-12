const jwt = require('jsonwebtoken');
const db = require('../db');

const FLEET_OWNER_ROLES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare(`SELECT u.id, u.email, u.full_name, u.role, u.status, u.organization_id,
      o.name organization_name, o.status organization_status, o.plan_key organization_plan_key,
      o.trial_ends_at organization_trial_ends_at
      FROM users u
      LEFT JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = ? AND u.deleted_at IS NULL`).get(payload.uid);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Invalid user' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function fleetOwnerOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (!FLEET_OWNER_ROLES.includes(req.user.role) || !req.user.organization_id) {
    return res.status(403).json({ error: 'Fleet-owner access required' });
  }
  next();
}

function companyRoleAllowed(roles = []) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!FLEET_OWNER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Fleet-owner access required' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    next();
  };
}

module.exports = { authRequired, adminOnly, fleetOwnerOnly, companyRoleAllowed, FLEET_OWNER_ROLES };

const jwt = require('jsonwebtoken');
const pgDb = require('../pgDb');
const { brand, CONSOLES } = require('../brand');

const FLEET_OWNER_ROLES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];

// Where a telematics operator's admin account stops.
//
// On a deployment that sells the platform rather than running motorcycles, a
// tenant's applications, agreements, rider payments, claims, KYC files,
// workshop and CSV imports are that tenant's operating records. The console
// already leaves them off the menu, but a menu is not a boundary: the pages
// were one typed URL away, and an admin working in them could act on the
// wrong fleet's data without ever seeing whose it was.
//
// Supporting a customer means stepping into their account through
// impersonation, which is deliberate, scoped to one fleet, and says so across
// the top of every screen. This makes that the only way in.
//
// An impersonating admin is carrying the tenant's own role by then, not
// admin, so they pass through this untouched — which is the point.
//
// Three things this deliberately does not touch:
//
//   riders and fleet owners  they never pass through an admin guard, so
//                            /agreements/mine and the whole fleet portal are
//                            exactly as they were. This refuses a platform
//                            admin, not a tenant.
//   /api/bikes               a device is fitted to a motorcycle, so the
//                            telematics console needs to read bikes to
//                            commission one. The Bikes *page* is off the
//                            menu; the bike records behind tracking stay.
//   /api/admin               that router is this console's own API. Splitting
//                            it is a separate job, and it is named for what
//                            it is rather than looking like a tenant's screen.
const TENANT_OPERATING_PATHS = [
  '/api/applications',
  '/api/agreements',
  '/api/payments',
  '/api/claims',
  '/api/kyc',
  '/api/imports',
  '/api/workshop',

  // And the parts of /api/admin that are a customer's business rather than
  // the console's.
  //
  // That router was left whole when this boundary went in, on the grounds
  // that it is the console's own API. Most of it is: who may log in, what
  // they are billed, which devices are fitted, what the audit trail says.
  // The line runs between administering an account and reading what the
  // account does with the platform —
  //
  //   /admin/users          stays. Who can sign in, with what role, and
  //                         whether they are suspended is the operator's job
  //                         on any deployment.
  //   /admin/fleet-owners   stays, and so do plans, wallets, payouts and the
  //   /admin/organizations  Paystack routes: that is the customer
  //                         relationship, which is the whole console.
  //
  // — and the records below are on the tenant's side of it. Most have never
  // appeared on a telematics menu; two were reachable because the console's
  // own pages used them for a job that only makes sense on OnFleet, where the
  // operator is also the lessor collecting the rider's money.
  '/api/admin/agreement-schedule',
  '/api/admin/org-agreements',
  '/api/admin/record-paystack-payment',
  '/api/admin/riders',
  '/api/admin/applications',
  '/api/admin/signup-stats',
  '/api/admin/strategy-report',
  '/api/admin/dashboard',
  '/api/admin/kpis',
  '/api/admin/reports',
  '/api/admin/parts-catalog',
  '/api/admin/parts-orders',
];

const isTelematicsDeployment = brand.adminConsole === CONSOLES.TELEMATICS;

/** The refusal to send a platform admin reaching into a tenant's records, or null. */
function offThisConsole(req) {
  if (!isTelematicsDeployment) return null;
  if (!['admin', 'superadmin'].includes(req.user?.role)) return null;
  const path = String(req.originalUrl || '').split('?')[0];
  if (!TENANT_OPERATING_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return null;
  return {
    error: 'That belongs to a fleet, not to this console. Open the fleet\'s account to work in it.',
    code: 'NOT_THIS_CONSOLE',
  };
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const { rows } = await pgDb.query(`SELECT u.id, u.email, u.full_name, u.role, u.status, u.organization_id,
      o.name organization_name, o.status organization_status, o.plan_key organization_plan_key,
      o.trial_ends_at organization_trial_ends_at
      FROM users u
      LEFT JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`, [payload.uid]);
    const user = rows[0];
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Invalid user' });
    req.user = user;
    if (payload.impersonated_by) {
      req.user = { ...user, is_impersonated: true, impersonated_by: payload.impersonated_by };
    }

    // Checked here rather than on adminOnly because adminOnly is not the only
    // door: several of these routes take any authenticated caller and branch
    // on the role inside — GET /agreements/:id hands an admin the whole
    // bundle, schedule, payments and documents included. This is the one
    // place every authenticated request passes through.
    const refusal = offThisConsole(req);
    if (refusal) return res.status(403).json(refusal);

    next();
  } catch {
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

// Read-only tracking access: admins + control room operators
function trackingReadOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (!['admin', 'superadmin', 'control_room'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
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

// The workshop floor. Admins are included because the admin portal's Workshop
// pages drive the same endpoints, and technicians have no organisation — the
// workshop services every fleet's bikes, so it is a single global tenant.
const WORKSHOP_ROLES = ['technician', 'admin', 'superadmin'];

function workshopOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (!WORKSHOP_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Workshop access required' });
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

module.exports = {
  authRequired, adminOnly, trackingReadOnly, fleetOwnerOnly, workshopOnly,
  companyRoleAllowed, FLEET_OWNER_ROLES, WORKSHOP_ROLES,
  offThisConsole, TENANT_OPERATING_PATHS,
};

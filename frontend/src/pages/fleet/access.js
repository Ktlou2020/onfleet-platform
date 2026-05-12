export const ADMIN_PORTAL_ROLES = ['admin', 'superadmin'];
export const FLEET_OWNER_ROLES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];

export const FLEET_ROLE_LABELS = {
  fleet_owner_admin: 'Company admin',
  fleet_owner_ops: 'Operations lead',
  fleet_owner_billing: 'Billing lead',
  fleet_owner_viewer: 'Viewer'
};

export const FLEET_RESOURCE_ACCESS = {
  dashboard: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'],
    manage: []
  },
  bikes: {
    view: ['fleet_owner_admin', 'fleet_owner_ops'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  agreements: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  payments: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing']
  },
  riders: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  help: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'],
    manage: []
  }
};

export const FLEET_NAV_ITEMS = [
  { key: 'dashboard', to: '/fleet/app', label: 'Dashboard' },
  { key: 'bikes', to: '/fleet/app/bikes', label: 'Bikes Fleet' },
  { key: 'agreements', to: '/fleet/app/agreements', label: 'Agreements' },
  { key: 'payments', to: '/fleet/app/payments', label: 'Payments' },
  { key: 'riders', to: '/fleet/app/riders', label: 'Riders' },
  { key: 'help', to: '/fleet/app/help', label: 'Help' }
];

export function isAdminPortalRole(role) {
  return ADMIN_PORTAL_ROLES.includes(role);
}

export function isFleetOwnerRole(role) {
  return FLEET_OWNER_ROLES.includes(role);
}

export function getFleetRoleLabel(role) {
  return FLEET_ROLE_LABELS[role] || String(role || '').replace(/_/g, ' ');
}

export function canViewFleetSection(role, sectionKey) {
  return (FLEET_RESOURCE_ACCESS[sectionKey]?.view || []).includes(role);
}

export function canManageFleetSection(role, sectionKey) {
  return (FLEET_RESOURCE_ACCESS[sectionKey]?.manage || []).includes(role);
}

export function canAccessFleetRoute(role, routeKey) {
  return canViewFleetSection(role, routeKey);
}

export function getDefaultFleetRoute(role) {
  const firstAllowed = FLEET_NAV_ITEMS.find((item) => canViewFleetSection(role, item.key));
  return firstAllowed?.to || '/fleet/app';
}

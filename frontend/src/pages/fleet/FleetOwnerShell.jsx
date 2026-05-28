import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Bike, FileText, CreditCard, HelpCircle, LogOut, Users, Wallet, AlertTriangle } from 'lucide-react';
import Logo from '../../components/Logo';
import { SearchInput, matchesSearch } from '../../components/ui';
import { useAuth } from '../../auth';
import { FLEET_NAV_ITEMS, canAccessFleetRoute, getFleetRoleLabel } from './access';
import api from '../../api';

const navIconMap = {
  dashboard: LayoutDashboard,
  bikes: Bike,
  agreements: FileText,
  payments: CreditCard,
  riders: Users,
  billing: Wallet,
  help: HelpCircle
};

const BLOCKED_STATUSES = ['past_due', 'suspended', 'cancelled'];

function SubscriptionGate({ status, canOpenBilling, onGoToBilling }) {
  const messages = {
    past_due: { heading: 'Trial ended — subscription required', body: 'Your free trial has expired. Choose a plan to keep accessing the fleet portal.' },
    suspended: { heading: 'Account suspended', body: 'Your subscription payment failed. Update your payment method to restore access.' },
    cancelled: { heading: 'Subscription cancelled', body: 'Your subscription has been cancelled. Choose a plan to regain access.' },
  };
  const { heading, body } = messages[status] || { heading: 'Subscription required', body: 'Please subscribe to continue.' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 24, padding: 32, textAlign: 'center' }}>
      <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(239,68,68,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AlertTriangle size={30} style={{ color: 'var(--danger)' }} />
      </div>
      <div>
        <h2 style={{ marginBottom: 8 }}>{heading}</h2>
        <p className="muted" style={{ maxWidth: 400 }}>{body}</p>
      </div>
      {canOpenBilling ? (
        <button className="btn" onClick={onGoToBilling} style={{ minWidth: 160 }}>
          <Wallet size={15} /> View Plans &amp; Subscribe
        </button>
      ) : (
        <p className="muted text-sm">Contact your account administrator to reactivate this account.</p>
      )}
    </div>
  );
}

export default function FleetOwnerShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [orgStatus, setOrgStatus] = useState(null);
  const [statusLoaded, setStatusLoaded] = useState(false);

  const canOpenBilling = canAccessFleetRoute(user?.role, 'billing');
  const onBillingPage = location.pathname.endsWith('/billing');

  useEffect(() => {
    api.get('/fleet/billing/status')
      .then((r) => { setOrgStatus(r.data.organization?.status ?? null); })
      .catch(() => { setOrgStatus(null); })
      .finally(() => setStatusLoaded(true));
  }, [location.pathname]);

  const allowedNav = useMemo(() => FLEET_NAV_ITEMS.filter((item) => canAccessFleetRoute(user?.role, item.key)), [user?.role]);
  const filteredNav = useMemo(() => allowedNav.filter((item) => matchesSearch(search, item.label, item.to)), [allowedNav, search]);

  const goToFirstMatch = (event) => {
    if (event.key === 'Enter' && filteredNav[0]) {
      event.preventDefault();
      nav(filteredNav[0].to);
      setSearch('');
    }
  };

  const isBlocked = statusLoaded && BLOCKED_STATUSES.includes(orgStatus) && !onBillingPage;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px 24px' }}>
          <Logo />
          <span className="badge badge-info" style={{ fontSize: 9 }}>FLEET</span>
        </div>
        <nav>
          {allowedNav.map((item) => {
            const Icon = navIconMap[item.key] || LayoutDashboard;
            return <NavLink key={item.to} to={item.to} end={item.to === '/fleet/app'}><Icon size={16} /> {item.label}</NavLink>;
          })}
        </nav>
        <div className="user-mini">
          <div className="avatar">{user?.full_name?.[0]}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
            <div className="text-xs muted">{getFleetRoleLabel(user?.role)}</div>
          </div>
          <button onClick={() => { logout(); nav('/fleet/login'); }} title="Log out" style={{ background: 'transparent', color: 'var(--muted)', padding: 8, border: 'none' }}><LogOut size={16} /></button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar" style={{ gap: 16 }}>
          <div className="text-sm muted">Fleet Owner Console · OnFleet Africa</div>
          <div style={{ position: 'relative', width: 'min(520px, 100%)', marginLeft: 'auto' }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search fleet tabs, including Help" inputProps={{ onKeyDown: goToFirstMatch }} style={{ width: '100%' }} />
            {!!search && (
              <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: '100%', zIndex: 20, padding: 12 }}>
                {filteredNav.length ? filteredNav.map((item) => {
                  const Icon = navIconMap[item.key] || LayoutDashboard;
                  return <button key={item.to} className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 8 }} onClick={() => { nav(item.to); setSearch(''); }}><Icon size={14} /> {item.label}</button>;
                }) : <div className="muted text-sm">No fleet tabs match your search.</div>}
              </div>
            )}
          </div>
          <div className="text-xs muted">Logged in as <strong>{user?.email}</strong></div>
        </div>
        <div className="content">
          {isBlocked ? (
            <SubscriptionGate
              status={orgStatus}
              canOpenBilling={canOpenBilling}
              onGoToBilling={() => nav('/fleet/app/billing')}
            />
          ) : (
            <Outlet />
          )}
        </div>
      </div>
    </div>
  );
}

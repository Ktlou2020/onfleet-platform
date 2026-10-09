import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Bike, FileText, CreditCard, HelpCircle, LogOut, Users, Wallet, AlertTriangle, PiggyBank, AlertCircle, MapPin, Navigation, Key, Clock, X, MoreHorizontal, BarChart2, UserCog, Eye, Lock, Wrench, ClipboardList, Siren, History } from 'lucide-react';
import Logo from '../../components/Logo';
import { SearchInput, matchesSearch } from '../../components/ui';
import { useAuth } from '../../auth';
import { FLEET_NAV_ITEMS, canAccessFleetRoute, getFleetRoleLabel } from './access';
import api from '../../api';

const navIconMap = {
  dashboard: LayoutDashboard,
  bikes: Bike,
  // Not MapPin: that is Hubs. This map already had `tracking: MapPin` further
  // down, which would have won on the duplicate key and shown the same glyph
  // twice — the exact thing the note below records happening before.
  tracking: Navigation,
  agreements: FileText,
  payments: CreditCard,
  riders: Users,
  collections: AlertCircle,
  hubs: MapPin,
  wallet: PiggyBank,
  billing: Wallet,
  api_keys: Key,
  reporting: BarChart2,
  team: UserCog,
  help: HelpCircle,
  // The four added when fleet owners gained what the admin portal had. Every
  // one of them was falling through to the dashboard icon, so the menu showed
  // the same glyph five times.
  workshop: Wrench,
  applications: ClipboardList,
  security: Siren,
  activity: History,
};

const BLOCKED_STATUSES = ['past_due', 'suspended', 'cancelled'];

function SubscriptionGate({ billingData }) {
  const { logout } = useAuth();
  const nav = useNavigate();

  const org = billingData?.organization;
  const status = org?.status;

  const headings = {
    past_due:  'Your free trial has ended',
    suspended: 'Payment failed — access paused',
    cancelled: 'Subscription cancelled',
  };
  const sublines = {
    past_due:  'Choose a plan to restore full access. Pricing is per bike, so what you pay follows the size of your fleet.',
    suspended: 'Your last payment was not collected. Nothing has been deleted — settle it and access comes straight back.',
    cancelled: 'Your subscription was cancelled. Choose a plan to regain access.',
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: '32px 16px'
    }}>
      <div style={{ marginBottom: 32 }}><Logo size="lg" /></div>

      <div style={{ maxWidth: 640, width: '100%', textAlign: 'center', marginBottom: 32 }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'rgba(239,68,68,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px'
        }}>
          <AlertTriangle size={26} style={{ color: 'var(--danger)' }} />
        </div>
        <h2 style={{ marginBottom: 10, fontSize: 22 }}>{headings[status] || 'Subscription required'}</h2>
        <p className="muted" style={{ maxWidth: 480, margin: '0 auto' }}>
          {sublines[status] || 'Please choose a plan to continue.'}
        </p>
      </div>

      {/* This used to show the flat plan cards and post straight to
          /billing/subscribe. That endpoint is gone, so the buttons would
          have failed; and the plans it sold were the ones that left paying
          customers on the Basic feature set. One way out now, to the page
          that actually prices and charges. */}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button className="btn" onClick={() => nav('/fleet/app/subscription')}>
          {status === 'suspended' ? 'Settle and restore access' : 'Choose a plan'}
        </button>
        <button className="btn btn-secondary" onClick={logout}>Sign out</button>
      </div>

      <p className="muted text-sm" style={{ marginTop: 20, maxWidth: 420, textAlign: 'center' }}>
        Nothing has been deleted. Your bikes, riders and history are exactly where you left them.
      </p>
    </div>
  );
}
function TrialBanner({ daysLeft, onSubscribe, onDismiss }) {
  const urgent = daysLeft <= 3;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '7px 16px',
      background: urgent ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.1)',
      borderBottom: `1px solid ${urgent ? 'rgba(239,68,68,0.25)' : 'rgba(245,158,11,0.25)'}`,
      fontSize: 13
    }}>
      <Clock size={14} style={{ color: urgent ? 'var(--danger)' : 'var(--warn)', flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        <strong>{daysLeft === 0 ? 'Trial expires today' : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left on your free trial`}</strong>
        {' — add your card now so there’s no interruption when it ends.'}
      </span>
      <button className="btn btn-sm" onClick={onSubscribe} style={{ flexShrink: 0, fontSize: 12 }}>
        Add payment method
      </button>
      <button onClick={onDismiss} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 2, flexShrink: 0 }}>
        <X size={14} />
      </button>
    </div>
  );
}

export default function FleetOwnerShell() {
  const { user, logout, isImpersonating, exitImpersonation } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [billingData, setBillingData] = useState(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // The one page a blocked account may still reach, so it can pay its way
  // out. It has to list every path that can take money: billing now
  // redirects to subscription, and if only '/billing' were exempt the
  // redirect would land the customer back in this gate with no way through.
  const onBillingPage = ['/billing', '/subscription']
    .some((path) => location.pathname.endsWith(path));

  const loadBilling = useCallback(() => {
    api.get('/fleet/billing/status')
      .then((r) => setBillingData(r.data))
      .catch(() => setBillingData({ organization: { status: 'past_due' }, plans: [], can_subscribe: true }))
      .finally(() => setStatusLoaded(true));
  }, []);

  useEffect(() => { loadBilling(); }, [location.pathname]);

  const org = billingData?.organization;
  const orgStatus = org?.status ?? null;
  const trialDaysLeft = org?.trial_days_left ?? null;
  const showTrialBanner = !bannerDismissed
    && orgStatus === 'trialing'
    && trialDaysLeft !== null
    && trialDaysLeft <= 7;

  // Two different reasons a section might not be available, and they are not
  // the same thing to a fleet owner. A role they do not have is somebody
  // else's job and is simply absent. A section their plan does not include is
  // something they could have, so it stays on the menu with a padlock — a
  // customer who cannot see the workshop cannot decide to pay for it.
  const lockedSections = useMemo(() => {
    const locked = billingData?.tier?.locked || [];
    return new Map(locked.map((l) => [l.section, l.requires]));
  }, [billingData]);

  const allowedNav = useMemo(
    () => FLEET_NAV_ITEMS
      .filter((item) => canAccessFleetRoute(user?.role, item.key))
      .map((item) => ({ ...item, lockedBehind: lockedSections.get(item.key) || null })),
    [user?.role, lockedSections]);
  const filteredNav = useMemo(() => allowedNav.filter((item) => matchesSearch(search, item.label, item.to)), [allowedNav, search]);

  const goToFirstMatch = (event) => {
    if (event.key === 'Enter' && filteredNav[0]) {
      event.preventDefault();
      nav(filteredNav[0].to);
      setSearch('');
    }
  };

  const isBlocked = statusLoaded && BLOCKED_STATUSES.includes(orgStatus) && !onBillingPage && !isImpersonating;

  if (isBlocked) {
    return <SubscriptionGate billingData={billingData} />;
  }

  return (
    <div className="app-shell">
      {isImpersonating && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: '#b45309', color: '#fff',
          padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 13, fontWeight: 600, boxShadow: '0 2px 8px rgba(0,0,0,.25)'
        }}>
          <Eye size={15} />
          Superadmin impersonating <strong style={{ marginLeft: 2 }}>{user?.organization_name || user?.full_name}</strong>
          <span style={{ marginLeft: 'auto' }}>
            <button
              onClick={exitImpersonation}
              style={{
                background: 'rgba(255,255,255,.2)', border: 'none', color: '#fff',
                borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              Exit impersonation
            </button>
          </span>
        </div>
      )}
      <aside className="sidebar" style={isImpersonating ? { paddingTop: 40 } : undefined}>
        <div style={{ padding: '0 8px 24px' }}>
          <Logo />
        </div>
        <nav>
          {allowedNav.map((item) => {
            const Icon = navIconMap[item.key] || LayoutDashboard;
            // A locked section still links to Billing rather than to itself:
            // clicking it should lead somewhere useful, not to a page that
            // refuses. The padlock says why.
            if (item.lockedBehind) {
              return (
                <NavLink
                  key={item.to}
                  to="/fleet/app/billing"
                  style={{ opacity: 0.55 }}
                  title={`${item.label} is part of the ${item.lockedBehind} plan`}
                >
                  <Icon size={16} /> {item.label}
                  <Lock size={12} style={{ marginLeft: 'auto', flexShrink: 0 }} />
                </NavLink>
              );
            }
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
      {/* Mobile bottom nav — primary 4 items + More drawer */}
      <nav className="mobile-bottom-nav">
        {allowedNav.slice(0, 4).map((item) => {
          const Icon = navIconMap[item.key] || LayoutDashboard;
          return (
            <NavLink key={item.to} to={item.to} end={item.to === '/fleet/app'} onClick={() => setMoreOpen(false)}>
              <Icon size={20} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
        {allowedNav.length > 4 && (
          <button
            className={`mobile-more-btn${moreOpen ? ' active' : ''}`}
            onClick={() => setMoreOpen((o) => !o)}
            aria-label="More navigation options"
          >
            <MoreHorizontal size={20} />
            <span>More</span>
          </button>
        )}
      </nav>

      {/* More drawer — slide-up sheet with all remaining nav items */}
      {moreOpen && (
        <div className="mobile-more-overlay" onClick={() => setMoreOpen(false)}>
          <div className="mobile-more-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-more-header">
              <span className="text-sm" style={{ fontWeight: 600 }}>Menu</span>
              <button className="icon-btn" onClick={() => setMoreOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="mobile-more-grid">
              {allowedNav.map((item) => {
                const Icon = navIconMap[item.key] || LayoutDashboard;
                const isActive = item.to === '/fleet/app'
                  ? location.pathname === '/fleet/app'
                  : location.pathname.startsWith(item.to);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/fleet/app'}
                    className={isActive ? 'active' : ''}
                    onClick={() => setMoreOpen(false)}
                  >
                    <span className="mobile-more-icon"><Icon size={22} /></span>
                    <span className="mobile-more-label">{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
            <div className="mobile-more-user">
              <div className="avatar" style={{ flexShrink: 0 }}>{user?.full_name?.[0]}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
                <div className="text-xs muted">{getFleetRoleLabel(user?.role)}</div>
              </div>
              <button
                onClick={() => { logout(); nav('/fleet/login'); }}
                className="btn btn-secondary btn-sm"
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="main">
        {showTrialBanner && (
          <TrialBanner
            daysLeft={trialDaysLeft}
            onSubscribe={() => nav('/fleet/app/billing')}
            onDismiss={() => setBannerDismissed(true)}
          />
        )}
        <div className="topbar" style={{ gap: 12 }}>
          <div style={{ position: 'relative', width: 'min(420px, 100%)', marginLeft: 'auto' }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search…" inputProps={{ onKeyDown: goToFirstMatch }} style={{ width: '100%' }} />
            {!!search && (
              <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: '100%', zIndex: 20, padding: 12 }}>
                {filteredNav.length ? filteredNav.map((item) => {
                  const Icon = navIconMap[item.key] || LayoutDashboard;
                  return <button key={item.to} className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 8 }} onClick={() => { nav(item.to); setSearch(''); }}><Icon size={14} /> {item.label}</button>;
                }) : <div className="muted text-sm">No results.</div>}
              </div>
            )}
          </div>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

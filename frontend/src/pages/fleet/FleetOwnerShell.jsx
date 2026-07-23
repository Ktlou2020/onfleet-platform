import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Bike, FileText, CreditCard, HelpCircle, LogOut, Users, Wallet, AlertTriangle, PiggyBank, AlertCircle, MapPin, Key, Clock, CheckCircle2, ArrowRight, X, MoreHorizontal, BarChart2, UserCog } from 'lucide-react';
import Logo from '../../components/Logo';
import { SearchInput, matchesSearch } from '../../components/ui';
import { useAuth } from '../../auth';
import { FLEET_NAV_ITEMS, canAccessFleetRoute, getFleetRoleLabel } from './access';
import api from '../../api';
import { fmt } from '../../components/ui';

const navIconMap = {
  dashboard: LayoutDashboard,
  bikes: Bike,
  tracking: MapPin,
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
  help: HelpCircle
};

const BLOCKED_STATUSES = ['past_due', 'suspended', 'cancelled'];

const PLAN_ACCENT = {
  small:  '#10b981',
  medium: '#3b82f6',
  large:  '#8b5cf6',
  empire: '#f59e0b',
};

function SubscriptionGate({ billingData, onSubscribed }) {
  const { logout } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState('');

  const org = billingData?.organization;
  const plans = billingData?.plans || [];
  const status = org?.status;

  const headings = {
    past_due:  'Your 14-day free trial has ended',
    suspended: 'Payment failed — access suspended',
    cancelled: 'Subscription cancelled',
  };
  const sublines = {
    past_due:  'Subscribe to a plan below to restore full access. Paystack securely captures your card — billing starts immediately.',
    suspended: 'Your last payment was not collected. Update your payment method by subscribing again below.',
    cancelled: 'Your subscription was cancelled. Choose a plan below to regain access.',
  };

  const subscribe = async (planKey) => {
    try {
      setBusy(planKey);
      const { data } = await api.post('/fleet/billing/subscribe', { plan_key: planKey });
      window.location.href = data.authorization_url;
    } catch (err) {
      setBusy('');
      alert(err.response?.data?.error || 'Could not start checkout — please try again.');
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: '32px 16px'
    }}>
      <div style={{ marginBottom: 32 }}><Logo size="lg" /></div>

      <div style={{ maxWidth: 640, width: '100%', textAlign: 'center', marginBottom: 40 }}>
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
          {sublines[status] || 'Please subscribe to continue.'}
        </p>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(plans.length, 2)}, minmax(220px, 1fr))`,
        gap: 16, width: '100%', maxWidth: 900, marginBottom: 32
      }}>
        {plans.map((plan) => {
          const accent = PLAN_ACCENT[plan.key] || 'var(--primary-light)';
          return (
            <div key={plan.key} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: accent, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                  {plan.name}
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--primary-light)', lineHeight: 1 }}>
                  {plan.key === 'empire' ? 'Custom' : fmt(plan.monthly_price)}
                  {plan.key !== 'empire' && <span className="muted text-sm" style={{ fontWeight: 400 }}>/mo</span>}
                </div>
              </div>
              <ul style={{ listStyle: 'none', display: 'grid', gap: 6, flex: 1 }}>
                {plan.features.map((f) => (
                  <li key={f} className="row" style={{ gap: 7, alignItems: 'flex-start' }}>
                    <CheckCircle2 size={13} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 2 }} />
                    <span className="text-sm">{f}</span>
                  </li>
                ))}
              </ul>
              {plan.key === 'empire' ? (
                <a
                  href="https://wa.me/27815395612?text=Hi%2C+I'm+interested+in+the+Empire+fleet+plan"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm btn-secondary"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}
                >
                  Contact us for a quote
                </a>
              ) : (
                <button
                  className="btn btn-sm"
                  onClick={() => subscribe(plan.key)}
                  disabled={!!busy}
                  style={{ background: busy === plan.key ? undefined : accent, borderColor: accent, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}
                >
                  {busy === plan.key ? 'Redirecting…' : <><span>Subscribe</span><ArrowRight size={13} /></>}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="muted text-xs" style={{ marginBottom: 24, textAlign: 'center' }}>
        All billing via Paystack — card details captured securely. Cancel any time.
      </div>

      <button
        onClick={() => { logout(); nav('/fleet/login'); }}
        className="btn btn-secondary btn-sm"
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <LogOut size={13} /> Sign out
      </button>
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
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [billingData, setBillingData] = useState(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const canOpenBilling = canAccessFleetRoute(user?.role, 'billing');
  const onBillingPage = location.pathname.endsWith('/billing');

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

  if (isBlocked) {
    return <SubscriptionGate billingData={billingData} onSubscribed={loadBilling} />;
  }

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
              <button onClick={() => setMoreOpen(false)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', padding: 4, display: 'flex' }}>
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
          <Outlet />
        </div>
      </div>
    </div>
  );
}

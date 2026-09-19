import { useMemo, useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation, matchPath } from 'react-router-dom';
import { useAuth } from '../../auth';
import Logo from '../../components/Logo';
import { SearchInput, matchesSearch } from '../../components/ui';
import NotificationBell from '../../components/NotificationBell';
import { LayoutDashboard, FileCheck, FileText, Bike, CreditCard, Users, ClipboardList, BrainCircuit, LogOut, UploadCloud, Bell, Briefcase, ShieldCheck, PiggyBank, MapPin, UserCheck, Wrench, ShieldAlert, Gauge, Star, TrendingUp, Plug, Inbox, Repeat, MoreHorizontal, X } from 'lucide-react';

const navItems = [
  { section: 'Operations', mobileOnly: true },
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/admin/applications', label: 'Applications', icon: FileCheck },
  { to: '/admin/signup-stats', label: 'Signup Stats', icon: TrendingUp },
  { to: '/admin/agreements', label: 'Agreements', icon: FileText },
  { to: '/admin/bikes', label: 'Bikes Fleet', icon: Bike },
  { to: '/admin/tracking', label: 'GPS Tracking', icon: MapPin, end: true },
  { to: '/admin/tracking/dashboard', label: 'Tracking Dashboard', icon: Gauge },
  { to: '/admin/riders', label: 'Riders', icon: Star },
  { to: '/admin/claims', label: 'Insurance Claims', icon: ShieldAlert },
  { to: '/admin/payments', label: 'Payments', icon: CreditCard },
  { to: '/admin/paystack-charges', label: 'Paystack charges', icon: Inbox },
  { to: '/admin/paystack-subscriptions', label: 'Paystack subscriptions', icon: Repeat, superadminOnly: true },
  { to: '/admin/notifications', label: 'Notifications', icon: Bell },
  { to: '/admin/imports', label: 'CSV Imports', icon: UploadCloud },
  { to: '/admin/strategy', label: 'AI Strategy', icon: BrainCircuit },
  { section: 'Fleet owners' },
  { to: '/admin/leads', label: 'Pilot leads', icon: UserCheck },
  { to: '/admin/fleet-dashboard', label: 'Fleet dashboard', icon: Briefcase },
  { to: '/admin/fleet-owners', label: 'Manage accounts', icon: ShieldCheck, superadminOnly: true },
  { to: '/admin/fleet-payouts', label: 'Payout requests', icon: PiggyBank },
  { section: 'Workshop' },
  { to: '/admin/workshop', label: 'Workshop', icon: Wrench },
  { section: 'System' },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/integrations', label: 'Integrations', icon: Plug, superadminOnly: true },
  { to: '/admin/audit', label: 'Audit Logs', icon: ClipboardList }
];

// Phones get no sidebar, and the bottom bar used to show just the first five
// items with no way to reach the other twenty. It now shows the pages used
// most from a phone, plus More, which opens every page grouped as in the sidebar.
const MOBILE_PRIMARY = ['/admin', '/admin/agreements', '/admin/tracking', '/admin/payments'];

function groupedNav(items) {
  const groups = [];
  for (const item of items) {
    if (item.section || !groups.length) groups.push({ title: item.section || null, items: [] });
    if (!item.section) groups[groups.length - 1].items.push(item);
  }
  return groups.filter((g) => g.items.length);
}

export default function AdminShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  const allowedNav = useMemo(() => navItems.filter((item) => !item.superadminOnly || user?.role === 'superadmin'), [user?.role]);
  const primaryNav = useMemo(() => MOBILE_PRIMARY.map((to) => allowedNav.find((item) => item.to === to)).filter(Boolean), [allowedNav]);
  const moreGroups = useMemo(() => groupedNav(allowedNav), [allowedNav]);
  const onPrimaryPage = primaryNav.some((item) => matchPath({ path: item.to, end: item.to === '/admin' || !!item.end }, location.pathname));
  const filteredNav = useMemo(() => allowedNav.filter((item) => !item.section && matchesSearch(search, item.label, item.to)), [allowedNav, search]);

  const goToFirstMatch = (event) => {
    if (event.key === 'Enter' && filteredNav[0]) {
      event.preventDefault();
      nav(filteredNav[0].to);
      setSearch('');
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px 24px' }}>
          <Logo />
          <span className="badge badge-info" style={{ fontSize: 9 }}>ADMIN</span>
        </div>
        <nav>
          {allowedNav.map((item, i) => {
            if (item.section) return item.mobileOnly ? null : <div key={`sec-${i}`} className="nav-section-label">{item.section}</div>;
            const Icon = item.icon;
            return <NavLink key={item.to} to={item.to} end={item.to === '/admin' || item.end}><Icon size={16} /> {item.label}</NavLink>;
          })}
        </nav>
        <div className="user-mini">
          <div className="avatar">{user?.full_name?.[0]}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
            <div className="text-xs muted">{user?.role}</div>
          </div>
          <button onClick={() => { logout(); nav('/login'); }} title="Log out" style={{ background: 'transparent', color: 'var(--muted)', padding: 8, border: 'none' }}><LogOut size={16} /></button>
        </div>
      </aside>
      <nav className="mobile-bottom-nav">
        {primaryNav.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.to} to={item.to} end={item.to === '/admin' || item.end} onClick={() => setMoreOpen(false)}>
              <Icon size={20} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
        <button
          className={`mobile-more-btn${moreOpen || !onPrimaryPage ? ' active' : ''}`}
          onClick={() => setMoreOpen((open) => !open)}
          aria-label="More navigation options"
          aria-expanded={moreOpen}
        >
          <MoreHorizontal size={20} />
          <span>More</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="mobile-more-overlay" onClick={() => setMoreOpen(false)}>
          <div className="mobile-more-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Admin menu">
            <div className="mobile-more-header">
              <span className="text-sm" style={{ fontWeight: 600 }}>Admin menu</span>
              <button className="icon-btn" onClick={() => setMoreOpen(false)} aria-label="Close menu">
                <X size={18} />
              </button>
            </div>
            {moreGroups.map((group) => (
              <div key={group.title || 'main'}>
                {group.title && <div className="mobile-more-section">{group.title}</div>}
                <div className="mobile-more-grid mobile-more-grid--wrap">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <NavLink key={item.to} to={item.to} end={item.to === '/admin' || item.end} onClick={() => setMoreOpen(false)}>
                        <span className="mobile-more-icon"><Icon size={22} /></span>
                        <span className="mobile-more-label">{item.label}</span>
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="mobile-more-user">
              <div className="avatar" style={{ flexShrink: 0 }}>{user?.full_name?.[0]}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
                <div className="text-xs muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</div>
              </div>
              <button
                onClick={() => { logout(); nav('/login'); }}
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
        <div className="topbar" style={{ gap: 16 }}>
          <div className="text-sm muted hide-mobile">Admin Console · OnFleet Africa</div>
          <div style={{ position: 'relative', width: 'min(520px, 100%)', marginLeft: 'auto' }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search admin tabs and press Enter" inputProps={{ onKeyDown: goToFirstMatch }} style={{ width: '100%' }} />
            {!!search && (
              <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: '100%', zIndex: 20, padding: 12 }}>
                {filteredNav.length ? filteredNav.map((item) => {
                  const Icon = item.icon;
                  return <button key={item.to} className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 8 }} onClick={() => { nav(item.to); setSearch(''); }}><Icon size={14} /> {item.label}</button>;
                }) : <div className="muted text-sm">No admin tabs match your search.</div>}
              </div>
            )}
          </div>
          <NotificationBell />
          <div className="text-xs muted hide-mobile">Logged in as <strong>{user?.email}</strong></div>
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

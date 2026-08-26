import { useMemo, useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import Logo from '../../components/Logo';
import { SearchInput, matchesSearch } from '../../components/ui';
import NotificationBell from '../../components/NotificationBell';
import { LayoutDashboard, FileCheck, FileText, Bike, CreditCard, Users, ClipboardList, BrainCircuit, LogOut, UploadCloud, Bell, Briefcase, ShieldCheck, PiggyBank, MapPin, UserCheck, Wrench, ShieldAlert, Gauge, Star, TrendingUp, Plug } from 'lucide-react';

const navItems = [
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

export default function AdminShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [search, setSearch] = useState('');

  const allowedNav = useMemo(() => navItems.filter((item) => !item.superadminOnly || user?.role === 'superadmin'), [user?.role]);
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
            if (item.section) return <div key={`sec-${i}`} className="nav-section-label">{item.section}</div>;
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
        {allowedNav.filter((item) => !item.section).slice(0, 5).map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.to} to={item.to} end={item.to === '/admin' || item.end}>
              <Icon size={20} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="main">
        <div className="topbar" style={{ gap: 16 }}>
          <div className="text-sm muted">Admin Console · OnFleet Africa</div>
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

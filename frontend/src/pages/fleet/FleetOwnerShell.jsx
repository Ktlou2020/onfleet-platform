import { useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Bike, FileText, CreditCard, LogOut } from 'lucide-react';
import Logo from '../../components/Logo';
import { SearchInput, matchesSearch } from '../../components/ui';
import { useAuth } from '../../auth';

const navItems = [
  { key: 'dashboard', to: '/fleet/app', label: 'Dashboard', icon: LayoutDashboard, roles: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'] },
  { key: 'bikes', to: '/fleet/app/bikes', label: 'Bikes Fleet', icon: Bike, roles: ['fleet_owner_admin', 'fleet_owner_ops'] },
  { key: 'agreements', to: '/fleet/app/agreements', label: 'Agreements', icon: FileText, roles: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'] },
  { key: 'payments', to: '/fleet/app/payments', label: 'Payments', icon: CreditCard, roles: ['fleet_owner_admin', 'fleet_owner_billing'] }
];

export default function FleetOwnerShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [search, setSearch] = useState('');

  const allowedNav = useMemo(() => navItems.filter((item) => item.roles.includes(user?.role)), [user?.role]);
  const filteredNav = useMemo(() => allowedNav.filter((item) => matchesSearch(search, item.label, item.to)), [allowedNav, search]);

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
          <span className="badge badge-info" style={{ fontSize: 9 }}>FLEET</span>
        </div>
        <nav>
          {allowedNav.map((item) => {
            const Icon = item.icon;
            return <NavLink key={item.to} to={item.to} end={item.to === '/fleet/app'}><Icon size={16} /> {item.label}</NavLink>;
          })}
        </nav>
        <div className="user-mini">
          <div className="avatar">{user?.full_name?.[0]}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
            <div className="text-xs muted">{String(user?.role || '').replace(/_/g, ' ')}</div>
          </div>
          <button onClick={() => { logout(); nav('/fleet/login'); }} title="Log out" style={{ background: 'transparent', color: 'var(--muted)', padding: 8, border: 'none' }}><LogOut size={16} /></button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar" style={{ gap: 16 }}>
          <div className="text-sm muted">Fleet Owner Console · OnFleet Africa</div>
          <div style={{ position: 'relative', width: 'min(520px, 100%)', marginLeft: 'auto' }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search fleet tabs and press Enter" inputProps={{ onKeyDown: goToFirstMatch }} style={{ width: '100%' }} />
            {!!search && (
              <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: '100%', zIndex: 20, padding: 12 }}>
                {filteredNav.length ? filteredNav.map((item) => {
                  const Icon = item.icon;
                  return <button key={item.to} className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 8 }} onClick={() => { nav(item.to); setSearch(''); }}><Icon size={14} /> {item.label}</button>;
                }) : <div className="muted text-sm">No fleet tabs match your search.</div>}
              </div>
            )}
          </div>
          <div className="text-xs muted">Logged in as <strong>{user?.email}</strong></div>
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import Logo from '../../components/Logo';
import { SearchInput, matchesSearch } from '../../components/ui';
import { LayoutDashboard, FileText, Bike, CreditCard, User, LogOut, Bell } from 'lucide-react';

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/agreements', label: 'My Agreement', icon: FileText },
  { to: '/payments', label: 'Payments', icon: CreditCard },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/application', label: 'Application', icon: Bike },
  { to: '/profile', label: 'Profile', icon: User }
];

export default function RiderShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [search, setSearch] = useState('');

  const filteredNav = useMemo(() => navItems.filter((item) => matchesSearch(search, item.label, item.to)), [search]);

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
        <Logo />
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return <NavLink key={item.to} to={item.to}><Icon size={16} /> {item.label}</NavLink>;
          })}
        </nav>
        <div className="user-mini">
          <div className="avatar">{user?.full_name?.[0]}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
            <div className="text-xs muted">Rider</div>
          </div>
          <button className="btn-ghost" onClick={() => { logout(); nav('/login'); }} title="Log out" style={{ background: 'transparent', color: 'var(--muted)', padding: 8 }}><LogOut size={16} /></button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar" style={{ gap: 16 }}>
          <div className="text-sm muted">Welcome back, {user?.full_name?.split(' ')[0]} 👋</div>
          <div style={{ position: 'relative', width: 'min(460px, 100%)', marginLeft: 'auto' }}>
            <SearchInput value={search} onChange={setSearch} placeholder="Search rider tabs and press Enter" inputProps={{ onKeyDown: goToFirstMatch }} style={{ width: '100%' }} />
            {!!search && (
              <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: '100%', zIndex: 20, padding: 12 }}>
                {filteredNav.length ? filteredNav.map((item) => {
                  const Icon = item.icon;
                  return <button key={item.to} className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 8 }} onClick={() => { nav(item.to); setSearch(''); }}><Icon size={14} /> {item.label}</button>;
                }) : <div className="muted text-sm">No rider tabs match your search.</div>}
              </div>
            )}
          </div>
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

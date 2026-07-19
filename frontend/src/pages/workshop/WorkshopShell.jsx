import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ClipboardList, LogOut, Wrench } from 'lucide-react';
import { useAuth } from '../../auth';

const NAV = [
  { to: '/workshop/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/workshop/app/job-cards', label: 'Job Cards', icon: ClipboardList }
];

export default function WorkshopShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px 24px' }}>
          <Wrench size={22} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>Workshop</span>
          <span className="badge badge-info" style={{ fontSize: 9, marginLeft: 'auto' }}>WS</span>
        </div>
        <nav>
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} end={item.end}>
                <Icon size={16} /> {item.label}
              </NavLink>
            );
          })}
        </nav>
        <div className="user-mini">
          <div className="avatar">{user?.full_name?.[0]}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
            <div className="text-xs muted">{user?.role}</div>
          </div>
          <button onClick={() => { logout(); nav('/login'); }} title="Log out" style={{ background: 'transparent', color: 'var(--muted)', padding: 8, border: 'none' }}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <nav className="mobile-bottom-nav">
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.to} to={item.to} end={item.end}>
              <Icon size={20} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="main">
        <div className="topbar" style={{ gap: 16 }}>
          <div className="text-sm muted">Workshop · OnFleet Africa</div>
          <div className="text-xs muted" style={{ marginLeft: 'auto' }}>Logged in as <strong>{user?.email}</strong></div>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

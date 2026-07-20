import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ClipboardList, LogOut, Wrench } from 'lucide-react';
import { useAuth } from '../../auth';
import api from '../../api';

export default function WorkshopShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [openCount, setOpenCount] = useState(null);

  useEffect(() => {
    api.get('/workshop/dashboard')
      .then((r) => setOpenCount(r.data.stats?.open_count ?? null))
      .catch(() => {});
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px 24px' }}>
          <Wrench size={22} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>Workshop</span>
          <span className="badge badge-info" style={{ fontSize: 9, marginLeft: 'auto' }}>WS</span>
        </div>
        <nav>
          <NavLink to="/workshop/app" end>
            <LayoutDashboard size={16} /> Dashboard
          </NavLink>
          <NavLink to="/workshop/app/job-cards" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ClipboardList size={16} /> Job Cards
            {openCount > 0 && (
              <span style={{ marginLeft: 'auto', background: 'var(--danger, #ef4444)', color: '#fff', borderRadius: 10, fontSize: 10, padding: '1px 7px', minWidth: 18, textAlign: 'center', lineHeight: '16px' }}>
                {openCount}
              </span>
            )}
          </NavLink>
        </nav>
        <div className="user-mini">
          <div className="avatar">{user?.full_name?.[0]}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
            <div className="text-xs muted">{user?.role}</div>
          </div>
          <button onClick={() => { logout(); nav('/workshop/login'); }} title="Log out" style={{ background: 'transparent', color: 'var(--muted)', padding: 8, border: 'none' }}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <nav className="mobile-bottom-nav">
        <NavLink to="/workshop/app" end>
          <LayoutDashboard size={20} />
          <span>Dashboard</span>
        </NavLink>
        <NavLink to="/workshop/app/job-cards">
          <ClipboardList size={20} />
          <span>Jobs {openCount > 0 ? `(${openCount})` : ''}</span>
        </NavLink>
      </nav>
      <div className="main">
        <div className="topbar" style={{ gap: 16 }}>
          <div className="text-sm muted">Workshop · OnFleet Africa</div>
          <div className="text-xs muted hide-mobile" style={{ marginLeft: 'auto' }}>Logged in as <strong>{user?.email}</strong></div>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

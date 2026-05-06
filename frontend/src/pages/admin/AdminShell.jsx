import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import Logo from '../../components/Logo';
import { LayoutDashboard, FileCheck, FileText, Bike, CreditCard, Users, ShieldCheck, ClipboardList, LogOut } from 'lucide-react';

export default function AdminShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px 24px' }}>
          <Logo />
          <span className="badge badge-info" style={{ fontSize: 9 }}>ADMIN</span>
        </div>
        <nav>
          <NavLink to="/admin" end><LayoutDashboard size={16} /> Dashboard</NavLink>
          <NavLink to="/admin/applications"><FileCheck size={16} /> Applications</NavLink>
          <NavLink to="/admin/agreements"><FileText size={16} /> Agreements</NavLink>
          <NavLink to="/admin/bikes"><Bike size={16} /> Bikes Fleet</NavLink>
          <NavLink to="/admin/payments"><CreditCard size={16} /> Payments</NavLink>
          <NavLink to="/admin/kyc"><ShieldCheck size={16} /> KYC Review</NavLink>
          <NavLink to="/admin/users"><Users size={16} /> Users</NavLink>
          <NavLink to="/admin/audit"><ClipboardList size={16} /> Audit Logs</NavLink>
        </nav>
        <div className="user-mini">
          <div className="avatar">{user?.full_name?.[0]}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
            <div className="text-xs muted">{user?.role}</div>
          </div>
          <button onClick={() => { logout(); nav('/login'); }} title="Log out"
            style={{ background: 'transparent', color: 'var(--muted)', padding: 8, border: 'none' }}><LogOut size={16} /></button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <div className="text-sm muted">Admin Console · OnFleet Africa</div>
          <div className="text-xs muted">Logged in as <strong>{user?.email}</strong></div>
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

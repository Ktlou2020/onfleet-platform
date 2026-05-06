import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import Logo from '../../components/Logo';
import { LayoutDashboard, FileText, Bike, CreditCard, ShieldCheck, User, LogOut, Bell } from 'lucide-react';

export default function RiderShell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <nav>
          <NavLink to="/dashboard"><LayoutDashboard size={16} /> Dashboard</NavLink>
          <NavLink to="/agreements"><FileText size={16} /> My Agreement</NavLink>
          <NavLink to="/payments"><CreditCard size={16} /> Payments</NavLink>
          <NavLink to="/application"><Bike size={16} /> Application</NavLink>
          <NavLink to="/kyc"><ShieldCheck size={16} /> KYC Documents</NavLink>
          <NavLink to="/profile"><User size={16} /> Profile</NavLink>
        </nav>
        <div className="user-mini">
          <div className="avatar">{user?.full_name?.[0]}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
            <div className="text-xs muted">Rider</div>
          </div>
          <button className="btn-ghost" onClick={() => { logout(); nav('/login'); }} title="Log out"
            style={{ background: 'transparent', color: 'var(--muted)', padding: 8 }}><LogOut size={16} /></button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <div className="text-sm muted">Welcome back, {user?.full_name?.split(' ')[0]} 👋</div>
          <Bell size={18} className="muted" />
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

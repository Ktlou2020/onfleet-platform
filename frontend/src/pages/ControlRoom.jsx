'use strict';
import { LogOut, Radio, Map, Bell } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';

export default function ControlRoom() {
  const { user, logout } = useAuth();

  const tabStyle = ({ isActive }) => ({
    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px',
    borderRadius: 6, fontSize: 12, fontWeight: isActive ? 700 : 400,
    color: isActive ? '#fff' : 'var(--muted)',
    background: isActive ? 'var(--primary)' : 'transparent',
    textDecoration: 'none',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--surface)' }}>
      {/* Minimal header */}
      <div style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        background: 'var(--surface-2)',
        borderBottom: '1px solid var(--border)',
        gap: 10,
        flexShrink: 0,
      }}>
        <Radio size={16} color="var(--primary)" />
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '.2px' }}>Control Room</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 2 }}>— GPS Tracking</span>

        <div style={{ display: 'flex', gap: 4, marginLeft: 18 }}>
          <NavLink to="/control-room" end style={tabStyle}><Map size={13} /> Live Map</NavLink>
          <NavLink to="/control-room/alerts" style={tabStyle}><Bell size={13} /> Alerts Feed</NavLink>
        </div>

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{user?.full_name || user?.email}</span>
        <button
          onClick={logout}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
            cursor: 'pointer', fontSize: 12, color: 'var(--muted)',
          }}>
          <LogOut size={13} />
          Sign out
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Outlet />
      </div>
    </div>
  );
}

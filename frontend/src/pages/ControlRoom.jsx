'use strict';
import { LogOut, Radio } from 'lucide-react';
import { useAuth } from '../auth';
import Tracking from './admin/Tracking';

export default function ControlRoom() {
  const { user, logout } = useAuth();

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

      {/* Full-height read-only tracking view */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Tracking readOnly />
      </div>
    </div>
  );
}

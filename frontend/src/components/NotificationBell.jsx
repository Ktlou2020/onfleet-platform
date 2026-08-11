import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Wrench, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api';
import { ALERT_LABELS, ALERT_COLORS } from '../lib/alertMeta';

const POLL_MS = 30_000;

function timeAgo(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function itemMeta(item) {
  if (item.source === 'tracking_alert') {
    let payload = {};
    try { payload = JSON.parse(item.message || '{}'); } catch { /* not JSON */ }
    const label = ALERT_LABELS[item.type] || item.type;
    return {
      icon: AlertTriangle,
      color: ALERT_COLORS[item.type] || '#94a3b8',
      title: `${label} — ${item.title}`,
      body: payload.description || payload.message || null
    };
  }
  return { icon: Wrench, color: 'var(--primary-light)', title: item.title, body: item.message };
}

export default function NotificationBell() {
  const nav = useNavigate();
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const rootRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/notifications/bell');
      setItems(data.items || []);
      setUnreadCount(data.unread_count || 0);
    } catch { /* silent — the bell shouldn't toast on every failed poll */ }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const markItemRead = async (item) => {
    try {
      if (item.source === 'job_card') await api.post(`/notifications/${item.id}/read`);
      else await api.put(`/tracking/alerts/${item.id}/acknowledge`);
      setItems((current) => current.map((i) => (i === item ? { ...i, read: true } : i)));
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch { /* best-effort */ }
  };

  const openItem = (item) => {
    setOpen(false);
    if (!item.read) markItemRead(item);
    nav(item.link);
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      await Promise.all([api.post('/notifications/mine/read-all'), api.post('/tracking/alerts/acknowledge-all')]);
      setItems((current) => current.map((i) => ({ ...i, read: true })));
      setUnreadCount(0);
    } catch {
      toast.error('Could not mark everything read');
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div ref={rootRef} className="notification-bell-root">
      <button
        className="btn-ghost"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        style={{ position: 'relative', background: 'transparent', border: 'none', color: 'var(--text)', padding: 8, display: 'flex' }}
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 100,
            background: 'var(--danger)', color: 'white', fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 380, maxWidth: '90vw', zIndex: 30, padding: 0 }}>
          <div className="flex-between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <strong className="text-sm">Notifications</strong>
            {unreadCount > 0 && (
              <button className="btn btn-secondary btn-sm" disabled={markingAll} onClick={markAllRead}>
                {markingAll ? 'Working…' : 'Mark all read'}
              </button>
            )}
          </div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {!items.length && <div className="muted text-sm" style={{ padding: 20, textAlign: 'center' }}>Nothing to show right now.</div>}
            {items.map((item) => {
              const meta = itemMeta(item);
              const Icon = meta.icon;
              return (
                <button
                  key={`${item.source}-${item.id}`}
                  onClick={() => openItem(item)}
                  style={{
                    display: 'flex', gap: 10, width: '100%', textAlign: 'left', padding: '10px 14px',
                    background: item.read ? 'transparent' : 'var(--surface-2)', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer'
                  }}
                >
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: meta.color, flexShrink: 0 }}>
                    <Icon size={15} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="text-sm" style={{ fontWeight: item.read ? 500 : 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.title}</div>
                    {meta.body && <div className="text-xs muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.body}</div>}
                    <div className="text-xs muted">{timeAgo(item.created_at)}</div>
                  </div>
                  {!item.read && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--primary-light)', flexShrink: 0, marginTop: 6 }} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, EmptyState, Loading, fmtDateTime } from '../../components/ui';
import { Bell, CheckCheck, RefreshCw, Mail, MessageSquare, Smartphone } from 'lucide-react';

const channelIcon = {
  email: Mail,
  sms: Smartphone,
  whatsapp: MessageSquare
};

function NotificationCard({ item, onRead }) {
  const ChannelIcon = channelIcon[item.channel] || Bell;
  const isRead = item.status === 'read';
  return (
    <div className="card" style={{ borderColor: isRead ? 'var(--border)' : 'rgba(30,136,209,0.35)' }}>
      <div className="flex-between gap-3" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(30,136,209,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary-light)', flexShrink: 0 }}>
            <ChannelIcon size={18} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
              <h3 style={{ marginBottom: 0 }}>{item.title || 'Platform update'}</h3>
              <Badge status={item.status}>{String(item.status || 'pending').replace(/_/g, ' ')}</Badge>
            </div>
            <div className="text-xs muted" style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
              {item.channel || 'system'} • {item.type || 'update'}
            </div>
            <p className="muted" style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{item.message}</p>
            <div className="text-xs muted">{fmtDateTime(item.sent_at || item.created_at)}</div>
          </div>
        </div>
        {!isRead && (
          <button className="btn btn-secondary btn-sm" onClick={() => onRead(item.id)}>
            <CheckCheck size={14} /> Mark as read
          </button>
        )}
      </div>
    </div>
  );
}

export default function RiderNotifications() {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const response = await api.get('/notifications/mine');
    setList(response.data.notifications || []);
  };

  useEffect(() => { load(); }, []);

  const markRead = async (id) => {
    try {
      setBusy(true);
      await api.post(`/notifications/${id}/read`);
      setList((prev) => (prev || []).map((item) => item.id === id ? { ...item, status: 'read' } : item));
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update notification');
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = async () => {
    try {
      setBusy(true);
      await api.post('/notifications/mine/read-all');
      setList((prev) => (prev || []).map((item) => ({ ...item, status: 'read' })));
      toast.success('All notifications marked as read');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update notifications');
    } finally {
      setBusy(false);
    }
  };

  if (!list) return <Loading />;

  const unread = list.filter((item) => item.status !== 'read').length;

  return (
    <>
      <div className="flex-between mb-2" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-sub">Track the latest updates about your application, agreement, payments, and account.</p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={load} disabled={busy}><RefreshCw size={16} /> Refresh</button>
          <button className="btn" onClick={markAllRead} disabled={busy || !unread}><CheckCheck size={16} /> Mark all read</button>
        </div>
      </div>

      <div className="grid grid-3 mb-4">
        <div className="stat"><div className="stat-label">Total updates</div><div className="stat-value">{list.length}</div></div>
        <div className="stat"><div className="stat-label">Unread</div><div className="stat-value">{unread}</div></div>
        <div className="stat"><div className="stat-label">Last update</div><div className="stat-value" style={{ fontSize: 18 }}>{list[0] ? fmtDateTime(list[0].sent_at || list[0].created_at) : '—'}</div></div>
      </div>

      {list.length ? (
        <div className="grid">
          {list.map((item) => <NotificationCard key={item.id} item={item} onRead={markRead} />)}
        </div>
      ) : (
        <EmptyState title="No notifications yet" sub="Updates from approvals, agreements, payments, and support will appear here." />
      )}
    </>
  );
}

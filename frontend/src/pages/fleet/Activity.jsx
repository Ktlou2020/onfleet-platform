import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, EmptyState, Loading, fmtDateTime } from '../../components/ui';

// What this fleet's own people did, and what was sent to its riders.
//
// Only this fleet's own users appear. Actions a platform operator took on the
// account are not here on purpose: that is the operator's audit trail, and
// showing a tenant half of it is worse than showing none.

export default function FleetActivity() {
  const [entries, setEntries] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [a, n] = await Promise.all([
        api.get('/fleet/activity/audit'),
        api.get('/fleet/activity/notifications'),
      ]);
      setEntries(a.data.entries || []);
      setNotifications(n.data.notifications || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  if (loading) return <Loading />;

  return (
    <>
      <h1>Activity</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        What your team changed, and what your riders were sent.
      </p>

      <h2 style={{ marginTop: 22 }}>Your team&apos;s changes</h2>
      {entries.length === 0 ? (
        <EmptyState title="Nothing yet" sub="Changes your team makes will be recorded here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr><th>Who</th><th>Did what</th><th>To</th><th>When</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td><strong>{e.actor_name}</strong><div className="text-xs muted">{e.actor_email}</div></td>
                  <td>{String(e.action).replace(/[._]/g, ' ')}</td>
                  <td className="text-sm muted">{e.entity}{e.entity_id ? ` #${e.entity_id}` : ''}</td>
                  <td>{fmtDateTime(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 26 }}>Messages to your riders</h2>
      {notifications.length === 0 ? (
        <EmptyState title="Nothing sent yet" sub="Reminders and alerts sent to your riders appear here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr><th>Rider</th><th>Message</th><th>Channel</th><th>Status</th><th>Sent</th></tr></thead>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.id}>
                  <td>{n.recipient_name}</td>
                  <td><strong>{n.title}</strong><div className="text-xs muted">{n.type}</div></td>
                  <td>{n.channel}</td>
                  <td><Badge status={n.status === 'sent' ? 'success' : n.status === 'failed' ? 'danger' : ''}>{n.status}</Badge></td>
                  <td>{fmtDateTime(n.sent_at || n.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

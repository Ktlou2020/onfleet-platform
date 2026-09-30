import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, EmptyState, Loading, fmtDateTime } from '../../components/ui';
import { brandName } from '../../brand';
import { Building2 } from 'lucide-react';

// What this fleet's own people did, what the platform did to them, and what
// was sent to their riders.
//
// The middle one used to be left out, on the grounds that a partial view of
// the operator's audit trail is worse than none. The opposite is truer:
// somebody signed into the account, changed the plan or adjusted the wallet,
// and the only record of it was on a screen the customer cannot reach.
//
// What is shown is every platform action that names this account — the
// organisation, its wallet, or one of its people. Not the whole of what the
// operator does, and the page says so rather than implying otherwise.

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
        What your team changed, what {brandName} did to your account, and what your
        riders were sent.
      </p>

      <h2 style={{ marginTop: 22 }}>Changes to your account</h2>
      <p className="muted text-sm" style={{ marginTop: -6 }}>
        Your own team&apos;s, and anything {brandName} did that names your account —
        your plan, your wallet, or one of your people.
      </p>
      {entries.length === 0 ? (
        <EmptyState title="Nothing yet" sub={`Changes your team makes, and anything ${brandName} does to your account, will be recorded here.`} />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr><th>Who</th><th>Did what</th><th>To</th><th>When</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} style={e.by_platform ? { background: 'rgba(30,136,209,0.06)' } : undefined}>
                  <td>
                    <strong>{e.actor_name}</strong>
                    {e.by_platform ? (
                      <div className="text-xs" style={{ color: 'var(--primary-light)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Building2 size={11} /> {brandName}
                      </div>
                    ) : (
                      <div className="text-xs muted">{e.actor_email}</div>
                    )}
                  </td>
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

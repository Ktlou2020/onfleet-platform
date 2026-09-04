import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { CheckCircle2, XCircle, Smartphone, Monitor, Tablet } from 'lucide-react';
import api from '../api';
import { Modal, fmtDateTime } from './ui';

// Plain-language reasons. Support reads these, not the enum.
const REASONS = {
  wrong_password:    'Wrong password',
  no_such_account:   'No account with that email',
  account_suspended: 'Account suspended',
};

function DeviceIcon({ type }) {
  if (type === 'Phone') return <Smartphone size={13} />;
  if (type === 'Tablet') return <Tablet size={13} />;
  return <Monitor size={13} />;
}

export default function RiderLoginHistoryModal({ rider, onClose }) {
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/admin/users/${rider.id}/login-attempts`);
      setData(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load sign-in history');
      setData({ attempts: [], summary: {} });
    }
  }, [rider.id]);

  useEffect(() => { load(); }, [load]);

  const attempts = data?.attempts;
  const s = data?.summary || {};

  return (
    <Modal isOpen onClose={onClose} title={`Sign-in activity — ${rider.full_name}`} style={{ maxWidth: 820 }}>
      <div>
        {!data ? (
          <div className="muted text-sm">Loading…</div>
        ) : !attempts.length ? (
          <div className="muted text-sm">
            No sign-in attempts recorded for this rider. Either they haven't tried to log in,
            or they tried before sign-in tracking was switched on.
          </div>
        ) : (
          <>
            <div className="grid grid-3 mb-4" style={{ gap: 12 }}>
              <div className="stat"><div className="stat-label">Attempts</div><div className="stat-value">{s.total}</div></div>
              <div className="stat">
                <div className="stat-label">Successful</div>
                <div className="stat-value" style={{ color: s.successful ? 'var(--success)' : undefined }}>{s.successful}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Failed</div>
                <div className="stat-value" style={{ color: s.failed ? 'var(--danger)' : undefined }}>{s.failed}</div>
              </div>
            </div>

            {s.total > 0 && !s.successful && (
              <div className="card mb-3" style={{ background: 'var(--surface-2)', borderLeft: '3px solid var(--danger)' }}>
                <div className="text-sm">
                  This rider has tried to sign in but has <strong>never succeeded</strong>. Check the reason below —
                  if it says the email doesn't exist, they're likely typing a different address to the one on their account.
                </div>
              </div>
            )}

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>When</th><th>Result</th><th>Browser</th><th>Device</th><th>Email used</th><th>IP</th></tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.id}>
                      <td className="text-xs" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.created_at)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {a.success ? (
                          <span style={{ color: 'var(--success)', fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle2 size={13} /> Signed in
                          </span>
                        ) : (
                          <span style={{ color: 'var(--danger)', fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            title={a.failure_reason || ''}>
                            <XCircle size={13} /> {REASONS[a.failure_reason] || 'Failed'}
                          </span>
                        )}
                      </td>
                      {/* Full UA on hover — the parsed name covers the common cases,
                          and the raw string is there when it doesn't. */}
                      <td title={a.user_agent || ''}>{a.browser || <span className="muted">Unknown</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <DeviceIcon type={a.device_type} />
                          {a.os || '—'}
                        </span>
                      </td>
                      <td className="text-xs" style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={a.email}>{a.email}</td>
                      <td className="text-xs muted">{a.ip || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

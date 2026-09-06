import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { CheckCircle2, XCircle, Smartphone, Monitor, Tablet, Search, UserX } from 'lucide-react';
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

// Everything before the @. Searching that finds attempts on any address built
// from the same name — which is what a mistyped domain looks like.
function localPart(email) {
  return String(email || '').split('@')[0] || '';
}

export default function RiderLoginHistoryModal({ rider, onClose }) {
  const [data, setData] = useState(null);
  const [query, setQuery] = useState(() => localPart(rider.email));
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

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

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return toast.error('Enter part of an email address to search for');
    setSearching(true);
    try {
      const res = await api.get('/admin/login-attempts', { params: { email: q, limit: 50 } });
      setResults(res.data.attempts);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const attempts = data?.attempts;
  const s = data?.summary || {};
  // An attempt on an address that matches no account is the thing worth
  // spotting — that's a rider typing their email wrong.
  const orphans = (results || []).filter((r) => !r.matched_user_id);

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

        {/* The history above can only show attempts tied to this account. An
            attempt on a mistyped address belongs to nobody, so it can never
            appear there — this is how those are found. */}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 22, paddingTop: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Search all sign-in attempts</div>
          <div className="muted text-sm mb-3">
            If this rider insists they tried, they may have typed a different address.
            Searching the part before the @ finds attempts on any address built from it.
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              placeholder="e.g. thabo.mokoena"
              style={{ flex: '1 1 240px' }}
            />
            <button className="btn" onClick={runSearch} disabled={searching}>
              <Search size={14} /> {searching ? 'Searching…' : 'Search'}
            </button>
          </div>

          {results !== null && (
            results.length === 0 ? (
              <div className="muted text-sm">No sign-in attempts match “{query.trim()}”.</div>
            ) : (
              <>
                {orphans.length > 0 && (
                  <div className="card mb-3" style={{ background: 'var(--surface-2)', borderLeft: '3px solid var(--warn)' }}>
                    <div className="text-sm" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <UserX size={16} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 2 }} />
                      <span>
                        <strong>{orphans.length} attempt{orphans.length !== 1 ? 's' : ''} on an address with no account.</strong>{' '}
                        Compare against <strong>{rider.email}</strong> — if it's a near miss, that's why they can't sign in.
                      </span>
                    </div>
                  </div>
                )}
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>When</th><th>Email tried</th><th>Result</th><th>Account</th><th>Browser</th></tr></thead>
                    <tbody>
                      {results.map((r) => (
                        <tr key={r.id} style={!r.matched_user_id ? { background: 'var(--surface-2)' } : undefined}>
                          <td className="text-xs" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.created_at)}</td>
                          <td className="text-xs" style={{ fontWeight: r.email === rider.email ? 400 : 600 }} title={r.email}>{r.email}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {r.success
                              ? <span style={{ color: 'var(--success)', fontSize: 12, fontWeight: 600 }}>Signed in</span>
                              : <span style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 600 }}>{REASONS[r.failure_reason] || 'Failed'}</span>}
                          </td>
                          <td className="text-xs">
                            {r.matched_user_name
                              ? r.matched_user_name
                              : <span style={{ color: 'var(--warn)', fontWeight: 600 }}>No account</span>}
                          </td>
                          <td className="text-xs" title={r.user_agent || ''}>
                            {r.browser || <span className="muted">Unknown</span>}{r.os ? ` · ${r.os}` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}
        </div>
      </div>
    </Modal>
  );
}

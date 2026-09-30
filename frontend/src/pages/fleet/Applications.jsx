import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { useAuth } from '../../auth';
import { Badge, EmptyState, Loading, Stat, fmt, fmtDate } from '../../components/ui';
import { canManageFleetSection } from './access';
import { ClipboardList, Clock, UserCheck } from 'lucide-react';

// Rider applications, scoped to this fleet's own riders.
//
// The join that scopes it is applications → users → organization_id, which is
// the only thing tying an application to a fleet. There is no
// applications.organization_id column, and adding one would be a second
// answer to a question the user row already answers.
//
// Deciding one happens in the rider's file rather than here. Approving is not
// a single click — it allocates a bike, fixes the weekly amount, the term and
// the start date, and writes a contract — and the things worth reading before
// approving are the documents and the income, which are on that file. So this
// page is the queue, and "Review" takes the decision to where it belongs.

const WAITING = ['submitted', 'under_review'];
const TONE = { submitted: 'info', under_review: 'warning', approved: 'success', rejected: 'danger', draft: '', withdrawn: '' };

export default function FleetApplications() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  // The decision endpoint is gated on the riders section, so the button is
  // drawn from that and not from this page's own permission. The two agreeing
  // is what stops a button that 403s.
  const canDecide = canManageFleetSection(user?.role, 'riders');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/fleet/applications');
      setRows(data.applications || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load applications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Whoever is waiting comes first, oldest first inside that: an application
  // nobody has answered for three weeks is the one that needs answering, and
  // sorting the queue newest-first buries it.
  const ordered = useMemo(() => {
    const waiting = rows.filter((a) => WAITING.includes(a.status))
      .sort((a, z) => String(a.submitted_at || '').localeCompare(String(z.submitted_at || '')));
    const decided = rows.filter((a) => !WAITING.includes(a.status));
    return [...waiting, ...decided];
  }, [rows]);

  const waitingCount = useMemo(() => rows.filter((a) => WAITING.includes(a.status)).length, [rows]);
  const approvedCount = useMemo(() => rows.filter((a) => a.status === 'approved').length, [rows]);

  const review = (id) => nav(`/fleet/app/riders?application=${id}`);

  if (loading) return <Loading />;

  return (
    <>
      <h1>Applications</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Riders who have applied to ride for you. Open one to read the file and decide.
      </p>

      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <Stat label="Waiting for a decision" value={waitingCount}
              accent={waitingCount ? 'var(--warn)' : undefined} icon={<Clock size={18} />} />
        <Stat label="Approved" value={approvedCount} icon={<UserCheck size={18} />} />
        <Stat label="Applications in total" value={rows.length} icon={<ClipboardList size={18} />} />
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No applications yet"
                    sub="Riders who apply through your link will appear here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginTop: 16 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr>
              <th>Rider</th><th>Contact</th><th>Monthly income</th>
              <th>Bike</th><th>Status</th><th>Submitted</th>
              <th style={{ textAlign: 'right' }}>{canDecide ? 'Decision' : ''}</th>
            </tr></thead>
            <tbody>
              {ordered.map((a) => {
                const waiting = WAITING.includes(a.status);
                return (
                  <tr key={a.id}>
                    <td><strong>{a.full_name}</strong></td>
                    <td className="text-sm">{a.email}<div className="text-xs muted">{a.phone || '—'}</div></td>
                    <td>{a.monthly_income != null ? fmt(a.monthly_income) : '—'}</td>
                    <td>{a.preferred_bike || '—'}</td>
                    <td>
                      <Badge status={TONE[a.status] || ''}>{String(a.status).replace(/_/g, ' ')}</Badge>
                      {a.auto_decision && (
                        <div className="text-xs muted" style={{ marginTop: 3 }}>auto: {a.auto_decision}</div>
                      )}
                      {a.status === 'rejected' && a.rejection_reason && (
                        <div className="text-xs muted" style={{ marginTop: 3, maxWidth: 220 }}>{a.rejection_reason}</div>
                      )}
                    </td>
                    <td>
                      {a.submitted_at ? fmtDate(a.submitted_at) : '—'}
                      {a.reviewed_at && (
                        <div className="text-xs muted">decided {fmtDate(a.reviewed_at)}</div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {!canDecide ? null : waiting ? (
                        <button className="btn btn-sm" onClick={() => review(a.id)}>Review</button>
                      ) : (
                        <button className="btn btn-secondary btn-sm" onClick={() => review(a.id)}>Open file</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, EmptyState, Loading, fmt, fmtDate } from '../../components/ui';

// Rider applications, scoped to this fleet's own riders.
//
// The join that scopes it is applications → users → organization_id, which is
// the only thing tying an application to a fleet. There is no
// applications.organization_id column, and adding one would be a second
// answer to a question the user row already answers.

const TONE = { submitted: 'info', under_review: 'warning', approved: 'success', rejected: 'danger', draft: '', withdrawn: '' };

export default function FleetApplications() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

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
  if (loading) return <Loading />;

  return (
    <>
      <h1>Applications</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Riders who have applied to ride for you.
      </p>

      {rows.length === 0 ? (
        <EmptyState title="No applications yet"
                    sub="Riders who apply through your link will appear here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginTop: 16 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr>
              <th>Rider</th><th>Contact</th><th>Monthly income</th>
              <th>Bike</th><th>Status</th><th>Submitted</th>
            </tr></thead>
            <tbody>
              {rows.map((a) => (
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
                  </td>
                  <td>{a.submitted_at ? fmtDate(a.submitted_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, EmptyState, Loading, Stat, fmt, fmtDate } from '../../components/ui';
import { Wrench, AlertTriangle, Gauge } from 'lucide-react';

// The workshop, from the fleet owner's side.
//
// Deliberately read-mostly. A fleet owner wants to know which of their bikes
// are in, what was done and what it cost — not to run a job card, which is
// the workshop's own screen. Everything here comes from /fleet/workshop/*,
// which is scoped to this fleet's bikes in the query itself.

const STATUS_TONE = { open: 'info', quoted: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };
const DUE_TONE = { overdue: 'danger', due_soon: 'warning', ok: 'success' };

export default function FleetWorkshop() {
  const [jobs, setJobs] = useState([]);
  const [due, setDue] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [j, d] = await Promise.all([
        api.get('/fleet/workshop/job-cards'),
        api.get('/fleet/workshop/service-due'),
      ]);
      setJobs(j.data.job_cards || []);
      setDue(d.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load the workshop');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  if (loading) return <Loading />;

  const open = jobs.filter((j) => !['completed', 'cancelled'].includes(j.status));

  return (
    <>
      <h1>Workshop</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        What the workshop has done to your bikes, and which are due next.
      </p>

      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <Stat label="In the workshop now" value={open.length} icon={<Wrench size={18} />} />
        <Stat label="Overdue for service" value={due?.summary?.overdue ?? 0}
              accent={due?.summary?.overdue ? 'danger' : undefined} icon={<AlertTriangle size={18} />} />
        <Stat label="Due soon" value={due?.summary?.due_soon ?? 0} icon={<Gauge size={18} />} />
      </div>

      <h2 style={{ marginTop: 26 }}>Job cards</h2>
      {jobs.length === 0 ? (
        <EmptyState title="No job cards yet" sub="Work done on your bikes will appear here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr>
              <th>Bike</th><th>Type</th><th>Description</th><th>Status</th>
              <th>Opened</th><th style={{ textAlign: 'right' }}>Parts &amp; labour</th>
            </tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td><strong>{j.registration}</strong><div className="text-xs muted">{j.make} {j.model}</div></td>
                  <td>{j.job_type}</td>
                  <td style={{ maxWidth: 280 }}>{j.description}</td>
                  <td><Badge status={STATUS_TONE[j.status] || ''}>{String(j.status).replace(/_/g, ' ')}</Badge></td>
                  <td>{fmtDate(j.created_at)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(j.items_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 26 }}>Due for service</h2>
      {!due?.bikes?.length ? (
        <EmptyState title="Nothing due" sub="Service is worked out from the distance actually ridden, not a date." />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr><th>Bike</th><th>Rider</th><th>Odometer</th><th>Why</th><th>State</th></tr></thead>
            <tbody>
              {due.bikes.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.registration}</strong><div className="text-xs muted">{b.make} {b.model}</div></td>
                  <td>{b.rider_name || '—'}</td>
                  <td>{b.odometer_km != null ? `${Number(b.odometer_km).toLocaleString('en-ZA')} km` : '—'}</td>
                  <td className="text-sm muted">{b.reason === 'distance' ? 'Distance ridden' : 'Service date'}</td>
                  <td><Badge status={DUE_TONE[b.state] || ''}>{String(b.state).replace('_', ' ')}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

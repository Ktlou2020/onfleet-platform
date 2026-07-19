import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../api';
import { Badge, Loading, fmt, fmtDateTime } from '../../components/ui';

const STATUS_COLOR = { open: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };
const PRIORITY_COLOR = { urgent: 'danger', high: 'warning', normal: '', low: '' };

function KPI({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="text-xs muted" style={{ marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

export default function AdminWorkshop() {
  const [data, setData] = useState(null);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/workshop/admin/stats')
      .then((r) => setData(r.data))
      .catch(() => toast.error('Could not load workshop stats'));
  }, []);

  if (!data) return <Loading />;

  const { stats, recent_jobs } = data;

  return (
    <>
      <div className="mb-4">
        <h1 className="page-title">Workshop</h1>
        <p className="page-sub">Overview of all workshop job cards across the fleet</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16, marginBottom: 32 }}>
        <KPI label="Total jobs" value={stats.total_jobs ?? 0} />
        <KPI label="Open" value={stats.open_jobs ?? 0} />
        <KPI label="In progress" value={stats.in_progress_jobs ?? 0} />
        <KPI label="Completed" value={stats.completed_jobs ?? 0} />
        <KPI label="Total revenue" value={fmt(stats.total_revenue ?? 0)} sub="completed jobs" />
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Recent Jobs</h2>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Bike</th>
              <th>Type</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Technician</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
              <th>Created</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {recent_jobs.map((job) => (
              <tr key={job.id}>
                <td className="text-xs muted">{job.id}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{job.display_registration || '—'}</div>
                  <div className="text-xs muted">{job.display_make} {job.display_model}</div>
                </td>
                <td>{job.job_type}</td>
                <td>{job.priority !== 'normal' ? <Badge status={PRIORITY_COLOR[job.priority]}>{job.priority}</Badge> : <span className="muted text-xs">normal</span>}</td>
                <td><Badge status={STATUS_COLOR[job.status]}>{job.status.replace('_', ' ')}</Badge></td>
                <td className="text-sm">{job.technician_name || <span className="muted">—</span>}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(job.total_cost)}</td>
                <td className="text-xs muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(job.created_at)}</td>
                <td className="text-xs muted" style={{ whiteSpace: 'nowrap' }}>{job.completed_at ? fmtDateTime(job.completed_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!recent_jobs.length && (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <p className="muted">No workshop jobs yet.</p>
          </div>
        )}
      </div>
    </>
  );
}

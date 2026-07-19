import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../api';
import { Badge, Loading, fmt, fmtDateTime } from '../../components/ui';

const PRIORITY_COLOR = { urgent: 'danger', high: 'warning', normal: 'info', low: '' };
const STATUS_COLOR = { open: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };

function KPI({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="text-xs muted" style={{ marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

export default function WorkshopDashboard() {
  const [data, setData] = useState(null);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/workshop/dashboard')
      .then((r) => setData(r.data))
      .catch(() => toast.error('Could not load dashboard'));
  }, []);

  if (!data) return <Loading />;

  const { stats, active_jobs } = data;

  return (
    <>
      <div className="mb-4">
        <h1 className="page-title">Workshop Dashboard</h1>
        <p className="page-sub">Live overview of all job cards and today's activity</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16, marginBottom: 32 }}>
        <KPI label="Open" value={stats.open_count ?? 0} />
        <KPI label="In Progress" value={stats.in_progress_count ?? 0} />
        <KPI label="Completed today" value={stats.completed_today ?? 0} />
        <KPI label="Total completed" value={stats.completed_count ?? 0} />
        <KPI label="Revenue today" value={fmt(stats.revenue_today ?? 0)} />
        <KPI label="Total revenue" value={fmt(stats.total_revenue ?? 0)} sub="completed jobs" />
      </div>

      <div className="flex-between mb-3">
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Active Jobs</h2>
        <button className="btn btn-sm" onClick={() => nav('/workshop/app/job-cards')}>View all →</button>
      </div>

      {active_jobs.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <p className="muted">No open or in-progress jobs right now.</p>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => nav('/workshop/app/job-cards')}>Create job card</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {active_jobs.map((job) => (
            <div
              key={job.id}
              className="card"
              style={{ cursor: 'pointer', padding: 16 }}
              onClick={() => nav(`/workshop/app/job-cards/${job.id}`)}
            >
              <div className="flex-between mb-2">
                <Badge status={STATUS_COLOR[job.status]}>{job.status.replace('_', ' ')}</Badge>
                {job.priority !== 'normal' && <Badge status={PRIORITY_COLOR[job.priority]}>{job.priority}</Badge>}
              </div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {job.display_registration || job.display_make} {job.display_model}
              </div>
              {job.display_registration && (
                <div className="text-xs muted">{job.display_make} {job.display_model}</div>
              )}
              <div className="text-xs muted" style={{ marginTop: 6 }}>
                {job.job_type} · {job.technician_name || 'Unassigned'}
              </div>
              {job.description ? (
                <div className="text-xs" style={{ marginTop: 6, color: 'var(--text)', opacity: 0.7, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {job.description}
                </div>
              ) : null}
              <div className="flex-between" style={{ marginTop: 10 }}>
                <span className="text-xs muted">{fmtDateTime(job.created_at)}</span>
                <span className="text-sm" style={{ fontWeight: 600 }}>{fmt(job.total_cost)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

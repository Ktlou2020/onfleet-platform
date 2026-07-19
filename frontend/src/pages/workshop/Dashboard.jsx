import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Zap, Clock, CheckCircle, TrendingUp, AlertTriangle, ArrowRight, CalendarClock } from 'lucide-react';
import api from '../../api';
import { Badge, Loading, fmt, fmtDate, fmtDateTime } from '../../components/ui';
import { useAuth } from '../../auth';

const PRIORITY_BORDER = { urgent: '#ef4444', high: '#f97316', normal: '#3b82f6', low: '#6b7280' };
const STATUS_COLOR = { open: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };
const PRIORITY_COLOR = { urgent: 'danger', high: 'warning', normal: 'info', low: '' };

function elapsed(startedAt) {
  if (!startedAt) return null;
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function KPI({ label, value, icon: Icon, accent }) {
  return (
    <div className="stat" style={{ borderTop: `3px solid ${accent || 'var(--accent)'}` }}>
      <div className="flex-between mb-1">
        <div className="stat-label">{label}</div>
        {Icon && <Icon size={16} style={{ color: accent || 'var(--accent)', opacity: 0.7 }} />}
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function JobCard({ job, onStart, busy }) {
  const nav = useNavigate();
  const elapsedTime = job.status === 'in_progress' ? elapsed(job.started_at) : null;
  return (
    <div
      className="card"
      style={{ padding: 0, cursor: 'pointer', overflow: 'hidden', borderLeft: `4px solid ${PRIORITY_BORDER[job.priority] || PRIORITY_BORDER.normal}` }}
      onClick={() => nav(`/workshop/app/job-cards/${job.id}`)}
    >
      <div style={{ padding: '12px 14px' }}>
        <div className="flex-between mb-2" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Badge status={STATUS_COLOR[job.status]}>{job.status.replace('_', ' ')}</Badge>
          <div style={{ display: 'flex', gap: 6 }}>
            {job.priority !== 'normal' && <Badge status={PRIORITY_COLOR[job.priority]}>{job.priority}</Badge>}
            {elapsedTime && (
              <span style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
                <Clock size={11} /> {elapsedTime}
              </span>
            )}
          </div>
        </div>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>
          {job.display_registration || job.display_make}
        </div>
        <div className="text-xs muted">
          {job.display_make} {job.display_model} · {job.job_type}
        </div>
        {job.description ? (
          <div className="text-xs" style={{ marginTop: 6, opacity: 0.7, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {job.description}
          </div>
        ) : null}
        <div className="flex-between" style={{ marginTop: 10 }}>
          <span className="text-xs muted">{fmtDateTime(job.created_at)}</span>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{fmt(job.total_cost)}</span>
        </div>
      </div>
      {job.status === 'open' && (
        <div
          style={{ borderTop: '1px solid var(--border)', padding: '8px 14px', display: 'flex', justifyContent: 'flex-end' }}
          onClick={(e) => { e.stopPropagation(); onStart(job.id); }}
        >
          <button className="btn btn-sm" disabled={busy}>
            <Zap size={13} /> Start job
          </button>
        </div>
      )}
    </div>
  );
}

export default function WorkshopDashboard() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [upcoming, setUpcoming] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.get('/workshop/dashboard')
      .then((r) => setData(r.data))
      .catch(() => toast.error('Could not load dashboard'));

  useEffect(() => {
    load();
    api.get('/workshop/upcoming-services', { params: { days: 30 } })
      .then((r) => setUpcoming(r.data.bikes || []))
      .catch(() => {});
  }, []);

  const startJob = async (id) => {
    try {
      setBusy(true);
      await api.post(`/workshop/job-cards/${id}/start`);
      toast.success('Job started');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not start job');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Loading />;

  const { stats, active_jobs, my_jobs } = data;
  const myJobIds = new Set(my_jobs.map((j) => j.id));
  const otherActive = active_jobs.filter((j) => !myJobIds.has(j.id));

  return (
    <>
      <div className="mb-4">
        <h1 className="page-title">Workshop Dashboard</h1>
        <p className="page-sub">Welcome back, {user?.full_name?.split(' ')[0]}. Here's your queue for today.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, marginBottom: 32 }}>
        <KPI label="Open jobs" value={stats.open_count ?? 0} icon={AlertTriangle} accent="#f97316" />
        <KPI label="In progress" value={stats.in_progress_count ?? 0} icon={Clock} accent="#eab308" />
        <KPI label="Done today" value={stats.completed_today ?? 0} icon={CheckCircle} accent="#22c55e" />
        <KPI label="Revenue today" value={fmt(stats.revenue_today ?? 0)} icon={TrendingUp} accent="#6366f1" />
        <KPI label="Total revenue" value={fmt(stats.total_revenue ?? 0)} icon={TrendingUp} accent="#8b5cf6" />
      </div>

      {/* My Queue */}
      <div className="flex-between mb-3">
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>My Queue</h2>
        <button className="btn btn-sm btn-secondary" onClick={() => nav('/workshop/app/job-cards')}>
          All job cards <ArrowRight size={13} />
        </button>
      </div>

      {my_jobs.length === 0 ? (
        <div className="card" style={{ padding: '28px 20px', textAlign: 'center', marginBottom: 28 }}>
          <CheckCircle size={28} style={{ color: '#22c55e', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>No jobs assigned to you right now.</p>
          <p className="muted text-sm" style={{ marginTop: 4 }}>Create a job card or ask a supervisor to assign one to you.</p>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => nav('/workshop/app/job-cards')}>Browse all jobs</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14, marginBottom: 28 }}>
          {my_jobs.map((job) => <JobCard key={job.id} job={job} onStart={startJob} busy={busy} />)}
        </div>
      )}

      {/* Other active jobs */}
      {otherActive.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Other Active Jobs</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {otherActive.map((job) => <JobCard key={job.id} job={job} onStart={startJob} busy={busy} />)}
          </div>
        </>
      )}

      {my_jobs.length === 0 && otherActive.length === 0 && (
        <div className="card" style={{ padding: '28px 20px', textAlign: 'center' }}>
          <p className="muted">No open or in-progress jobs at the moment.</p>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => nav('/workshop/app/job-cards')}>
            + Create job card
          </button>
        </div>
      )}

      {/* Upcoming services */}
      {upcoming.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div className="flex-between mb-3">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CalendarClock size={17} style={{ color: 'var(--accent)' }} />
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>Upcoming Services (30 days)</h2>
            </div>
          </div>
          <div className="card table-wrap" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Bike</th>
                  <th>Fleet</th>
                  <th>Next service</th>
                  <th>Next service km</th>
                  <th>Odometer</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((bike) => (
                  <tr key={bike.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{bike.registration || bike.vin || '—'}</div>
                      <div className="text-xs muted">{bike.make} {bike.model}</div>
                    </td>
                    <td className="text-xs muted">{bike.org_name || '—'}</td>
                    <td style={{ color: bike.urgency === 'overdue' ? 'var(--danger)' : undefined, fontWeight: bike.urgency === 'overdue' ? 700 : undefined }}>
                      {fmtDate(bike.next_service_date)}
                      {bike.urgency === 'overdue' && <span className="text-xs" style={{ marginLeft: 6, color: 'var(--danger)' }}>OVERDUE</span>}
                    </td>
                    <td className="text-xs muted">{bike.next_service_km ? `${bike.next_service_km.toLocaleString()} km` : '—'}</td>
                    <td className="text-xs muted">{bike.odometer_km ? `${bike.odometer_km.toLocaleString()} km` : '—'}</td>
                    <td>
                      {bike.active_job_id
                        ? <Badge status="warning">In workshop</Badge>
                        : (
                          <button className="btn btn-sm btn-secondary" onClick={() => nav(`/workshop/app/job-cards?bike=${bike.id}`)}>
                            Create job
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { UserPlus, Users, FileQuestion, Clock, CheckCircle2, XCircle, Hourglass, TrendingUp, RefreshCw } from 'lucide-react';
import api from '../../api';
import { Stat, Loading, fmtDate } from '../../components/ui';

const REFRESH_MS = 60_000;

const STAGE_LABEL = {
  no_application: 'Account only',
  in_progress: 'In progress',
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
};
const STAGE_COLOR = {
  no_application: '#94a3b8',
  in_progress: '#eab308',
  awaiting_review: '#3b82f6',
  approved: '#22c55e',
  rejected: '#ef4444',
};

function StageBadge({ stage }) {
  const color = STAGE_COLOR[stage] || '#94a3b8';
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 100,
      color, background: `${color}26`,
    }}>{STAGE_LABEL[stage] || stage}</span>
  );
}

export default function AdminSignupStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh) => {
    if (isRefresh) setRefreshing(true);
    try {
      const { data } = await api.get('/admin/signup-stats');
      setStats(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (loading || !stats) return <Loading />;

  const chartData = stats.signups_by_day.map((d) => ({
    label: new Date(`${d.day}T12:00:00`).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }),
    count: d.count,
  }));

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Signup Stats</h1>
          <p className="page-sub">Rider signup activity and where applications stall — refreshes every 60s.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} style={{ marginRight: 6 }} /> Refresh
        </button>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="New today" value={stats.signups.today} icon={<UserPlus size={16} />} accent="var(--success)" />
        <Stat label="New last 7 days" value={stats.signups.last7} icon={<UserPlus size={16} />} />
        <Stat label="New last 30 days" value={stats.signups.last30} icon={<TrendingUp size={16} />} />
        <Stat label="Total riders" value={stats.signups.total} icon={<Users size={16} />} />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Account only" value={stats.funnel.no_application} delta="Signed up, no application yet" icon={<FileQuestion size={16} />} accent={stats.funnel.no_application ? 'var(--warn)' : undefined} />
        <Stat label="In progress" value={stats.funnel.in_progress} delta="Bike/docs not yet complete" icon={<Clock size={16} />} accent={stats.funnel.in_progress ? 'var(--warn)' : undefined} />
        <Stat label="Awaiting review" value={stats.funnel.awaiting_review} delta="Docs complete, needs an admin" icon={<Hourglass size={16} />} accent={stats.funnel.awaiting_review ? 'var(--accent)' : undefined} />
        <Stat label="Approved" value={stats.funnel.approved} icon={<CheckCircle2 size={16} />} accent="var(--success)" />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Rejected" value={stats.funnel.rejected} icon={<XCircle size={16} />} accent={stats.funnel.rejected ? 'var(--danger)' : undefined} />
        <Stat label="In retry lockout" value={stats.funnel.in_retry_lockout} delta="Rejected, can't reapply yet" icon={<Clock size={16} />} />
        <Stat label="Approval rate" value={stats.approval_rate != null ? `${stats.approval_rate}%` : '—'} delta="Of decided applications" icon={<TrendingUp size={16} />} accent="var(--success)" />
        <Stat label="Avg days to approval" value={stats.avg_days_to_approval != null ? stats.avg_days_to_approval : '—'} delta="Signup to approval" icon={<Hourglass size={16} />} />
      </div>

      <div className="card mb-4">
        <div className="card-title"><h3>Signups — last 30 days</h3></div>
        {chartData.every((d) => d.count === 0)
          ? <div className="muted text-sm">No signups in the last 30 days.</div>
          : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ left: 0, right: 16, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={2} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={30} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
      </div>

      <div className="card">
        <div className="card-title">
          <h3>Recent signups</h3>
          <Link to="/admin/riders" className="text-sm">Open Riders →</Link>
        </div>
        {stats.recent.length === 0
          ? <div className="muted text-sm">No riders yet.</div>
          : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Rider</th><th>Signed up</th><th>Stage</th></tr></thead>
                <tbody>
                  {stats.recent.map((r) => (
                    <tr key={r.id}>
                      <td>{r.full_name}<div className="text-xs muted">{r.email}</div></td>
                      <td>{fmtDate(r.created_at)}</td>
                      <td>
                        {r.application_id
                          ? <Link to={`/admin/applications/${r.application_id}`}><StageBadge stage={r.stage} /></Link>
                          : <StageBadge stage={r.stage} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </>
  );
}

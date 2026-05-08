import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Stat, Badge, Loading, SearchInput, fmt, fmtDate, EmptyState, matchesSearch } from '../../components/ui';
import { Bike, TrendingUp, Calendar, AlertCircle } from 'lucide-react';

export default function RiderDashboard() {
  const [data, setData] = useState(null);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/agreements/mine'),
      api.get('/applications/mine')
    ]).then(([a, p]) => {
      setApps(p.data.applications);
      const ag = a.data.agreements[0];
      if (ag) api.get(`/agreements/${ag.id}`).then((r) => setData(r.data));
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;

  if (!data) {
    const pending = apps.find((application) => application.status === 'submitted' || application.status === 'under_review');
    return (
      <>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-sub">Get started on your rent-to-own journey</p>
        {pending ? (
          <div className="card">
            <div className="row" style={{ gap: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 10, background: 'rgba(255,182,39,0.15)', display: 'flex', alignItems:'center', justifyContent:'center', color: 'var(--warn)' }}><AlertCircle /></div>
              <div style={{ flex: 1 }}>
                <h3>Application under review</h3>
                <div className="muted text-sm">We'll notify you within 48 hours. Status: <Badge status={pending.status}/></div>
              </div>
              <Link to="/application" className="btn btn-secondary">View</Link>
            </div>
          </div>
        ) : (
          <EmptyState title="No active agreement yet" sub="Submit an application to start your rent-to-own journey." action={<Link to="/application" className="btn">Start application</Link>} />
        )}
      </>
    );
  }

  const { agreement, summary, schedule } = data;
  const upcoming = schedule.filter((item) => item.status !== 'paid' && item.status !== 'waived').slice(0, 5).filter((item) => matchesSearch(search, item.week_number, item.due_date, item.amount_due, item.amount_paid, item.status));
  const quickActions = [
    { label: "💳 Pay this week's fee", link: '/payments', primary: true },
    { label: '📄 Download agreement', link: '/agreements' },
    { label: '⚙️ Update profile', link: '/profile' }
  ].filter((item) => matchesSearch(search, item.label));

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Track your rent-to-own progress</p>

      <div className="row mb-4" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search due dates, statuses, and quick actions" style={{ flex: '1 1 320px', maxWidth: 420 }} />
        <div className="muted text-sm">Showing {upcoming.length + quickActions.length} dashboard matches</div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Total paid" value={fmt(summary.total_paid)} icon={<TrendingUp size={16}/>} />
        <Stat label="Remaining" value={fmt(summary.remaining)} icon={<Calendar size={16}/>} accent="var(--accent)" />
        <Stat label="Weeks paid" value={`${summary.weeks_paid} / ${summary.weeks_total}`} icon={<Bike size={16}/>} />
        <Stat label="Overdue" value={fmt(summary.overdue)} icon={<AlertCircle size={16}/>} accent="var(--danger)" />
      </div>

      <div className="card mb-4" style={{ padding: 0, overflow: 'hidden' }}>
        {agreement.image_url && (
          <div style={{ height: 200, backgroundImage: `url("${agreement.image_url}")`, backgroundSize: 'cover', backgroundPosition: 'center', position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, rgba(13,15,20,0.9))' }} />
            <div style={{ position: 'absolute', bottom: 16, left: 20, right: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div>
                <div className="muted text-xs">YOUR BIKE</div>
                <h2 style={{ fontSize: 24 }}>{agreement.make} {agreement.model}</h2>
              </div>
              <Badge status={agreement.status} />
            </div>
          </div>
        )}
        <div style={{ padding: 20 }}>
          <div className="flex-between mb-3">
            <div>
              {!agreement.image_url && <><div className="muted text-xs">YOUR BIKE</div><h2>{agreement.make} {agreement.model}</h2></>}
              <div className="muted text-sm">Agreement {agreement.agreement_no} · {agreement.registration || agreement.vin}</div>
            </div>
            {!agreement.image_url && <Badge status={agreement.status} />}
          </div>
          <div className="mb-2 flex-between">
            <div className="text-sm">Progress to ownership</div>
            <div className="font-bold">{summary.progress_pct}%</div>
          </div>
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${summary.progress_pct}%` }} /></div>
          <div className="flex-between mt-3 text-sm muted">
            <div>Started {fmtDate(agreement.start_date)}</div>
            <div>Ownership: {fmtDate(agreement.end_date)}</div>
          </div>
          <div className="row mt-4">
            <Link to={`/agreements/${agreement.id}`} className="btn">View agreement</Link>
            <Link to="/payments" className="btn btn-secondary">Make a payment</Link>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="mb-3">Upcoming payments</h3>
          <table className="table">
            <thead><tr><th>Week</th><th>Due date</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {upcoming.map((item) => (
                <tr key={item.id}>
                  <td>#{item.week_number}</td>
                  <td>{fmtDate(item.due_date)}</td>
                  <td>{fmt(item.amount_due - item.amount_paid)}</td>
                  <td><Badge status={item.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!upcoming.length && <div className="muted text-sm">No upcoming payments match your search.</div>}
        </div>
        <div className="card">
          <h3 className="mb-3">Quick actions</h3>
          {quickActions.map((item) => (
            <Link key={item.link} to={item.link} className={`btn ${item.primary ? 'btn-block' : 'btn-secondary btn-block'} mb-2`}>{item.label}</Link>
          ))}
          {!quickActions.length && <div className="muted text-sm">No quick actions match your search.</div>}
        </div>
      </div>
    </>
  );
}

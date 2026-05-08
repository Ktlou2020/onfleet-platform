import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, CartesianGrid, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import api from '../../api';
import { Stat, Loading, SearchInput, fmt, matchesSearch } from '../../components/ui';
import { Users, Bike, AlertCircle, TrendingUp, FileCheck, ShieldCheck, Wrench } from 'lucide-react';

export default function AdminDashboard() {
  const [d, setD] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => { api.get('/admin/dashboard').then((r) => setD(r.data)); }, []);
  if (!d) return <Loading />;
  const s = d.stats;

  const actions = useMemo(() => ([
    { icon: '📋', count: s.pending_applications, label: 'Pending applications', link: '/admin/applications?status=submitted' },
    { icon: '🆔', count: s.pending_kyc, label: 'Application documents to review', link: '/admin/applications' },
    { icon: '⚠️', count: s.overdue_count, label: 'Overdue agreements', link: '/admin/agreements?status=active', danger: true },
    { icon: '🔧', count: s.upcoming_services, label: 'Bikes due for service (14d)', link: '/admin/bikes?status=allocated' },
    { icon: '🛡️', count: s.expiring_insurance, label: 'Insurance expiring (30d)', link: '/admin/bikes' }
  ].filter((item) => matchesSearch(search, item.label, item.count))), [s, search]);

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">Real-time business overview</p>
        </div>
        <Link to="/admin/strategy" className="btn btn-secondary">AI strategy report</Link>
      </div>

      <div className="row mb-4" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search dashboard actions and queues" style={{ flex: '1 1 320px', maxWidth: 420 }} />
        <div className="muted text-sm">Showing {actions.length} action items</div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Total revenue" value={fmt(s.revenue_total)} delta={`${fmt(s.revenue_30d)} last 30 days`} icon={<TrendingUp size={16}/>} accent="var(--success)" />
        <Stat label="Active agreements" value={s.active_agreements} delta={`${s.completed_agreements} completed`} icon={<FileCheck size={16}/>} />
        <Stat label="Riders" value={s.riders} icon={<Users size={16}/>} accent="var(--accent)" />
        <Stat label="Overdue amount" value={fmt(s.overdue_amount)} delta={`${s.overdue_count} agreements`} icon={<AlertCircle size={16}/>} accent="var(--danger)" />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Bikes available" value={s.bikes_available} icon={<Bike size={16}/>} />
        <Stat label="Bikes allocated" value={s.bikes_allocated} icon={<Bike size={16}/>} accent="var(--accent)" />
        <Stat label="In maintenance" value={s.bikes_maintenance} icon={<Wrench size={16}/>} accent="var(--warn)" />
        <Stat label="Documents pending review" value={s.pending_kyc} icon={<ShieldCheck size={16}/>} accent="var(--warn)" />
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Weekly revenue (last 90 days)</h3>
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={d.weekly_revenue}>
                <CartesianGrid stroke="#252b38" vertical={false} />
                <XAxis dataKey="week" stroke="#8a95a8" fontSize={11} />
                <YAxis stroke="#8a95a8" fontSize={11} />
                <Tooltip contentStyle={{ background: '#12151c', border: '1px solid #252b38' }} formatter={(v) => fmt(v)} />
                <Bar dataKey="total" fill="#ff6b35" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h3 className="mb-3">Action queue</h3>
          {actions.map((item) => <ActionItem key={item.label} {...item} />)}
          {!actions.length && <div className="muted text-sm">No dashboard actions match your search.</div>}
        </div>
      </div>
    </>
  );
}

function ActionItem({ icon, count, label, link, danger }) {
  return (
    <Link to={link} style={{ display: 'flex', alignItems:'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>
      <div style={{ fontSize: 20 }}>{icon}</div>
      <div style={{ flex: 1 }}>{label}</div>
      <div className="badge" style={{ background: count > 0 ? (danger ? 'rgba(239,68,68,0.2)' : 'rgba(255,107,53,0.2)') : 'var(--surface-2)', color: count > 0 ? (danger ? 'var(--danger)' : 'var(--primary)') : 'var(--muted)' }}>{count}</div>
    </Link>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import api from '../../api';
import { Loading, Stat, fmt } from '../../components/ui';
import { BrainCircuit, TrendingUp, AlertCircle, Bike, Wallet } from 'lucide-react';

const COLORS = ['#ff6b35', '#ffb627', '#34c759', '#4f46e5', '#9b5cff', '#64748b'];

export default function AdminStrategyReport() {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/admin/strategy-report').then((r) => setData(r.data)); }, []);
  const payoutChart = useMemo(() => (data?.payout_mix || []).map((item) => ({ name: item.label, value: item.count })), [data]);

  if (!data) return <Loading />;

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">AI Strategy Report</h1>
          <p className="page-sub">Internal decision-support summary generated from live platform data.</p>
        </div>
        <div className="badge badge-info">Updated {new Date(data.generated_at).toLocaleString()}</div>
      </div>

      <div className="card mb-4" style={{ background: 'linear-gradient(135deg, rgba(255,107,53,.14), rgba(79,70,229,.16))' }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <BrainCircuit size={18} />
          </div>
          <div>
            <strong>Executive summary</strong>
            <div className="muted text-sm mt-2" style={{ maxWidth: 900 }}>{data.executive_summary}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Credited revenue" value={fmt(data.key_metrics.credited_revenue)} icon={<TrendingUp size={16} />} accent="var(--success)" />
        <Stat label="Transaction fees" value={fmt(data.key_metrics.transaction_fees)} icon={<Wallet size={16} />} accent="var(--warn)" />
        <Stat label="Overdue exposure" value={fmt(data.collections.overdue_amount)} icon={<AlertCircle size={16} />} accent="var(--danger)" />
        <Stat label="Fleet allocated" value={`${data.fleet.allocated} / ${data.fleet.total}`} icon={<Bike size={16} />} accent="var(--accent)" />
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Recommended actions</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {data.insights.map((item, idx) => (
              <div key={idx} className="card" style={{ background: 'var(--surface-2)', padding: 16 }}>
                <div className="flex-between" style={{ gap: 12 }}>
                  <strong>{item.title}</strong>
                  <span className={`badge ${item.priority === 'high' ? 'badge-danger' : item.priority === 'medium' ? 'badge-warn' : 'badge-info'}`}>{item.priority}</span>
                </div>
                <div className="muted text-sm mt-2">{item.finding}</div>
                <div className="mt-2" style={{ fontSize: 14 }}><strong>Action:</strong> {item.action}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 className="mb-3">Application funnel</h3>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={[
                { stage: 'Submitted', total: data.funnel.submitted },
                { stage: 'Under review', total: data.funnel.under_review },
                { stage: 'Approved', total: data.funnel.approved },
                { stage: 'Rejected', total: data.funnel.rejected }
              ]}>
                <CartesianGrid stroke="#252b38" vertical={false} />
                <XAxis dataKey="stage" stroke="#8a95a8" fontSize={11} />
                <YAxis stroke="#8a95a8" fontSize={11} />
                <Tooltip contentStyle={{ background: '#12151c', border: '1px solid #252b38' }} />
                <Bar dataKey="total" fill="#ff6b35" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-2 mt-3">
            <MiniMetric label="Pre-approved" value={data.auto.pre_approved} />
            <MiniMetric label="Auto-declined" value={data.auto.auto_declined} />
            <MiniMetric label="Avg weekly earnings" value={fmt(data.key_metrics.avg_weekly_earnings)} />
            <MiniMetric label="Active agreements" value={data.agreements.active} />
          </div>
        </div>
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Monthly collections</h3>
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={data.monthly_revenue}>
                <CartesianGrid stroke="#252b38" vertical={false} />
                <XAxis dataKey="month" stroke="#8a95a8" fontSize={11} />
                <YAxis stroke="#8a95a8" fontSize={11} />
                <Tooltip contentStyle={{ background: '#12151c', border: '1px solid #252b38' }} formatter={(value) => fmt(value)} />
                <Line type="monotone" dataKey="total" stroke="#34c759" strokeWidth={3} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h3 className="mb-3">Payout preference mix</h3>
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={payoutChart} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={4}>
                  {payoutChart.map((entry, index) => <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#12151c', border: '1px solid #252b38' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {(data.payout_mix || []).map((item, index) => (
              <div key={item.label} className="flex-between text-sm">
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: COLORS[index % COLORS.length], display: 'inline-block' }} />
                  <span>{item.label}</span>
                </div>
                <strong>{item.count} ({item.pct}%)</strong>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="mb-3">Top rider channels</h3>
          <table className="table">
            <thead><tr><th>Platform</th><th>Mentions</th><th>Share</th></tr></thead>
            <tbody>
              {(data.platform_mix || []).map((item) => (
                <tr key={item.label}><td>{item.label}</td><td>{item.count}</td><td>{item.pct}%</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 className="mb-3">Bike ROI leaders</h3>
          <table className="table">
            <thead><tr><th>Bike</th><th>Collected</th><th>Total cost</th><th>ROI</th></tr></thead>
            <tbody>
              {(data.bike_roi || []).slice(0, 6).map((bike) => (
                <tr key={bike.id}>
                  <td>{bike.make} {bike.model}<div className="muted text-xs">{bike.bike_code}</div></td>
                  <td>{fmt(bike.collected)}</td>
                  <td>{fmt(bike.total_cost)}</td>
                  <td style={{ color: bike.roi_pct >= 0 ? 'var(--success)' : 'var(--danger)' }}>{bike.roi_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function MiniMetric({ label, value }) {
  return <div className="card" style={{ background: 'var(--surface-2)', padding: 14 }}><div className="muted text-xs">{label}</div><div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div></div>;
}

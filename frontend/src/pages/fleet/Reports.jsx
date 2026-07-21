import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import api from '../../api';
import { Loading, fmt } from '../../components/ui';

function StatTile({ label, value, sub, color }) {
  return (
    <div className="card" style={{ flex: '1 1 160px', minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || 'var(--fg)', lineHeight: 1.1 }}>{value}</div>
      {sub && <div className="text-xs muted" style={{ marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function CollectionRateTile({ data }) {
  const rate = data.total_due > 0 ? (data.total_paid / data.total_due) * 100 : null;
  const color = rate === null ? 'var(--muted)' : rate >= 90 ? 'var(--success)' : rate >= 70 ? 'var(--warning)' : 'var(--danger)';
  return (
    <div className="card" style={{ flex: '1 1 160px', minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: 6 }}>Collection rate · 30d</div>
      <div style={{ fontSize: 28, fontWeight: 700, color, lineHeight: 1.1 }}>{rate === null ? '—' : `${rate.toFixed(1)}%`}</div>
      <div className="text-xs muted" style={{ marginTop: 4 }}>
        {fmt(data.total_paid)} of {fmt(data.total_due)} due · {data.paid_count} of {data.schedule_count} instalments paid
      </div>
      {rate !== null && (
        <div style={{ marginTop: 8, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, rate)}%`, background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
        </div>
      )}
    </div>
  );
}

function CustomTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((entry, i) => (
        <div key={i} style={{ color: 'var(--fg)' }}>
          {entry.name}: <strong>{formatter ? formatter(entry.value) : entry.value}</strong>
        </div>
      ))}
    </div>
  );
}

function fmtMonth(ym) {
  if (!ym) return '';
  const [year, month] = ym.split('-');
  const d = new Date(Number(year), Number(month) - 1);
  return d.toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' });
}

const AGING_LABELS = ['1–30 days', '31–60 days', '61–90 days', '90+ days'];
const AGING_KEYS = ['band_1_30', 'band_31_60', 'band_61_90', 'band_90plus'];
const AGING_COLORS = ['#F59E0B', '#EA580C', '#DC2626', '#7F1D1D'];

const STATUS_COLORS = {
  active: 'var(--success)',
  paused: 'var(--warning)',
  defaulted: 'var(--danger)',
  completed: 'var(--primary)',
  cancelled: 'var(--muted)',
  discontinued: 'var(--muted)'
};

export default function FleetReports() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/fleet/reports')
      .then(({ data: d }) => setData(d))
      .catch(() => toast.error('Could not load reports'));
  }, []);

  if (!data) return <Loading />;

  const { collection_rate: cr, revenue_trend: rt, aging_bands: ab, utilisation: ut, agreement_breakdown: agBk } = data;

  const utilisationPct = ut.total_bikes > 0 ? Math.round((ut.bikes_with_agreements / ut.total_bikes) * 100) : 0;
  const totalOverdue = AGING_KEYS.reduce((sum, k) => sum + (ab[k] || 0), 0);
  const recentRevenue = rt.length > 0 ? rt[rt.length - 1]?.credited || 0 : 0;

  const agingData = AGING_KEYS.map((k, i) => ({ label: AGING_LABELS[i], value: ab[k] || 0, color: AGING_COLORS[i] })).filter((d) => d.value > 0);
  const agreementData = agBk.map((r) => ({ status: r.status, count: r.count })).sort((a, b) => b.count - a.count);

  return (
    <>
      <div className="flex-between mb-4">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">Fleet performance, revenue trends, overdue aging, and utilisation at a glance.</p>
        </div>
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <CollectionRateTile data={cr} />
        <StatTile
          label="Revenue · last month"
          value={fmt(recentRevenue)}
          sub={`${rt.length} month${rt.length !== 1 ? 's' : ''} of data`}
        />
        <StatTile
          label="Fleet utilisation"
          value={`${utilisationPct}%`}
          sub={`${ut.bikes_with_agreements} of ${ut.total_bikes} bikes on agreement`}
          color={utilisationPct >= 80 ? 'var(--success)' : utilisationPct >= 50 ? 'var(--warning)' : 'var(--danger)'}
        />
        <StatTile
          label="Total overdue balance"
          value={fmt(totalOverdue)}
          sub={totalOverdue > 0 ? 'Across all aging bands' : 'No overdue balance'}
          color={totalOverdue > 0 ? 'var(--danger)' : 'var(--success)'}
        />
      </div>

      {/* Revenue trend */}
      <div className="card mb-4">
        <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Monthly revenue — last 12 months</h3>
        {rt.length === 0 ? (
          <div className="muted text-sm" style={{ padding: '24px 0', textAlign: 'center' }}>No payment data in the last 12 months.</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={rt.map((r) => ({ ...r, label: fmtMonth(r.month) }))} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => `R${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={48} />
              <Tooltip content={<CustomTooltip formatter={(v) => fmt(v)} />} cursor={{ fill: 'var(--surface-2)' }} />
              <Bar dataKey="credited" name="Net rental" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={48} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Bottom row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>

        {/* Overdue aging bands */}
        <div className="card">
          <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Overdue aging</h3>
          {agingData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>✓</div>
              <div style={{ fontWeight: 600, color: 'var(--success)' }}>No overdue balance</div>
              <div className="muted text-xs mt-1">All scheduled payments are current.</div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={agingData.length * 52 + 20}>
              <BarChart data={agingData} layout="vertical" margin={{ top: 0, right: 60, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => `R${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: 'var(--fg)' }} axisLine={false} tickLine={false} width={72} />
                <Tooltip content={<CustomTooltip formatter={(v) => fmt(v)} />} cursor={{ fill: 'var(--surface-2)' }} />
                <Bar dataKey="value" name="Overdue" radius={[0, 4, 4, 0]} maxBarSize={32} label={{ position: 'right', formatter: (v) => v > 0 ? fmt(v) : '', fontSize: 11, fill: 'var(--muted)' }}>
                  {agingData.map((entry, index) => (
                    <Cell key={index} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Agreement breakdown */}
        <div className="card">
          <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Agreement status</h3>
          {agreementData.length === 0 ? (
            <div className="muted text-sm" style={{ textAlign: 'center', padding: '32px 0' }}>No agreements yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {agreementData.map(({ status, count }) => {
                const total = agreementData.reduce((s, r) => s + r.count, 0);
                const pct = total > 0 ? (count / total) * 100 : 0;
                const color = STATUS_COLORS[status] || 'var(--muted)';
                return (
                  <div key={status}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{status.replace(/_/g, ' ')}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{count} ({pct.toFixed(0)}%)</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Fleet utilisation breakdown */}
        <div className="card">
          <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Fleet utilisation</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { label: 'With active agreement', value: ut.bikes_with_agreements, color: 'var(--success)' },
              { label: 'Serviceable, unassigned', value: Math.max(0, ut.serviceable_bikes - ut.bikes_with_agreements), color: 'var(--primary)' },
              { label: 'Not serviceable', value: Math.max(0, ut.total_bikes - ut.serviceable_bikes), color: 'var(--muted)' }
            ].map(({ label, value, color }) => {
              const pct = ut.total_bikes > 0 ? (value / ut.total_bikes) * 100 : 0;
              return (
                <div key={label}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--fg)' }}>{label}</span>
                    <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              );
            })}
            <div className="text-xs muted" style={{ marginTop: 4 }}>{ut.total_bikes} total bikes in your fleet</div>
          </div>
        </div>
      </div>
    </>
  );
}

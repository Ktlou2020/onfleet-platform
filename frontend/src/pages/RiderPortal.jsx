import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { fmt, fmtDate } from '../components/ui';

const STATUS_STYLE = {
  paid:    { background: 'rgba(34,197,94,0.12)',  color: '#16a34a' },
  overdue: { background: 'rgba(239,68,68,0.12)',  color: '#dc2626' },
  partial: { background: 'rgba(234,179,8,0.12)',  color: '#ca8a04' },
  pending: { background: 'rgba(148,163,184,0.12)', color: '#64748b' },
  waived:  { background: 'rgba(148,163,184,0.12)', color: '#64748b' },
};
const AGREE_STATUS = {
  active:       { label: 'Active',       color: '#16a34a' },
  paused:       { label: 'Paused',       color: '#ca8a04' },
  defaulted:    { label: 'Defaulted',    color: '#dc2626' },
  completed:    { label: 'Completed',    color: '#2563eb' },
  cancelled:    { label: 'Cancelled',    color: '#64748b' },
  discontinued: { label: 'Discontinued', color: '#64748b' },
};

function Pill({ status }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.pending;
  return (
    <span style={{ ...style, padding: '2px 10px', borderRadius: 100, fontSize: 12, fontWeight: 600, display: 'inline-block' }}>
      {String(status || '').replace(/_/g, ' ')}
    </span>
  );
}

export default function RiderPortal() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    axios.get(`/api/public/rider-portal/${token}`)
      .then(({ data: d }) => setData(d))
      .catch((err) => setError(err.response?.data?.error || 'Could not load your agreement. The link may be invalid or expired.'));
  }, [token]);

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🔗</div>
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Link unavailable</div>
          <div style={{ color: '#64748b', fontSize: 14 }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ color: '#64748b', fontSize: 14 }}>Loading your agreement…</div>
      </div>
    );
  }

  const { agreement: a, schedule, payments, summary: s } = data;
  const agreStatus = AGREE_STATUS[a.status] || { label: a.status, color: '#64748b' };

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', minHeight: '100vh', background: '#f8fafc', color: '#1e293b' }}>
      {/* Header */}
      <div style={{ background: '#1e293b', color: '#f8fafc', padding: '20px 24px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 4 }}>{a.org_name || 'Fleet'}{a.org_city ? ` · ${a.org_city}` : ''}</div>
          <div style={{ fontWeight: 700, fontSize: 22 }}>Your agreement</div>
          <div style={{ fontSize: 14, opacity: 0.7, marginTop: 2 }}>{a.rider_name}</div>
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px' }}>

        {/* Agreement summary */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{a.agreement_no}</div>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
                {a.make} {a.model}{a.year ? ` (${a.year})` : ''}{a.registration ? ` · ${a.registration}` : ''}
              </div>
            </div>
            <span style={{ background: `${agreStatus.color}18`, color: agreStatus.color, padding: '4px 12px', borderRadius: 100, fontSize: 13, fontWeight: 600 }}>
              {agreStatus.label}
            </span>
          </div>

          {/* Stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Total contract', value: fmt(a.total_amount) },
              { label: 'Paid to date',   value: fmt(s.total_paid), color: '#16a34a' },
              { label: 'Remaining',      value: fmt(s.remaining),  color: '#2563eb' },
              { label: 'Overdue',        value: fmt(s.overdue),    color: s.overdue > 0 ? '#dc2626' : '#64748b' }
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: '#f8fafc', borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                <div style={{ fontWeight: 700, fontSize: 18, color: color || '#1e293b' }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Progress bar */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', marginBottom: 6 }}>
              <span>Progress to ownership</span>
              <span>{s.weeks_paid} / {s.weeks_total} weeks paid</span>
            </div>
            <div style={{ height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${s.progress_pct}%`, background: '#2563eb', borderRadius: 4, transition: 'width 0.4s' }} />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', marginTop: 8 }}>
            <span>Start {fmtDate(a.start_date)}</span>
            <span style={{ fontWeight: 700, color: '#2563eb' }}>{s.progress_pct}% complete</span>
            <span>End {fmtDate(a.end_date)}</span>
          </div>
        </div>

        {/* Payment details row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Weekly rental</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#2563eb' }}>{fmt(a.weekly_amount)}</div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>per week · {a.total_weeks} weeks total</div>
          </div>
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Agreement dates</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: '#64748b' }}>Start date</span><strong>{fmtDate(a.start_date)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: '#64748b' }}>End date</span><strong>{fmtDate(a.end_date)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: '#64748b' }}>Bike colour</span><strong style={{ textTransform: 'capitalize' }}>{a.color || '—'}</strong>
              </div>
            </div>
          </div>
        </div>

        {/* Payment schedule */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Payment schedule</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                  {['Wk', 'Due date', 'Amount due', 'Paid', 'Status'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.week_number} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '8px 10px', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{row.week_number}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{fmtDate(row.due_date)}</td>
                    <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{fmt(row.amount_due)}</td>
                    <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums', color: row.amount_paid > 0 ? '#16a34a' : '#64748b' }}>{fmt(row.amount_paid)}</td>
                    <td style={{ padding: '8px 10px' }}><Pill status={row.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Payment history */}
        {payments.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Payment history</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                    {['Date', 'Amount', 'Method', 'Reference'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{fmtDate(p.paid_at)}</td>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: '#16a34a', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.net_amount)}</td>
                      <td style={{ padding: '8px 10px', textTransform: 'uppercase', fontSize: 11, color: '#64748b' }}>{p.method}</td>
                      <td style={{ padding: '8px 10px', color: '#64748b', fontSize: 12 }}>{p.reference || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8, paddingBottom: 32 }}>
          This is a read-only summary. Contact {a.org_name || 'your fleet operator'} for any queries.
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Stat, Modal, fmt, fmtDate, fmtDateTime } from '../../components/ui';

export default function AdminAgreementDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [showPay, setShowPay] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'eft', reference: '', notes: '' });

  const load = () => api.get(`/agreements/${id}`).then(r => { setData(r.data); setPay(p => ({ ...p, amount: r.data.agreement.weekly_amount })); });
  useEffect(() => { load(); }, [id]);
  if (!data) return <Loading />;
  const { agreement, schedule, payments, summary } = data;

  const recordPayment = async () => {
    try { await api.post('/payments/manual', { agreement_id: +id, ...pay, amount: +pay.amount });
      toast.success('Payment recorded'); setShowPay(false); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const updateStatus = async (status) => {
    if (!confirm(`Change status to ${status}?`)) return;
    await api.post(`/agreements/${id}/status`, { status });
    toast.success('Status updated'); load();
  };

  return (
    <>
      <Link to="/admin/agreements" className="muted text-sm">← Back</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">{agreement.agreement_no}</h1>
          <div className="muted">{agreement.full_name} · {agreement.make} {agreement.model}</div>
        </div>
        <Badge status={agreement.status} />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Total contract" value={fmt(agreement.total_amount)} />
        <Stat label="Paid" value={fmt(summary.total_paid)} accent="var(--success)" />
        <Stat label="Remaining" value={fmt(summary.remaining)} accent="var(--accent)" />
        <Stat label="Overdue" value={fmt(summary.overdue)} accent="var(--danger)" />
      </div>

      <div className="card mb-4">
        <div className="flex-between mb-3">
          <h3>Progress to ownership · {summary.progress_pct}%</h3>
          <div className="row">
            <button className="btn btn-sm" onClick={() => setShowPay(true)}>+ Record manual payment</button>
            {agreement.status === 'active' && <button className="btn btn-sm btn-secondary" onClick={() => updateStatus('paused')}>Pause</button>}
            {agreement.status === 'paused' && <button className="btn btn-sm btn-secondary" onClick={() => updateStatus('active')}>Resume</button>}
            {agreement.status !== 'completed' && <button className="btn btn-sm btn-success" onClick={() => updateStatus('completed')}>Mark completed</button>}
            {agreement.status === 'active' && <button className="btn btn-sm btn-danger" onClick={() => updateStatus('defaulted')}>Default</button>}
          </div>
        </div>
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${summary.progress_pct}%` }} /></div>
        <div className="flex-between mt-3 text-sm muted">
          <div>Start {fmtDate(agreement.start_date)}</div>
          <div>{summary.weeks_paid} / {summary.weeks_total} weeks</div>
          <div>End {fmtDate(agreement.end_date)}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="mb-3">Payment schedule</h3>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>#</th><th>Due</th><th>Paid</th><th>Status</th></tr></thead>
              <tbody>
                {schedule.map(s => (
                  <tr key={s.id}><td>{s.week_number}</td><td>{fmtDate(s.due_date)}</td>
                    <td>{fmt(s.amount_paid)} / {fmt(s.amount_due)}</td>
                    <td><Badge status={s.status}/></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3 className="mb-3">Payment history</h3>
          <table className="table">
            <thead><tr><th>Date</th><th>Method</th><th>Ref</th><th>Status</th><th>Amount</th></tr></thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id}>
                  <td>{fmtDateTime(p.paid_at)}</td>
                  <td>{p.method}</td>
                  <td className="text-xs muted">{p.reference}</td>
                  <td><Badge status={p.status}/></td>
                  <td><strong>{fmt(p.amount)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showPay && <Modal title="Record manual payment" onClose={() => setShowPay(false)}>
        <div className="grid grid-2">
          <div className="field"><label className="label">Amount</label>
            <input type="number" value={pay.amount} onChange={e => setPay({...pay, amount: e.target.value})} /></div>
          <div className="field"><label className="label">Method</label>
            <select value={pay.method} onChange={e => setPay({...pay, method: e.target.value})}>
              <option value="eft">EFT</option><option value="cash">Cash</option>
              <option value="card">Card</option><option value="other">Other</option>
            </select></div>
        </div>
        <div className="field"><label className="label">Reference (optional)</label>
          <input value={pay.reference} onChange={e => setPay({...pay, reference: e.target.value})} /></div>
        <div className="field"><label className="label">Notes</label>
          <textarea rows={3} value={pay.notes} onChange={e => setPay({...pay, notes: e.target.value})} /></div>
        <div className="row"><button className="btn" onClick={recordPayment}>Record</button>
          <button className="btn btn-secondary" onClick={() => setShowPay(false)}>Cancel</button></div>
      </Modal>}
    </>
  );
}

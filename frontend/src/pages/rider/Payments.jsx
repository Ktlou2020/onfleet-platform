import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, fmt, fmtDate, EmptyState } from '../../components/ui';
import { CreditCard } from 'lucide-react';

const calcFee = (amt) => +(Number(amt || 0) * 0.029 + 1).toFixed(2);
const calcGross = (amt) => +(Number(amt || 0) + calcFee(amt)).toFixed(2);
const creditedAmount = (payment) => Number(payment?.net_amount || payment?.amount || 0);
const feeAmount = (payment) => Number(payment?.fee_amount || 0);
const grossAmount = (payment) => Number(payment?.amount || 0);

export default function RiderPayments() {
  const [agreements, setAgreements] = useState(null);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [feeInfo, setFeeInfo] = useState(null);

  useEffect(() => {
    api.get('/agreements/mine').then((r) => {
      setAgreements(r.data.agreements);
      if (r.data.agreements[0]) setSelected(r.data.agreements[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.get(`/agreements/${selected}`).then((r) => {
      setData(r.data);
      updateAmount(r.data.agreement.weekly_amount);
    });
  }, [selected]);

  function updateAmount(val) {
    setAmount(val);
    const n = Number(val);
    if (n > 0) setFeeInfo({ amount: n, fee: calcFee(n), gross: calcGross(n) });
    else setFeeInfo(null);
  }

  const pay = async () => {
    if (!amount || Number(amount) < 1) return toast.error('Enter an amount');
    setBusy(true);
    try {
      const { data: d } = await api.post('/payments/paystack/init', { agreement_id: selected, amount: Number(amount) });
      window.location.href = d.authorization_url;
    } catch (e) {
      toast.error(e.response?.data?.error || 'Payment init failed. Configure Paystack keys in backend environment.');
      setBusy(false);
    }
  };

  if (!agreements) return <Loading />;
  if (!agreements.length) return <EmptyState title="No active agreement" sub="You need an approved agreement to make payments." />;

  return (
    <>
      <h1 className="page-title">Make a payment</h1>
      <p className="page-sub">Your agreement is credited with the rental amount. The gateway fee is shown separately for transparency.</p>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="mb-3">Pay your rental</h3>
          {data && (
            <>
              <div className="field"><label className="label">Agreement</label>
                <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
                  {agreements.map((a) => <option key={a.id} value={a.id}>{a.agreement_no} — {a.make} {a.model}</option>)}
                </select>
              </div>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <div className="flex-between"><span className="muted">Weekly rental</span><strong>{fmt(data.agreement.weekly_amount)}</strong></div>
                <div className="flex-between"><span className="muted">Amount received against agreement</span><strong>{fmt(data.summary.total_paid)}</strong></div>
                <div className="flex-between"><span className="muted">Outstanding balance</span><strong>{fmt(data.summary.remaining)}</strong></div>
                <div className="flex-between"><span className="muted">Overdue amount</span><strong style={{ color: data.summary.overdue > 0 ? 'var(--danger)' : '' }}>{fmt(data.summary.overdue)}</strong></div>
              </div>
              <div className="field"><label className="label">Rental amount to credit (ZAR)</label>
                <input type="number" value={amount} onChange={(e) => updateAmount(e.target.value)} min="1" /></div>
              {feeInfo && (
                <div className="card mb-3" style={{ background: 'var(--surface-2)', fontSize: '0.9rem' }}>
                  <div className="flex-between"><span className="muted">Rental amount credited</span><strong>{fmt(feeInfo.amount)}</strong></div>
                  <div className="flex-between"><span className="muted">Paystack fee (2.9% + R1)</span><strong style={{ color: 'var(--warn)' }}>{fmt(feeInfo.fee)}</strong></div>
                  <div className="flex-between" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}><span className="muted">Total charged today</span><strong style={{ color: 'var(--accent)' }}>{fmt(feeInfo.gross)}</strong></div>
                </div>
              )}
              <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => updateAmount(data.agreement.weekly_amount)}>1 week</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => updateAmount(Number(data.agreement.weekly_amount) * 2)}>2 weeks</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => updateAmount(Number(data.agreement.weekly_amount) * 4)}>1 month</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => updateAmount(data.summary.remaining)}>Pay off</button>
              </div>
              <button className="btn btn-block" onClick={pay} disabled={busy}><CreditCard size={16} />{busy ? 'Redirecting…' : `Pay ${fmt(feeInfo?.gross || amount)} via Paystack`}</button>
              <div className="muted text-xs mt-3">Recent transactions below show the rental amount credited separately from the gateway fee.</div>
            </>
          )}
        </div>
        {data && (
          <div className="card">
            <h3 className="mb-3">Recent transactions</h3>
            <table className="table">
              <thead><tr><th>Date</th><th>Method</th><th>Status</th><th>Rental</th><th>Fee</th><th>Gross</th></tr></thead>
              <tbody>
                {data.payments.length ? data.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paid_at || p.created_at)}</td>
                    <td>{p.method}</td>
                    <td><Badge status={p.status} /></td>
                    <td><strong>{fmt(creditedAmount(p))}</strong></td>
                    <td>{feeAmount(p) > 0 ? fmt(feeAmount(p)) : '—'}</td>
                    <td>{fmt(grossAmount(p))}</td>
                  </tr>
                )) : <tr><td colSpan="6" className="muted">No payments yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

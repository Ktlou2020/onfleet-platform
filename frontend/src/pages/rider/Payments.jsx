import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, fmt, fmtDate, EmptyState } from '../../components/ui';
import { CreditCard } from 'lucide-react';

export default function RiderPayments() {
  const [agreements, setAgreements] = useState(null);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [feeInfo, setFeeInfo] = useState(null);

  useEffect(() => {
    api.get('/agreements/mine').then(r => {
      setAgreements(r.data.agreements);
      if (r.data.agreements[0]) setSelected(r.data.agreements[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.get(`/agreements/${selected}`).then(r => {
      setData(r.data);
      setAmount(r.data.agreement.weekly_amount);
      setFeeInfo({ amount: r.data.agreement.weekly_amount, fee: calcFee(r.data.agreement.weekly_amount), net: calcNet(r.data.agreement.weekly_amount) });
    });
  }, [selected]);

  // Paystack fee: 2.9% + R1 added on top — net (credit to agreement) stays as entered
  function calcFee(amt) { return +(amt * 0.029 + 1).toFixed(2); }
  function calcGross(amt) { return +(amt + calcFee(amt)).toFixed(2); }

  function updateAmount(val) {
    setAmount(val);
    const n = +val;
    if (n > 0) setFeeInfo({ amount: n, fee: calcFee(n), gross: calcGross(n) });
    else setFeeInfo(null);
  }

  const pay = async () => {
    if (!amount || +amount < 1) return toast.error('Enter an amount');
    setBusy(true);
    try {
      const { data: d } = await api.post('/payments/paystack/init', { agreement_id: selected, amount: +amount });
      window.location.href = d.authorization_url;
    } catch (e) {
      toast.error(e.response?.data?.error || 'Payment init failed. (Configure Paystack keys in backend .env)');
      setBusy(false);
    }
  };

  if (!agreements) return <Loading />;
  if (!agreements.length) return <EmptyState title="No active agreement" sub="You need an approved agreement to make payments." />;

  return (
    <>
      <h1 className="page-title">Make a payment</h1>
      <p className="page-sub">Pay your weekly fee securely via Paystack</p>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="mb-3">Pay this week</h3>
          {data && (
            <>
              <div className="field"><label className="label">Agreement</label>
                <select value={selected} onChange={e => setSelected(+e.target.value)}>
                  {agreements.map(a => <option key={a.id} value={a.id}>{a.agreement_no} — {a.make} {a.model}</option>)}
                </select></div>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <div className="flex-between"><span className="muted">Weekly</span><strong>{fmt(data.agreement.weekly_amount)}</strong></div>
                <div className="flex-between"><span className="muted">Outstanding</span><strong>{fmt(data.summary.remaining)}</strong></div>
                <div className="flex-between"><span className="muted">Overdue</span><strong style={{ color: data.summary.overdue > 0 ? 'var(--danger)' : '' }}>{fmt(data.summary.overdue)}</strong></div>
              </div>
              <div className="field"><label className="label">Amount (ZAR)</label>
                <input type="number" value={amount} onChange={e => updateAmount(e.target.value)} min="1" /></div>
              {feeInfo && (
                <div className="card mb-3" style={{ background: 'var(--surface-2)', fontSize: '0.85rem' }}>
                  <div className="flex-between"><span className="muted">Amount credited to agreement</span><strong>{fmt(feeInfo.amount)}</strong></div>
                  <div className="flex-between"><span className="muted">+ Paystack fee (2.9% + R1)</span><strong style={{ color: 'var(--warn)' }}>+ R{feeInfo.fee.toFixed(2)}</strong></div>
                  <div className="flex-between" style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                    <span className="muted">Total you pay</span><strong style={{ color: 'var(--accent)' }}>{fmt(feeInfo.gross)}</strong></div>
                </div>
              )}
              <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => updateAmount(data.agreement.weekly_amount)}>1 week</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => updateAmount(data.agreement.weekly_amount * 2)}>2 weeks</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => updateAmount(data.agreement.weekly_amount * 4)}>1 month</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => updateAmount(data.summary.remaining)}>Pay off</button>
              </div>
              <button className="btn btn-block" onClick={pay} disabled={busy}><CreditCard size={16} />{busy ? 'Redirecting…' : `Pay ${fmt(amount)} via Paystack`}</button>
              <div className="muted text-xs mt-3">Secure payment via Paystack · Fee: 2.9% + R1 per transaction · Visa, Mastercard, EFT.</div>
            </>
          )}
        </div>
        {data && (
          <div className="card">
            <h3 className="mb-3">Recent payments</h3>
            <table className="table">
              <thead><tr><th>Date</th><th>Method</th><th>Status</th><th>Amount</th></tr></thead>
              <tbody>
                {data.payments.length ? data.payments.map(p => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paid_at || p.created_at)}</td>
                    <td>{p.method}</td>
                    <td><Badge status={p.status}/></td>
                    <td><strong>{fmt(p.amount)}</strong></td>
                    {p.fee_amount > 0 && <td className="muted text-xs">fee R{p.fee_amount.toFixed(2)}</td>}
                  </tr>
                )) : <tr><td colSpan="4" className="muted">No payments yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

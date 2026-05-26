import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, SearchInput, Pagination, fmt, fmtDate, EmptyState, matchesSearch, paginateItems } from '../../components/ui';
import { trackAnalyticsEvent } from '../../analytics';
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
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(8);

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
  useEffect(() => { setPage(1); }, [search, selected]);

  const filteredPayments = useMemo(() => (data?.payments || []).filter((payment) => matchesSearch(
    search,
    payment.method,
    payment.status,
    payment.reference,
    payment.amount,
    payment.net_amount,
    payment.fee_amount,
    payment.paid_at,
    payment.created_at
  )), [data, search]);

  const pagination = useMemo(() => paginateItems(filteredPayments, page, pageSize), [filteredPayments, page, pageSize]);

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
      const paymentAmount = Number(amount);
      const { data: d } = await api.post('/payments/paystack/init', { agreement_id: selected, amount: paymentAmount });
      trackAnalyticsEvent('begin_checkout', {
        currency: 'ZAR',
        value: paymentAmount,
        agreement_id: selected,
        payment_gateway: 'paystack'
      });
      window.location.href = d.authorization_url;
    } catch (e) {
      trackAnalyticsEvent('begin_checkout_failed', {
        agreement_id: selected,
        error_message: e.response?.data?.error || 'Payment init failed'
      });
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
                  {agreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.agreement_no} — {agreement.make} {agreement.model}</option>)}
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
            <div className="flex-between mb-3" style={{ gap: 12, flexWrap: 'wrap' }}>
              <h3 style={{ marginBottom: 0 }}>Recent transactions</h3>
              <SearchInput value={search} onChange={setSearch} placeholder="Search date, method, status, reference" style={{ width: 320 }} />
            </div>
            <table className="table">
              <thead><tr><th>Date</th><th>Method</th><th>Status</th><th>Rental</th><th>Fee</th><th>Gross</th></tr></thead>
              <tbody>
                {pagination.items.length ? pagination.items.map((payment) => (
                  <tr key={payment.id}>
                    <td>{fmtDate(payment.paid_at || payment.created_at)}</td>
                    <td>{payment.method}</td>
                    <td><Badge status={payment.status} /></td>
                    <td><strong>{fmt(creditedAmount(payment))}</strong></td>
                    <td>{feeAmount(payment) > 0 ? fmt(feeAmount(payment)) : '—'}</td>
                    <td>{fmt(grossAmount(payment))}</td>
                  </tr>
                )) : <tr><td colSpan="6" className="muted">{search ? 'No transactions match your search.' : 'No payments yet.'}</td></tr>}
              </tbody>
            </table>
            <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="transactions" />
          </div>
        )}
      </div>
    </>
  );
}

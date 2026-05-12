import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, EmptyState, Loading, Modal, Pagination, SearchInput, fmt, fmtDateTime, matchesSearch, paginateItems } from '../../components/ui';

const METHOD_OPTIONS = ['eft', 'cash', 'card', 'other'];
const creditedAmount = (payment) => Number(payment?.net_amount || payment?.amount || 0);
const feeAmount = (payment) => Number(payment?.fee_amount || 0);
const grossAmount = (payment) => Number(payment?.amount || 0);

export default function FleetOwnerPayments() {
  const { user } = useAuth();
  const canManage = ['fleet_owner_admin', 'fleet_owner_billing'].includes(user?.role);
  const [payments, setPayments] = useState(null);
  const [agreements, setAgreements] = useState([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [selectedIds, setSelectedIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [pay, setPay] = useState({ agreement_id: '', amount: '', method: 'eft', reference: '', notes: '' });

  const load = async () => {
    const [paymentsResponse, portalResponse] = await Promise.all([
      api.get('/fleet/payments'),
      api.get('/fleet/portal-data')
    ]);
    setPayments(paymentsResponse.data.payments);
    setAgreements((portalResponse.data.agreements || []).filter((agreement) => ['active', 'paused', 'defaulted'].includes(agreement.status)));
  };

  useEffect(() => { load().catch(() => toast.error('Could not load payments')); }, []);
  useEffect(() => { setPage(1); }, [search]);
  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => (payments || []).some((payment) => payment.id === id)));
  }, [payments]);

  const filtered = useMemo(() => (payments || []).filter((payment) => matchesSearch(
    search,
    payment.full_name,
    payment.email,
    payment.agreement_no,
    payment.reference,
    payment.method,
    payment.status,
    payment.amount,
    payment.net_amount,
    payment.fee_amount,
    payment.bike_registration
  )), [payments, search]);

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);
  const visibleIds = pagination.items.map((payment) => payment.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const totalCredited = useMemo(() => (payments || []).filter((p) => p.status === 'success').reduce((sum, p) => sum + creditedAmount(p), 0), [payments]);
  const totalFees = useMemo(() => (payments || []).filter((p) => p.status === 'success').reduce((sum, p) => sum + feeAmount(p), 0), [payments]);
  const totalGross = useMemo(() => (payments || []).filter((p) => p.status === 'success').reduce((sum, p) => sum + grossAmount(p), 0), [payments]);

  const toggleSelected = (paymentId) => {
    setSelectedIds((current) => current.includes(paymentId)
      ? current.filter((id) => id !== paymentId)
      : [...current, paymentId]);
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      if (allVisibleSelected) return current.filter((id) => !visibleIds.includes(id));
      return Array.from(new Set([...current, ...visibleIds]));
    });
  };

  const recordPayment = async () => {
    try {
      setBusy(true);
      await api.post('/fleet/payments/manual', { ...pay, agreement_id: Number(pay.agreement_id), amount: Number(pay.amount) });
      toast.success('Payment recorded');
      setShowPay(false);
      setPay({ agreement_id: '', amount: '', method: 'eft', reference: '', notes: '' });
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not record payment');
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!selectedIds.length) return toast.error('Select at least one payment first');
    if (!window.confirm(`Delete ${selectedIds.length} selected payment(s)? Payment schedules will be recalculated.`)) return;
    try {
      setBusy(true);
      const { data } = await api.post('/fleet/payments/bulk-delete', { payment_ids: selectedIds });
      toast.success(`Deleted ${data.deleted_count} payment(s)`);
      setSelectedIds([]);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not delete selected payments');
    } finally {
      setBusy(false);
    }
  };

  if (!payments) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Payments</h1>
          <p className="page-sub">Rental received {fmt(totalCredited)} · Gateway fees {fmt(totalFees)} · Gross processed {fmt(totalGross)}</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {canManage && <button className="btn btn-sm" onClick={() => setShowPay(true)}>+ Record manual payment</button>}
          {canManage && <button className="btn btn-sm btn-danger" onClick={deleteSelected} disabled={!selectedIds.length || busy}>{busy ? 'Deleting…' : 'Delete selected'}</button>}
        </div>
      </div>

      <div className="row mb-4" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search rider, agreement, reference, method" style={{ flex: '1 1 320px', maxWidth: 440 }} />
        <div className="muted text-sm">{selectedIds.length} selected · Showing {filtered.length} matching payments</div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th style={{ width: 44 }}><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all visible payments" /></th><th>Date</th><th>Rider</th><th>Agreement</th><th>Bike</th><th>Method</th><th>Reference</th><th>Status</th><th>Rental</th><th>Fee</th><th>Gross</th></tr></thead>
          <tbody>
            {pagination.items.map((payment) => (
              <tr key={payment.id}>
                <td><input type="checkbox" checked={selectedIds.includes(payment.id)} onChange={() => toggleSelected(payment.id)} aria-label={`Select payment ${payment.reference || payment.id}`} /></td>
                <td>{fmtDateTime(payment.paid_at || payment.created_at)}</td>
                <td>{payment.full_name}<div className="text-xs muted">{payment.email}</div></td>
                <td>{payment.agreement_no}<div className="text-xs muted">{payment.agreement_status}</div></td>
                <td>{payment.bike_registration || '—'}</td>
                <td><Badge>{payment.method}</Badge></td>
                <td className="text-xs muted">{payment.reference || '—'}</td>
                <td><Badge status={payment.status}>{payment.status}</Badge></td>
                <td><strong>{fmt(creditedAmount(payment))}</strong></td>
                <td>{feeAmount(payment) > 0 ? fmt(feeAmount(payment)) : '—'}</td>
                <td>{fmt(grossAmount(payment))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pagination.items.length && <EmptyState title="No payments yet" sub={search ? 'No payments match your current search terms.' : 'Payments recorded for your agreements will appear here.'} action={canManage ? <button className="btn" onClick={() => setShowPay(true)}>Record manual payment</button> : null} />}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="payments" />

      {showPay && (
        <Modal title="Record manual payment" onClose={() => setShowPay(false)}>
          <div className="grid grid-2">
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Agreement</label><select value={pay.agreement_id} onChange={(e) => setPay({ ...pay, agreement_id: e.target.value, amount: pay.amount || agreements.find((agreement) => String(agreement.id) === e.target.value)?.weekly_amount || '' })}><option value="">Select agreement</option>{agreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.agreement_no} · {agreement.rider_name} · {agreement.bike_registration || `${agreement.make} ${agreement.model}`}</option>)}</select></div>
            <div className="field"><label className="label">Amount</label><input type="number" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></div>
            <div className="field"><label className="label">Method</label><select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{METHOD_OPTIONS.map((method) => <option key={method} value={method}>{method.toUpperCase()}</option>)}</select></div>
          </div>
          <div className="field"><label className="label">Reference</label><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="Optional bank or cash reference" /></div>
          <div className="field"><label className="label">Notes</label><textarea rows={3} value={pay.notes} onChange={(e) => setPay({ ...pay, notes: e.target.value })} /></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setShowPay(false)}>Cancel</button>
            <button className="btn" onClick={recordPayment} disabled={busy || !pay.agreement_id || !pay.amount}>{busy ? 'Saving…' : 'Record payment'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

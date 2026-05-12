import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, SearchInput, Pagination, fmt, fmtDateTime, matchesSearch, paginateItems } from '../../components/ui';
import { sortNewestFirst } from '../../utils/sortNewestFirst';

const creditedAmount = (payment) => Number(payment?.net_amount || payment?.amount || 0);
const feeAmount = (payment) => Number(payment?.fee_amount || 0);
const grossAmount = (payment) => Number(payment?.amount || 0);

export default function AdminPayments() {
  const [list, setList] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [selectedIds, setSelectedIds] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = () => api.get('/payments/all').then((r) => setList(r.data.payments));

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(1); }, [search]);
  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => (list || []).some((payment) => payment.id === id)));
  }, [list]);

  const payments = list || [];
  const filtered = useMemo(() => sortNewestFirst(payments.filter((payment) => matchesSearch(
    search,
    payment.full_name,
    payment.email,
    payment.agreement_no,
    payment.reference,
    payment.method,
    payment.status,
    payment.amount,
    payment.net_amount,
    payment.fee_amount
  )), ['paid_at', 'created_at', 'id']), [payments, search]);

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);
  const visibleIds = pagination.items.map((payment) => payment.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const totalCredited = useMemo(() => payments.filter((p) => p.status === 'success').reduce((sum, p) => sum + creditedAmount(p), 0), [payments]);
  const totalFees = useMemo(() => payments.filter((p) => p.status === 'success').reduce((sum, p) => sum + feeAmount(p), 0), [payments]);
  const totalGross = useMemo(() => payments.filter((p) => p.status === 'success').reduce((sum, p) => sum + grossAmount(p), 0), [payments]);

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

  const selectAllFiltered = () => setSelectedIds(filtered.map((payment) => payment.id));
  const clearSelected = () => setSelectedIds([]);

  const deleteSelected = async () => {
    if (!selectedIds.length) return toast.error('Select at least one payment first');
    if (!window.confirm(`Delete ${selectedIds.length} selected payment(s)? This will also recalculate affected payment schedules.`)) return;
    setBusy(true);
    try {
      const { data } = await api.post('/payments/bulk-delete', { payment_ids: selectedIds });
      toast.success(`Deleted ${data.deleted_count} payment(s)${data.not_found_count ? `, skipped ${data.not_found_count}` : ''}`);
      setSelectedIds([]);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not delete selected payments');
    } finally {
      setBusy(false);
    }
  };

  if (!list) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Payments</h1>
          <p className="page-sub">Rental received {fmt(totalCredited)} · Gateway fees {fmt(totalFees)} · Gross charged {fmt(totalGross)}</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-secondary" onClick={selectAllFiltered} disabled={!filtered.length}>Select all filtered</button>
          <button className="btn btn-sm btn-secondary" onClick={clearSelected} disabled={!selectedIds.length}>Clear selected</button>
          <button className="btn btn-sm btn-danger" onClick={deleteSelected} disabled={!selectedIds.length || busy}>{busy ? 'Deleting…' : 'Delete selected'}</button>
        </div>
      </div>
      <div className="row mb-4" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search rider, agreement, reference, method" style={{ flex: '1 1 320px', maxWidth: 440 }} />
        <div className="muted text-sm">{selectedIds.length} selected · Showing {filtered.length} matching payments</div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th style={{ width: 44 }}><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all visible payments" /></th><th>Date</th><th>Rider</th><th>Agreement</th><th>Method</th><th>Reference</th><th>Status</th><th>Rental</th><th>Fee</th><th>Gross</th></tr></thead>
          <tbody>
            {pagination.items.map((p) => (
              <tr key={p.id}>
                <td><input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggleSelected(p.id)} aria-label={`Select payment ${p.reference || p.id}`} /></td>
                <td>{fmtDateTime(p.paid_at || p.created_at)}</td>
                <td>{p.full_name}<div className="text-xs muted">{p.email}</div></td>
                <td><Link to={`/admin/agreements/${p.agreement_id}`}>{p.agreement_no}</Link></td>
                <td><Badge>{p.method}</Badge></td>
                <td className="text-xs muted">{p.reference}</td>
                <td><Badge status={p.status} /></td>
                <td><strong>{fmt(creditedAmount(p))}</strong></td>
                <td>{feeAmount(p) > 0 ? fmt(feeAmount(p)) : '—'}</td>
                <td>{fmt(grossAmount(p))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pagination.items.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{search ? 'No payments match your search.' : 'No payments yet.'}</div>}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="payments" />
    </>
  );
}

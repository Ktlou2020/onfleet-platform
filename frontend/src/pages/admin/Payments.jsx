import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Loading, Badge, SearchInput, Pagination, fmt, fmtDateTime, matchesSearch, paginateItems } from '../../components/ui';

const creditedAmount = (payment) => Number(payment?.net_amount || payment?.amount || 0);
const feeAmount = (payment) => Number(payment?.fee_amount || 0);
const grossAmount = (payment) => Number(payment?.amount || 0);

export default function AdminPayments() {
  const [list, setList] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  useEffect(() => { api.get('/payments/all').then((r) => setList(r.data.payments)); }, []);
  useEffect(() => { setPage(1); }, [search]);
  const filtered = useMemo(() => (list || []).filter((payment) => matchesSearch(
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
  )), [list, search]);
  if (!list) return <Loading />;
  const totalCredited = list.filter((p) => p.status === 'success').reduce((sum, p) => sum + creditedAmount(p), 0);
  const totalFees = list.filter((p) => p.status === 'success').reduce((sum, p) => sum + feeAmount(p), 0);
  const totalGross = list.filter((p) => p.status === 'success').reduce((sum, p) => sum + grossAmount(p), 0);
  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  return (
    <>
      <h1 className="page-title">Payments</h1>
      <p className="page-sub">Rental received {fmt(totalCredited)} · Gateway fees {fmt(totalFees)} · Gross charged {fmt(totalGross)}</p>
      <div className="row mb-4" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search rider, agreement, reference, method" style={{ flex: '1 1 320px', maxWidth: 440 }} />
        <div className="muted text-sm">Showing {filtered.length} matching payments</div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Date</th><th>Rider</th><th>Agreement</th><th>Method</th><th>Reference</th><th>Status</th><th>Rental</th><th>Fee</th><th>Gross</th></tr></thead>
          <tbody>
            {pagination.items.map((p) => (
              <tr key={p.id}>
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

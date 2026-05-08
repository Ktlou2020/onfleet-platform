import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Loading, Badge, SearchInput, Pagination, fmt, fmtDate, EmptyState, matchesSearch, paginateItems } from '../../components/ui';

export default function RiderAgreements() {
  const [list, setList] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => { api.get('/agreements/mine').then((r) => setList(r.data.agreements)); }, []);
  useEffect(() => { setPage(1); }, [search]);

  const filtered = useMemo(() => (list || []).filter((agreement) => matchesSearch(
    search,
    agreement.agreement_no,
    agreement.make,
    agreement.model,
    agreement.registration,
    agreement.vin,
    agreement.status,
    agreement.weekly_amount,
    agreement.total_amount
  )), [list, search]);

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  if (!list) return <Loading />;
  return (
    <>
      <h1 className="page-title">My Agreements</h1>
      <p className="page-sub">All your rent-to-own contracts</p>
      {!list.length ? <EmptyState title="No agreements yet"
        sub="Once your application is approved, your agreement appears here."
        action={<Link to="/application" className="btn">Apply now</Link>} /> :
      <>
        <div className="row mb-4" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search agreement number, bike, registration" style={{ flex: '1 1 320px', maxWidth: 420 }} />
          <div className="muted text-sm">Showing {filtered.length} matching agreements</div>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Agreement</th><th>Bike</th><th>Weekly</th><th>Total</th><th>Start</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {pagination.items.map((agreement) => (
                <tr key={agreement.id}>
                  <td><strong>{agreement.agreement_no}</strong></td>
                  <td>{agreement.make} {agreement.model}</td>
                  <td>{fmt(agreement.weekly_amount)}</td>
                  <td>{fmt(agreement.total_amount)}</td>
                  <td>{fmtDate(agreement.start_date)}</td>
                  <td><Badge status={agreement.status} /></td>
                  <td><Link to={`/agreements/${agreement.id}`} className="btn btn-sm btn-secondary">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!pagination.items.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{search ? 'No agreements match your search.' : 'No agreements yet.'}</div>}
        </div>
        <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="agreements" />
      </>}
    </>
  );
}

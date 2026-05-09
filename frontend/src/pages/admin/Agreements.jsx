import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, SearchInput, fmt, fmtDate, Modal, Pagination, matchesSearch, paginateItems } from '../../components/ui';

export default function AdminAgreements() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const [list, setList] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [file, setFile] = useState(null);

  const load = () => api.get('/agreements', { params: status ? { status } : {} }).then((response) => setList(response.data.agreements));
  useEffect(() => { load(); }, [status]);
  useEffect(() => { setPage(1); }, [search, status]);

  const downloadTemplate = async () => {
    const response = await api.get('/payments/bulk-template', { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'onfleet-payments-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importCsv = async () => {
    if (!file) return toast.error('Choose a CSV file first');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const { data } = await api.post('/payments/bulk-import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`Imported ${data.imported} payments${data.failed ? `, ${data.failed} failed` : ''}`);
      setShowImport(false);
      setFile(null);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Import failed');
    }
  };

  const filtered = (list || []).filter((agreement) => matchesSearch(
    search,
    agreement.agreement_no,
    agreement.full_name,
    agreement.email,
    agreement.registration,
    agreement.make,
    agreement.model,
    agreement.status,
    agreement.weekly_amount,
    agreement.total_amount
  ));

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  if (!list) return <Loading />;
  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Agreements</h1>
          <p className="page-sub">All rent-to-own agreements and bulk payment operations.</p>
        </div>
        <div className="row">
          <button className="btn btn-secondary" onClick={downloadTemplate}>Download CSV template</button>
          <button className="btn" onClick={() => setShowImport(true)}>Bulk-load payments</button>
        </div>
      </div>
      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search agreement, rider, bike, registration" style={{ flex: '1 1 320px', maxWidth: 440 }} />
        <div className="muted text-sm">Showing {filtered.length} matching agreements</div>
      </div>
      <div className="row mb-4">
        {['', 'active', 'completed', 'defaulted', 'cancelled', 'paused'].map((value) => (
          <button key={value} onClick={() => setParams(value ? { status: value } : {})} className={`btn btn-sm ${status === value ? '' : 'btn-secondary'}`}>{value || 'All'}</button>
        ))}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Agreement</th><th>Rider</th><th>Bike</th><th>Weekly</th><th>Total</th><th>Start</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {pagination.items.map((agreement) => (
              <tr key={agreement.id}>
                <td><strong>{agreement.agreement_no}</strong></td>
                <td>{agreement.full_name}<div className="text-xs muted">{agreement.email}</div></td>
                <td>{agreement.make} {agreement.model}<div className="text-xs muted">{agreement.registration}</div></td>
                <td>{fmt(agreement.weekly_amount)}</td>
                <td>{fmt(agreement.total_amount)}</td>
                <td>{fmtDate(agreement.start_date)}</td>
                <td><Badge status={agreement.status} /></td>
                <td><Link to={`/admin/agreements/${agreement.id}`} className="btn btn-sm btn-secondary">View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pagination.items.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{search ? 'No agreements match your search.' : 'No agreements.'}</div>}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="agreements" />

      {showImport && (
        <Modal title="Bulk-load payments from CSV" onClose={() => setShowImport(false)}>
          <div className="field"><label className="label">CSV file</label><input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)} /></div>
          <div className="muted text-sm mb-3">Use the template columns: agreement_no, amount, method, reference, paid_at, notes.</div>
          <div className="row"><button className="btn" onClick={importCsv}>Import CSV</button><button className="btn btn-secondary" onClick={() => setShowImport(false)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, SearchInput, fmt, fmtDate, Modal, Pagination, matchesSearch, paginateItems } from '../../components/ui';

function PreviewTable({ preview, mapping, setMapping }) {
  if (!preview) return null;
  return (
    <div className="card" style={{ background: 'var(--surface-2)', marginTop: 12 }}>
      <div className="grid grid-2">
        {preview.expected_fields.map((field) => (
          <div className="field" key={field.key}>
            <label className="label">{field.label}{field.required ? ' *' : ''}</label>
            <select value={mapping[field.key] || ''} onChange={(e) => setMapping((current) => ({ ...current, [field.key]: e.target.value }))}>
              <option value="">— Not mapped —</option>
              {preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}
            </select>
          </div>
        ))}
      </div>
      {!!preview.warnings?.missing_required?.length && (
        <div className="text-sm" style={{ color: 'var(--danger)', marginTop: 8 }}>
          Required fields still missing: {preview.warnings.missing_required.join(', ')}
        </div>
      )}
      {!!preview.warnings?.duplicate_sources?.length && (
        <div className="text-sm" style={{ color: 'var(--danger)', marginTop: 8 }}>
          Duplicate column usage detected. Each source column can only map once.
        </div>
      )}
      <div className="muted text-sm mt-3">Preview rows</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              {preview.expected_fields.slice(0, 6).map((field) => <th key={field.key}>{field.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.sample_rows.slice(0, 3).map((row, index) => (
              <tr key={index}>
                {preview.expected_fields.slice(0, 6).map((field) => <td key={field.key}>{mapping[field.key] ? row[mapping[field.key]] || '—' : '—'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AdminAgreements() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const [list, setList] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);

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

  const closeImport = () => {
    setShowImport(false);
    setFile(null);
    setPreview(null);
    setMapping({});
    setPreviewing(false);
    setImporting(false);
  };

  const previewCsv = async () => {
    if (!file) return toast.error('Choose a CSV file first');
    setPreviewing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/payments/bulk-preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setPreview(data);
      setMapping(data.suggested_mapping || {});
      toast.success('CSV preview ready');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not preview this CSV');
    } finally {
      setPreviewing(false);
    }
  };

  const missingRequired = preview?.expected_fields?.filter((field) => field.required && !mapping[field.key]) || [];
  const duplicateCount = Object.values(mapping).filter(Boolean).length - new Set(Object.values(mapping).filter(Boolean)).size;

  const importCsv = async () => {
    if (!file) return toast.error('Choose a CSV file first');
    if (!preview) return toast.error('Preview the CSV before importing');
    if (missingRequired.length) return toast.error(`Map the required fields first: ${missingRequired.map((field) => field.label).join(', ')}`);
    if (duplicateCount > 0) return toast.error('Each CSV column can only be mapped once');

    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mappings', JSON.stringify(mapping));
      const { data } = await api.post('/payments/bulk-import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`Imported ${data.imported} payments${data.failed ? `, ${data.failed} failed` : ''}`);
      closeImport();
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Import failed');
    } finally {
      setImporting(false);
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
      <div className="row mb-4" style={{ flexWrap: 'wrap' }}>
        {['', 'active', 'completed', 'defaulted', 'cancelled', 'paused', 'discontinued'].map((value) => (
          <button key={value || 'all'} onClick={() => setParams(value ? { status: value } : {})} className={`btn btn-sm ${status === value ? '' : 'btn-secondary'}`}>{value || 'All'}</button>
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
        <Modal title="Bulk-load payments from CSV" onClose={closeImport}>
          <div className="field"><label className="label">CSV file</label><input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setMapping({}); }} /></div>
          <div className="muted text-sm mb-3">Preview the column mapping before importing. Required fields: agreement number and amount.</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={previewCsv} disabled={previewing}>{previewing ? 'Previewing…' : 'Preview CSV'}</button>
            <button className="btn" onClick={importCsv} disabled={importing || !preview}>{importing ? 'Importing…' : 'Import CSV'}</button>
            <button className="btn btn-secondary" onClick={closeImport}>Cancel</button>
          </div>
          <PreviewTable preview={preview} mapping={mapping} setMapping={setMapping} />
        </Modal>
      )}
    </>
  );
}

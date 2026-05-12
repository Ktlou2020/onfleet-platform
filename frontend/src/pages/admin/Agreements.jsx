import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, SearchInput, fmt, fmtDate, Modal, Pagination, matchesSearch, paginateItems } from '../../components/ui';

const AGREEMENT_STATUS_OPTIONS = ['', 'active', 'completed', 'defaulted', 'cancelled', 'paused', 'discontinued'];
const BIKE_STATUS_OPTIONS = ['', 'active', 'not_available', 'sold', 'paid_off', 'written_off', 'stolen', 'repairs', 'ready_to_go', 'stationary'];

function labelize(value) {
  if (!value) return 'All';
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

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
  const agreementStatus = params.get('status') || '';
  const bikeStatus = params.get('bike_status') || '';
  const excludedBikeStatuses = (params.get('exclude_bike_statuses') || '').split(',').map((value) => value.trim()).filter(Boolean);
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
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = () => api.get('/agreements', {
    params: {
      ...(agreementStatus ? { status: agreementStatus } : {}),
      ...(bikeStatus ? { bike_status: bikeStatus } : {}),
      ...(excludedBikeStatuses.length ? { exclude_bike_statuses: excludedBikeStatuses.join(',') } : {})
    }
  }).then((response) => setList(response.data.agreements));

  useEffect(() => { load(); }, [agreementStatus, bikeStatus, excludedBikeStatuses.join(',')]);
  useEffect(() => { setPage(1); setSelectedIds([]); }, [search, agreementStatus, bikeStatus, excludedBikeStatuses.join(',')]);

  const updateFilters = (nextValues) => {
    const next = new URLSearchParams(params);
    Object.entries(nextValues).forEach(([key, value]) => {
      if (value) next.set(key, value);
      else next.delete(key);
    });
    setParams(next);
  };

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
    agreement.bike_status,
    agreement.weekly_amount,
    agreement.total_amount
  ));

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);
  const visibleIds = pagination.items.map((agreement) => agreement.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleSelected = (agreementId) => {
    setSelectedIds((current) => current.includes(agreementId)
      ? current.filter((id) => id !== agreementId)
      : [...current, agreementId]);
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      if (allVisibleSelected) return current.filter((id) => !visibleIds.includes(id));
      return Array.from(new Set([...current, ...visibleIds]));
    });
  };

  const bulkDiscontinue = async () => {
    if (!selectedIds.length) return toast.error('Select at least one agreement first');
    if (!window.confirm(`Discontinue ${selectedIds.length} selected contract(s)? Future unpaid schedule rows will be waived.`)) return;

    setBulkBusy(true);
    try {
      const { data } = await api.post('/agreements/bulk-discontinue', { agreement_ids: selectedIds });
      toast.success(`Discontinued ${data.discontinued_count} contract(s)${data.skipped_count ? `, skipped ${data.skipped_count}` : ''}`);
      setSelectedIds([]);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not discontinue selected contracts');
    } finally {
      setBulkBusy(false);
    }
  };

  if (!list) return <Loading />;
  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Agreements</h1>
          <p className="page-sub">Review contracts, filter by agreement and bike status, and run bulk actions.</p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={downloadTemplate}>Download CSV template</button>
          <button className="btn" onClick={() => setShowImport(true)}>Bulk-load payments by registration</button>
        </div>
      </div>

      <div className="row mb-3" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search agreement, rider, bike, registration" style={{ flex: '1 1 320px', maxWidth: 440 }} />
        <div className="field" style={{ minWidth: 220, marginBottom: 0 }}>
          <label className="label">Agreement status</label>
          <select value={agreementStatus} onChange={(e) => updateFilters({ status: e.target.value })}>
            {AGREEMENT_STATUS_OPTIONS.map((value) => <option key={value || 'all'} value={value}>{labelize(value)}</option>)}
          </select>
        </div>
        <div className="field" style={{ minWidth: 220, marginBottom: 0 }}>
          <label className="label">Bike status</label>
          <select value={bikeStatus} onChange={(e) => updateFilters({ bike_status: e.target.value })}>
            {BIKE_STATUS_OPTIONS.map((value) => <option key={value || 'all'} value={value}>{labelize(value)}</option>)}
          </select>
        </div>
        <button className="btn btn-secondary" onClick={() => { setSearch(''); updateFilters({ status: '', bike_status: '', exclude_bike_statuses: '' }); }}>Clear filters</button>
      </div>

      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="muted text-sm">Showing {filtered.length} matching agreements</div>
          {!!excludedBikeStatuses.length && (
            <div className="muted text-xs" style={{ marginTop: 4 }}>
              Excluding bike statuses: {excludedBikeStatuses.map(labelize).join(', ')}
            </div>
          )}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="badge badge-muted">{selectedIds.length} selected</div>
          <button className="btn btn-sm btn-danger" onClick={bulkDiscontinue} disabled={!selectedIds.length || bulkBusy}>
            {bulkBusy ? 'Discontinuing…' : 'Bulk discontinue selected'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 44 }}><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all visible agreements" /></th>
              <th>Agreement</th>
              <th>Rider</th>
              <th>Bike</th>
              <th>Bike status</th>
              <th>Weekly</th>
              <th>Total</th>
              <th>Start</th>
              <th>Agreement status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((agreement) => (
              <tr key={agreement.id}>
                <td><input type="checkbox" checked={selectedIds.includes(agreement.id)} onChange={() => toggleSelected(agreement.id)} aria-label={`Select ${agreement.agreement_no}`} /></td>
                <td><strong>{agreement.agreement_no}</strong></td>
                <td>{agreement.full_name}<div className="text-xs muted">{agreement.email}</div></td>
                <td>{agreement.make} {agreement.model}<div className="text-xs muted">{agreement.registration}</div></td>
                <td><Badge status={agreement.bike_status}>{labelize(agreement.bike_status)}</Badge></td>
                <td>{fmt(agreement.weekly_amount)}</td>
                <td>{fmt(agreement.total_amount)}</td>
                <td>{fmtDate(agreement.start_date)}</td>
                <td><Badge status={agreement.status}>{labelize(agreement.status)}</Badge></td>
                <td><Link to={`/admin/agreements/${agreement.id}`} className="btn btn-sm btn-secondary">View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pagination.items.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{search || agreementStatus || bikeStatus || excludedBikeStatuses.length ? 'No agreements match the current filters.' : 'No agreements.'}</div>}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="agreements" />

      {showImport && (
        <Modal title="Bulk-load payments from CSV" onClose={closeImport}>
          <div className="field"><label className="label">CSV file</label><input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setMapping({}); }} /></div>
          <div className="muted text-sm mb-3">Preview and map the columns before importing. Required fields: bike registration and amount. Payments will be allocated to the latest matching agreement for that registration.</div>
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

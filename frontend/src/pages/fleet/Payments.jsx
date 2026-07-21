import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { FleetHelpTip } from './helpSupport';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, ConfirmModal, EmptyState, Loading, Modal, Pagination, SearchInput, fmt, fmtDateTime } from '../../components/ui';
import { canManageFleetSection } from './access';

const METHOD_OPTIONS = ['eft', 'cash', 'card', 'other'];
const DATE_RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: null }
];

const CANONICAL_COLS = ['registration', 'amount', 'paid_at', 'reference', 'method', 'notes'];
const COL_LABELS = { registration: 'Bike registration', amount: 'Amount', paid_at: 'Payment date', reference: 'Reference', method: 'Method', notes: 'Notes' };

const creditedAmount = (p) => Number(p?.net_amount ?? p?.amount ?? 0);
const feeAmount = (p) => Number(p?.fee_amount || 0);
const grossAmount = (p) => Number(p?.amount || 0);

function buildPaymentsQuery({ search, method, days, page, pageSize }) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (method) params.set('method', method);
  if (days) params.set('days', days);
  params.set('page', page);
  params.set('page_size', pageSize);
  return params.toString();
}

export default function FleetOwnerPayments() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'payments');

  const [payments, setPayments] = useState(null);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [aggregates, setAggregates] = useState({ credited: 0, fees: 0, gross: 0 });
  const [agreements, setAgreements] = useState([]);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [dateRange, setDateRange] = useState(30);
  const [methodFilter, setMethodFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const [selectedIds, setSelectedIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [pay, setPay] = useState({ agreement_id: '', amount: '', method: 'eft', reference: '', payment_date: '', notes: '' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importState, setImportState] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importMapping, setImportMapping] = useState({});
  const [importResult, setImportResult] = useState(null);
  const importFileRef = useRef(null);
  const debounceTimer = useRef(null);

  const loadPayments = useCallback(async ({ search: s, method: m, days: d, page: pg, pageSize: ps } = {}) => {
    try {
      const qs = buildPaymentsQuery({ search: s ?? debouncedSearch, method: m ?? methodFilter, days: d ?? dateRange, page: pg ?? page, pageSize: ps ?? pageSize });
      const { data } = await api.get(`/fleet/payments?${qs}`);
      setPayments(data.payments);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setAggregates(data.aggregates || { credited: 0, fees: 0, gross: 0 });
    } catch {
      toast.error('Could not load payments');
    }
  }, [debouncedSearch, methodFilter, dateRange, page, pageSize]);

  const loadAgreements = useCallback(async () => {
    try {
      const { data } = await api.get('/fleet/portal-data');
      setAgreements((data.agreements || []).filter((a) => ['active', 'paused', 'defaulted'].includes(a.status)));
    } catch { /* portal-data failure is non-fatal */ }
  }, []);

  useEffect(() => { loadAgreements(); }, [loadAgreements]);

  useEffect(() => {
    if (payments !== null) loadPayments();
  }, [page, pageSize]);

  useEffect(() => {
    if (payments === null) {
      loadPayments();
    } else {
      setPage(1);
      loadPayments({ page: 1 });
    }
  }, [debouncedSearch, methodFilter, dateRange]);

  useEffect(() => {
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedSearch(search), 320);
    return () => clearTimeout(debounceTimer.current);
  }, [search]);

  const visibleIds = (payments || []).map((p) => p.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleSelected = (id) => setSelectedIds((curr) => curr.includes(id) ? curr.filter((x) => x !== id) : [...curr, id]);
  const toggleAllVisible = () => setSelectedIds((curr) => allVisibleSelected ? curr.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...curr, ...visibleIds])));

  const recordPayment = async () => {
    try {
      setBusy(true);
      const { payment_date, ...rest } = pay;
      await api.post('/fleet/payments/manual', { ...rest, agreement_id: Number(pay.agreement_id), amount: Number(pay.amount), ...(payment_date ? { paid_at: payment_date } : {}) });
      toast.success('Payment recorded');
      setShowPay(false);
      setPay({ agreement_id: '', amount: '', method: 'eft', reference: '', payment_date: '', notes: '' });
      await loadPayments();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not record payment');
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    try {
      setBusy(true);
      const { data } = await api.post('/fleet/payments/bulk-delete', { payment_ids: selectedIds });
      toast.success(`Deleted ${data.deleted_count} payment(s)`);
      setSelectedIds([]);
      setConfirmDelete(false);
      await loadPayments();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not delete selected payments');
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    try {
      const qs = buildPaymentsQuery({ search: debouncedSearch, method: methodFilter, days: dateRange, page: 1, pageSize: 15 });
      const { data } = await api.get(`/fleet/payments?${qs}&all=1`);
      const allPayments = data.payments || [];
      if (!allPayments.length) return toast.error('No payments to export');
      const rows = [
        ['Date', 'Rider', 'Email', 'Agreement', 'Bike', 'Method', 'Reference', 'Status', 'Rental', 'Fee', 'Gross'],
        ...allPayments.map((p) => [
          p.paid_at || p.created_at, p.full_name, p.email, p.agreement_no,
          p.bike_registration || '', p.method, p.reference || '', p.status,
          creditedAmount(p), feeAmount(p), grossAmount(p)
        ])
      ];
      const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'payments-export.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not export payments');
    }
  };

  const openImport = () => { setImportState('picking'); setImportFile(null); setImportPreview(null); setImportMapping({}); setImportResult(null); };
  const closeImport = () => setImportState(null);

  const handleImportFile = async (file) => {
    if (!file) return;
    setImportFile(file);
    const fd = new FormData();
    fd.append('file', file);
    try {
      setBusy(true);
      const { data } = await api.post('/fleet/payments/import/preview', fd);
      setImportPreview(data);
      setImportMapping(data.suggested_mapping || {});
      setImportState('preview');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not read CSV');
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!importFile) return;
    const fd = new FormData();
    fd.append('file', importFile);
    fd.append('mapping', JSON.stringify(importMapping));
    try {
      setImportState('importing');
      const { data } = await api.post('/fleet/payments/import', fd);
      setImportResult(data);
      setImportState('done');
      if (data.payments_created > 0) await loadPayments();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
      setImportState('preview');
    }
  };

  if (!payments) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Payments</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>
            Rental received {fmt(aggregates.credited)} · Gateway fees {fmt(aggregates.fees)} · Gross {fmt(aggregates.gross)}
            {dateRange ? <span className="muted"> · Last {dateRange} days</span> : null}
          </p>
          <FleetHelpTip section="payments" tooltip="Record manual collections, review payment methods, and fix incorrect payment rows safely." label="Learn more about payments" />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {canManage && <button className="btn btn-sm" onClick={() => setShowPay(true)} title="Record an EFT, cash, card, or other manual rental payment">+ Record payment</button>}
          {canManage && <button className="btn btn-sm btn-secondary" onClick={openImport} title="Import payments from a CSV file">Import CSV</button>}
          {canManage && <button className="btn btn-sm btn-danger" onClick={() => { if (!selectedIds.length) return toast.error('Select at least one payment first'); setConfirmDelete(true); }} disabled={busy}>{busy ? 'Deleting…' : 'Delete selected'}</button>}
          <button className="btn btn-sm btn-secondary" onClick={exportCsv} title="Export all matching payments to CSV">Export CSV</button>
        </div>
      </div>

      <div className="mb-3" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search rider, agreement, reference, bike" style={{ flex: '1 1 280px', maxWidth: 400 }} />
        <div className="filter-pills">
          {DATE_RANGES.map((range) => (
            <button key={range.days ?? 'all'} className={`filter-pill ${dateRange === range.days ? 'active' : ''}`} onClick={() => setDateRange(range.days)}>
              {range.label}
            </button>
          ))}
        </div>
        <div className="filter-pills">
          <button className={`filter-pill ${methodFilter === '' ? 'active' : ''}`} onClick={() => setMethodFilter('')}>All methods</button>
          {METHOD_OPTIONS.map((m) => (
            <button key={m} className={`filter-pill ${methodFilter === m ? 'active' : ''}`} onClick={() => setMethodFilter(m)}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="muted text-sm">{canManage ? `${selectedIds.length} selected · ` : ''}Showing {payments.length} of {total} payments</div>
        <FleetHelpTip section="common-questions" tooltip="Search works with rider names, agreement numbers, references, and bike registrations." label="Search tips" compact />
      </div>

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              {canManage ? <th style={{ width: 44 }}><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all visible payments" /></th> : null}
              <th>Date</th>
              <th>Rider</th>
              <th>Agreement</th>
              <th>Bike</th>
              <th>Method</th>
              <th>Reference</th>
              <th>Status</th>
              <th>Rental</th>
              <th>Fee</th>
              <th>Gross</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => (
              <tr key={payment.id}>
                {canManage ? <td><input type="checkbox" checked={selectedIds.includes(payment.id)} onChange={() => toggleSelected(payment.id)} aria-label={`Select payment ${payment.reference || payment.id}`} /></td> : null}
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(payment.paid_at || payment.created_at)}</td>
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
        {!payments.length && (
          <EmptyState
            title="No payments found"
            sub={debouncedSearch || methodFilter || dateRange ? 'Adjust your filters to show more payments.' : 'Payments recorded for your agreements will appear here.'}
            action={canManage ? <button className="btn" onClick={() => setShowPay(true)}>Record manual payment</button> : null}
          />
        )}
      </div>
      <Pagination page={page} pageSize={pageSize} totalItems={total} onPageChange={setPage} onPageSizeChange={(ps) => { setPageSize(ps); setPage(1); }} label="payments" />

      {confirmDelete && (
        <ConfirmModal
          title="Delete selected payments"
          body={`Delete ${selectedIds.length} selected payment(s)? Payment schedules will be recalculated. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={deleteSelected}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {importState && (
        <Modal
          title={importState === 'done' ? 'Import complete' : importState === 'preview' ? 'Map columns & preview' : 'Import payments from CSV'}
          onClose={importState === 'importing' ? undefined : closeImport}
        >
          {(importState === 'picking' || (importState === 'preview' && !importPreview)) && (
            <div>
              <p className="muted text-sm mb-4">Upload a CSV with columns for bike registration and payment amount. Other columns (date, reference, method, notes) are optional.</p>
              <div
                style={{ border: '2px dashed var(--border)', borderRadius: 8, padding: 32, textAlign: 'center', cursor: 'pointer', background: 'var(--surface-2)' }}
                onClick={() => importFileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleImportFile(f); }}
              >
                <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Drop your CSV here or click to browse</div>
                <div className="muted text-xs">Max 5 MB · CSV only · Bikes must belong to your fleet</div>
              </div>
              <input ref={importFileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => handleImportFile(e.target.files[0])} />
              {busy && <div className="muted text-sm mt-3">Reading file…</div>}
              <div className="row mt-4" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={closeImport}>Cancel</button>
              </div>
            </div>
          )}

          {importState === 'preview' && importPreview && (
            <div>
              <p className="text-sm mb-3">Found <strong>{importPreview.total_rows}</strong> rows. Map your CSV columns to the expected fields below, then confirm.</p>
              <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
                <h4 className="mb-3" style={{ fontSize: 13 }}>Column mapping</h4>
                <div className="grid grid-2" style={{ gap: '8px 16px' }}>
                  {CANONICAL_COLS.map((canonical) => (
                    <div key={canonical} className="field" style={{ marginBottom: 0 }}>
                      <label className="label" style={{ fontSize: 11 }}>{COL_LABELS[canonical]}{canonical === 'registration' || canonical === 'amount' ? ' *' : ''}</label>
                      <select value={importMapping[canonical] || ''} onChange={(e) => setImportMapping((m) => ({ ...m, [canonical]: e.target.value || null }))}>
                        <option value="">— skip —</option>
                        {importPreview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              <h4 className="mb-2" style={{ fontSize: 13 }}>Sample rows (first 5)</h4>
              <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                <table className="table" style={{ fontSize: 11 }}>
                  <thead><tr>{importPreview.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{importPreview.sample_rows.map((row, i) => (
                    <tr key={i}>{importPreview.headers.map((h) => <td key={h}>{row[h] || '—'}</td>)}</tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn btn-secondary" onClick={() => { setImportPreview(null); setImportState('picking'); }}>Back</button>
                <button className="btn" disabled={!importMapping.registration || !importMapping.amount} onClick={confirmImport}>
                  Import {importPreview.total_rows} rows
                </button>
              </div>
              {(!importMapping.registration || !importMapping.amount) && (
                <p className="muted text-xs mt-2">Map at least "Bike registration" and "Amount" to proceed.</p>
              )}
            </div>
          )}

          {importState === 'importing' && (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div className="muted">Importing payments…</div>
            </div>
          )}

          {importState === 'done' && importResult && (
            <div>
              <div className="grid grid-2 mb-4" style={{ gap: 12 }}>
                <div className="card" style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--success)' }}>{importResult.payments_created}</div>
                  <div className="text-xs muted">Payments created</div>
                </div>
                <div className="card" style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--muted)' }}>{importResult.skipped}</div>
                  <div className="text-xs muted">Duplicate / skipped</div>
                </div>
              </div>
              {importResult.errors && importResult.errors.length > 0 && (
                <div className="card mb-3" style={{ background: 'var(--danger-bg, #fdf2f2)' }}>
                  <h4 className="mb-2" style={{ fontSize: 13, color: 'var(--danger)' }}>{importResult.errors.length} row{importResult.errors.length !== 1 ? 's' : ''} with errors</h4>
                  <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                    {importResult.errors.map((e, i) => (
                      <div key={i} className="text-xs" style={{ marginBottom: 4 }}>Row {e.row}: {e.error}</div>
                    ))}
                  </div>
                </div>
              )}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={closeImport}>Done</button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {showPay && (
        <Modal title="Record manual payment" onClose={() => setShowPay(false)}>
          <div className="mb-3">
            <FleetHelpTip section="payments" tooltip="Choose the correct agreement, enter the collected amount, and add a useful reference for later reconciliation." label="Open payment guide" compact />
          </div>
          <div className="grid grid-2">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="label">Agreement</label>
              <select
                value={pay.agreement_id}
                onChange={(e) => setPay({ ...pay, agreement_id: e.target.value, amount: pay.amount || agreements.find((a) => String(a.id) === e.target.value)?.weekly_amount || '' })}
              >
                <option value="">Select agreement</option>
                {agreements.map((a) => <option key={a.id} value={a.id}>{a.agreement_no} · {a.rider_name} · {a.bike_registration || `${a.make} ${a.model}`}</option>)}
              </select>
            </div>
            <div className="field"><label className="label">Amount</label><input type="number" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></div>
            <div className="field">
              <label className="label">Method</label>
              <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                {METHOD_OPTIONS.map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label className="label">Reference</label><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="Optional bank or cash reference" /></div>
          <div className="field"><label className="label">Payment date</label><input type="date" value={pay.payment_date} onChange={(e) => setPay({ ...pay, payment_date: e.target.value })} /></div>
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

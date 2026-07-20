import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Trophy, Medal, Award, Copy, Check, Clock, FileText } from 'lucide-react';
import api from '../../api';
import { Badge, ConfirmModal, Loading, Modal, SearchInput, fmt, fmtDate, fmtDateTime, matchesSearch } from '../../components/ui';

const STATUS_COLOR = { open: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };
const PRIORITY_COLOR = { urgent: 'danger', high: 'warning', normal: '', low: '' };
const HEALTH_COLOR = { overdue: 'danger', due_soon: 'warning', ok: 'success' };
const HEALTH_LABEL = { overdue: 'Overdue', due_soon: 'Due soon', ok: 'OK' };

const STATUS_OPTS = ['all', 'open', 'in_progress', 'completed', 'cancelled'];

const ACTION_LABELS = {
  'job_card.created': 'Job card created',
  'job_card.started': 'Work started',
  'job_card.completed': 'Job completed',
  'job_card.admin_edit': 'Edited by admin',
  'job_card.note': 'Note added',
  'job_card.cancelled': 'Job cancelled',
};

const TABS = ['Overview', 'All Jobs', 'Technicians', 'Fleet Health', 'Staff'];

function KPI({ label, value, sub, accent }) {
  return (
    <div className="stat" style={{ borderTop: `3px solid ${accent || 'var(--accent)'}` }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="text-xs muted" style={{ marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button className="btn btn-sm btn-secondary" onClick={copy} title="Copy link" style={{ marginLeft: 6 }}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function JobDetailModal({ jobId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [editForm, setEditForm] = useState({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [noting, setNoting] = useState(false);
  const [itemForm, setItemForm] = useState({ item_type: 'labor', description: '', unit_cost: '', quantity: '1' });
  const [addingItem, setAddingItem] = useState(false);

  const reload = () =>
    api.get(`/workshop/admin/jobs/${jobId}`)
      .then((r) => {
        setData(r.data);
        const jc = r.data.job_card;
        setEditForm({ priority: jc.priority, technician_id: String(jc.technician_id || ''), description: jc.description || '', status: jc.status });
      })
      .catch(() => toast.error('Could not load job details'));

  useEffect(() => {
    if (!jobId) return;
    setData(null);
    setNote('');
    Promise.all([reload(), api.get('/workshop/technicians').then((r) => setTechnicians(r.data.technicians))])
      .catch(() => {});
  }, [jobId]);

  const saveEdit = async () => {
    try {
      setSaving(true);
      await api.put(`/workshop/admin/jobs/${jobId}`, editForm);
      toast.success('Job updated');
      await reload();
      if (onChanged) onChanged();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update');
    } finally {
      setSaving(false);
    }
  };

  const addItem = async () => {
    if (!itemForm.description.trim() || !itemForm.unit_cost) return;
    try {
      setAddingItem(true);
      await api.post(`/workshop/job-cards/${jobId}/items`, {
        item_type: itemForm.item_type,
        description: itemForm.description.trim(),
        unit_cost: Number(itemForm.unit_cost),
        quantity: Number(itemForm.quantity) || 1,
      });
      setItemForm({ item_type: 'labor', description: '', unit_cost: '', quantity: '1' });
      await reload();
      if (onChanged) onChanged();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not add item');
    } finally {
      setAddingItem(false);
    }
  };

  const deleteItem = async (itemId) => {
    try {
      await api.delete(`/workshop/job-cards/${jobId}/items/${itemId}`);
      await reload();
      if (onChanged) onChanged();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not remove item');
    }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    try {
      setNoting(true);
      await api.post(`/workshop/admin/jobs/${jobId}/notes`, { note });
      setNote('');
      await reload();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not add note');
    } finally {
      setNoting(false);
    }
  };

  const jc = data?.job_card;
  const audit = data?.audit || [];

  return (
    <Modal
      title={jc ? `Job #${jc.id} — ${jc.bike_registration || jc.registration || jc.bike_make || jc.make || '—'}` : `Job #${jobId}`}
      onClose={onClose}
      style={{ maxWidth: 720 }}
    >
      {!jc ? <Loading /> : (
        <>
          {/* Status / priority / cost row */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
            <Badge status={STATUS_COLOR[jc.status]}>{jc.status.replace('_', ' ')}</Badge>
            {jc.priority !== 'normal' && <Badge status={PRIORITY_COLOR[jc.priority]}>{jc.priority}</Badge>}
            <span className="text-xs muted">{jc.job_type}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 15 }}>{fmt(jc.total_cost)}</span>
          </div>

          {/* Key info grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px', marginBottom: 16, fontSize: 13 }}>
            <div><span className="muted">Bike: </span><strong>{[jc.bike_make, jc.bike_model].filter(Boolean).join(' ') || jc.make || '—'}</strong></div>
            <div><span className="muted">Reg / VIN: </span>{jc.bike_registration || jc.registration || jc.bike_vin || jc.vin || '—'}</div>
            <div><span className="muted">Technician: </span>{jc.technician_name || <span className="muted">Unassigned</span>}</div>
            <div><span className="muted">Fleet: </span>{jc.bike_org_name || '—'}</div>
            <div><span className="muted">Created: </span>{fmtDateTime(jc.created_at)}</div>
            {jc.completed_at && <div><span className="muted">Completed: </span>{fmtDateTime(jc.completed_at)}</div>}
          </div>

          {/* Description */}
          {jc.description && (
            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
              <div className="text-xs muted" style={{ marginBottom: 4 }}>Description</div>
              <div className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{jc.description}</div>
            </div>
          )}

          {/* Completion notes */}
          {jc.completion_notes && (
            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
              <div className="text-xs muted" style={{ marginBottom: 4 }}>Completion notes</div>
              <div className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{jc.completion_notes}</div>
              {jc.odometer_km && <div className="text-xs muted" style={{ marginTop: 4 }}>Odometer: {jc.odometer_km.toLocaleString()} km</div>}
            </div>
          )}

          {/* Line items */}
          <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
            <div className="text-xs muted" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Line Items</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Unit cost</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    {jc.status !== 'completed' && jc.status !== 'cancelled' && <th style={{ width: 32 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {jc.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.description}</td>
                      <td className="muted text-xs">{item.item_type}</td>
                      <td style={{ textAlign: 'right' }}>{item.quantity}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(item.unit_cost)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(item.quantity * item.unit_cost)}</td>
                      {jc.status !== 'completed' && jc.status !== 'cancelled' && (
                        <td>
                          <button
                            className="btn btn-sm btn-danger"
                            style={{ padding: '2px 7px', fontSize: 12 }}
                            onClick={() => deleteItem(item.id)}
                          >×</button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {jc.items.length === 0 && (
                    <tr><td colSpan={jc.status !== 'completed' && jc.status !== 'cancelled' ? 6 : 5} className="muted text-sm" style={{ textAlign: 'center', padding: '12px 0' }}>No items added yet.</td></tr>
                  )}
                  {/* Add item row */}
                  {jc.status !== 'completed' && jc.status !== 'cancelled' && (
                    <tr style={{ background: 'rgba(99,102,241,0.04)' }}>
                      <td>
                        <input
                          value={itemForm.description}
                          onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))}
                          placeholder="Description"
                          style={{ fontSize: 12, padding: '4px 8px', width: '100%', minWidth: 140 }}
                        />
                      </td>
                      <td>
                        <select
                          value={itemForm.item_type}
                          onChange={(e) => setItemForm((f) => ({ ...f, item_type: e.target.value }))}
                          style={{ fontSize: 12, padding: '4px 6px' }}
                        >
                          <option value="labor">labor</option>
                          <option value="parts">parts</option>
                          <option value="other">other</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          min="1"
                          value={itemForm.quantity}
                          onChange={(e) => setItemForm((f) => ({ ...f, quantity: e.target.value }))}
                          style={{ fontSize: 12, padding: '4px 6px', width: 52, textAlign: 'right' }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={itemForm.unit_cost}
                          onChange={(e) => setItemForm((f) => ({ ...f, unit_cost: e.target.value }))}
                          placeholder="0.00"
                          style={{ fontSize: 12, padding: '4px 6px', width: 80, textAlign: 'right' }}
                        />
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 12, color: 'var(--muted)' }}>
                        {itemForm.unit_cost && itemForm.quantity ? fmt(Number(itemForm.unit_cost) * (Number(itemForm.quantity) || 1)) : '—'}
                      </td>
                      <td>
                        <button
                          className="btn btn-sm"
                          style={{ padding: '3px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
                          onClick={addItem}
                          disabled={addingItem || !itemForm.description.trim() || !itemForm.unit_cost}
                        >
                          {addingItem ? '…' : '+ Add'}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Edit section */}
          <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
            <div className="text-xs muted" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Edit</div>
            <div className="grid grid-2" style={{ gap: 12, marginBottom: 10 }}>
              <div className="field">
                <label className="label">Priority</label>
                <select value={editForm.priority} onChange={(e) => setEditForm((f) => ({ ...f, priority: e.target.value }))}>
                  {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="label">Technician</label>
                <select value={editForm.technician_id} onChange={(e) => setEditForm((f) => ({ ...f, technician_id: e.target.value }))}>
                  <option value="">Unassigned</option>
                  {technicians.map((t) => <option key={t.id} value={String(t.id)}>{t.full_name}</option>)}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label className="label">Description</label>
              <textarea rows={2} value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
            {['open', 'in_progress'].includes(jc.status) && (
              <div className="field" style={{ marginBottom: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={editForm.status === 'cancelled'} onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.checked ? 'cancelled' : jc.status }))} />
                  <span className="text-sm">Cancel this job</span>
                </label>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </div>

          {/* Add note */}
          <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
            <div className="text-xs muted" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add note</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <textarea rows={2} style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the audit trail…" />
              <button className="btn btn-sm" onClick={addNote} disabled={noting || !note.trim()}>
                {noting ? '…' : 'Add note'}
              </button>
            </div>
          </div>

          {/* Audit trail */}
          <div>
            <div className="text-xs muted" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Activity Log</div>
            {audit.length === 0 ? (
              <p className="text-sm muted">No activity recorded yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {audit.map((entry) => {
                  let meta = {};
                  try { meta = JSON.parse(entry.metadata || '{}'); } catch {}
                  return (
                    <div key={entry.id} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                      <span className="muted text-xs" style={{ whiteSpace: 'nowrap', paddingTop: 2, minWidth: 128, flexShrink: 0 }}>{fmtDateTime(entry.created_at)}</span>
                      <div>
                        <div style={{ fontWeight: 600 }}>{ACTION_LABELS[entry.action] || entry.action}</div>
                        <div className="muted text-xs">
                          {entry.actor_name || entry.actor_email || 'System'}
                          {meta.note ? ` — "${meta.note}"` : null}
                          {meta.changes && Object.keys(meta.changes).length ? ` — ${Object.entries(meta.changes).map(([k, v]) => typeof v === 'object' && v.from !== undefined ? `${k}: ${v.from ?? 'none'} → ${v.to ?? 'none'}` : k).join(', ')}` : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

// --- Tab: Overview ---
function OverviewTab() {
  const [stats, setStats] = useState(null);
  const [revenue, setRevenue] = useState(null);
  const [viewJobId, setViewJobId] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get('/workshop/admin/stats'),
      api.get('/workshop/admin/revenue-by-month')
    ]).then(([s, r]) => {
      setStats(s.data);
      setRevenue(r.data);
    }).catch(() => toast.error('Could not load overview'));
  }, []);

  if (!stats || !revenue) return <Loading />;

  const { recent_jobs, stats: s } = stats;
  const { months, by_type, overdue_jobs } = revenue;
  const maxRevenue = Math.max(...months.map((m) => m.revenue), 1);

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, marginBottom: 28 }}>
        <KPI label="Total jobs" value={s.total_jobs ?? 0} accent="#6366f1" />
        <KPI label="Open" value={s.open_jobs ?? 0} accent="#f97316" />
        <KPI label="In progress" value={s.in_progress_jobs ?? 0} accent="#eab308" />
        <KPI label="Completed" value={s.completed_jobs ?? 0} accent="#22c55e" />
        <KPI label="Total revenue" value={fmt(s.total_revenue ?? 0)} sub="from completed jobs" accent="#8b5cf6" />
        {overdue_jobs > 0 && <KPI label="Stale jobs" value={overdue_jobs} sub="open > 2 days" accent="#ef4444" />}
      </div>

      <div className="grid grid-2" style={{ gap: 20, marginBottom: 28 }}>
        {/* Revenue by month */}
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 14 }}>Revenue by month</div>
          {months.length === 0 ? <p className="muted text-sm">No completed jobs yet.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {months.map((m) => (
                <div key={m.month} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="text-xs muted" style={{ width: 56, flexShrink: 0 }}>{m.month}</span>
                  <div style={{ flex: 1, background: 'var(--border)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
                    <div style={{ width: `${(m.revenue / maxRevenue) * 100}%`, background: 'var(--accent)', height: '100%', borderRadius: 4, minWidth: m.revenue > 0 ? 4 : 0 }} />
                  </div>
                  <span className="text-xs" style={{ width: 76, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmt(m.revenue)}</span>
                  <span className="text-xs muted" style={{ width: 32, flexShrink: 0 }}>{m.jobs_completed}j</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* By job type */}
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 14 }}>Revenue by job type</div>
          {by_type.length === 0 ? <p className="muted text-sm">No completed jobs yet.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ fontSize: 13 }}>
                <thead><tr><th>Type</th><th style={{ textAlign: 'right' }}>Jobs</th><th style={{ textAlign: 'right' }}>Revenue</th></tr></thead>
                <tbody>
                  {by_type.map((t) => (
                    <tr key={t.job_type}>
                      <td>{t.job_type}</td>
                      <td style={{ textAlign: 'right' }}>{t.job_count}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(t.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Recent Jobs</div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>#</th><th>Bike</th><th>Type</th><th>Priority</th><th>Status</th><th>Technician</th><th style={{ textAlign: 'right' }}>Cost</th><th>Created</th></tr>
          </thead>
          <tbody>
            {recent_jobs.map((job) => (
              <tr key={job.id} style={{ cursor: 'pointer' }} onClick={() => setViewJobId(job.id)}>
                <td className="text-xs muted">{job.id}</td>
                <td><div style={{ fontWeight: 600 }}>{job.display_registration || '—'}</div><div className="text-xs muted">{job.display_make} {job.display_model}</div></td>
                <td className="text-sm">{job.job_type}</td>
                <td>{job.priority !== 'normal' ? <Badge status={PRIORITY_COLOR[job.priority]}>{job.priority}</Badge> : <span className="muted text-xs">normal</span>}</td>
                <td><Badge status={STATUS_COLOR[job.status]}>{job.status.replace('_', ' ')}</Badge></td>
                <td className="text-sm">{job.technician_name || <span className="muted">—</span>}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(job.total_cost)}</td>
                <td className="text-xs muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(job.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!recent_jobs.length && <div style={{ padding: 24, textAlign: 'center' }} className="muted">No jobs yet.</div>}
      </div>
      {viewJobId && (
        <JobDetailModal jobId={viewJobId} onClose={() => setViewJobId(null)} />
      )}
    </>
  );
}

// --- Tab: All Jobs ---
function AllJobsTab() {
  const [jobs, setJobs] = useState([]);
  const [technicians, setTechnicians] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('all');
  const [techFilter, setTechFilter] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const [viewJobId, setViewJobId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsRes, techRes] = await Promise.all([
        api.get('/workshop/admin/jobs', { params: { status: status === 'all' ? '' : status, technician_id: techFilter, search, limit: LIMIT, offset } }),
        api.get('/workshop/technicians')
      ]);
      setJobs(jobsRes.data.jobs);
      setTotal(jobsRes.data.total);
      setTechnicians(techRes.data.technicians);
    } catch {
      toast.error('Could not load jobs');
    } finally {
      setLoading(false);
    }
  }, [status, techFilter, search, offset]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setOffset(0); }, [status, techFilter, search]);

  const deleteJob = async () => {
    try {
      setBusy(true);
      await api.delete(`/workshop/admin/jobs/${confirmDelete.id}`);
      toast.success('Job deleted');
      setConfirmDelete(null);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    const rows = [
      ['ID', 'Bike', 'Make', 'Model', 'Type', 'Priority', 'Status', 'Technician', 'Fleet', 'Cost', 'Created', 'Completed'],
      ...jobs.map((j) => [j.id, j.display_registration || '', j.display_make || '', j.display_model || '', j.job_type, j.priority, j.status, j.technician_name || '', j.fleet_org_name || '', j.total_cost, j.created_at, j.completed_at || ''])
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'workshop-jobs.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <>
      <div className="flex-between mb-3" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flex: 1 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search bike, VIN, description, technician…" style={{ flex: '1 1 240px', maxWidth: 340 }} />
          <select value={techFilter} onChange={(e) => setTechFilter(e.target.value)} style={{ fontSize: 13, minWidth: 140 }}>
            <option value="">All technicians</option>
            {technicians.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
          </select>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={exportCsv}>Export CSV</button>
      </div>
      <div className="filter-pills mb-3">
        {STATUS_OPTS.map((s) => (
          <button key={s} className={`filter-pill ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
            {s === 'all' ? 'All' : s.replace('_', ' ')}
          </button>
        ))}
      </div>
      <div className="muted text-sm mb-2">{total} jobs · page {currentPage} of {Math.max(1, totalPages)}</div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>#</th><th>Bike</th><th>Type</th><th>Priority</th><th>Status</th><th>Technician</th><th>Fleet</th><th style={{ textAlign: 'right' }}>Cost</th><th>Created</th><th style={{ width: 96 }}></th></tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td className="text-xs muted">{job.id}</td>
                <td><div style={{ fontWeight: 600 }}>{job.display_registration || '—'}</div><div className="text-xs muted">{job.display_make} {job.display_model}</div></td>
                <td className="text-sm">{job.job_type}</td>
                <td>{job.priority !== 'normal' ? <Badge status={PRIORITY_COLOR[job.priority]}>{job.priority}</Badge> : <span className="muted text-xs">normal</span>}</td>
                <td><Badge status={STATUS_COLOR[job.status]}>{job.status.replace('_', ' ')}</Badge></td>
                <td className="text-sm">{job.technician_name || <span className="muted">—</span>}</td>
                <td className="text-xs muted">{job.fleet_org_name || '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(job.total_cost)}</td>
                <td className="text-xs muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(job.created_at)}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => setViewJobId(job.id)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(job)}>×</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !jobs.length && <div style={{ padding: 24, textAlign: 'center' }} className="muted">No jobs match the current filters.</div>}
        {loading && <div style={{ padding: 24, textAlign: 'center' }} className="muted">Loading…</div>}
      </div>
      {totalPages > 1 && (
        <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 12 }}>
          <button className="btn btn-sm btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>← Prev</button>
          <span className="text-sm muted">{currentPage} / {totalPages}</span>
          <button className="btn btn-sm btn-secondary" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>Next →</button>
        </div>
      )}

      {viewJobId && (
        <JobDetailModal jobId={viewJobId} onClose={() => setViewJobId(null)} onChanged={load} />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete job card"
          body={`Permanently delete Job #${confirmDelete.id} for ${confirmDelete.display_registration || 'this bike'}? All line items will be removed too.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={deleteJob}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}

// --- Tab: Technicians ---
function TechniciansTab() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/workshop/admin/technician-stats')
      .then((r) => setData(r.data.technicians))
      .catch(() => toast.error('Could not load technician stats'));
  }, []);

  if (!data) return <Loading />;

  const medals = [Trophy, Medal, Award];

  return (
    <>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Performance by Technician</div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th style={{ width: 36 }}>#</th><th>Technician</th><th style={{ textAlign: 'right' }}>Completed</th><th style={{ textAlign: 'right' }}>Active</th><th style={{ textAlign: 'right' }}>Total jobs</th><th style={{ textAlign: 'right' }}>Revenue</th><th style={{ textAlign: 'right' }}>Avg hours</th></tr>
          </thead>
          <tbody>
            {data.map((tech, i) => {
              const MedalIcon = medals[i] || null;
              return (
                <tr key={tech.id}>
                  <td style={{ textAlign: 'center' }}>
                    {MedalIcon
                      ? <MedalIcon size={16} style={{ color: i === 0 ? '#f59e0b' : i === 1 ? '#94a3b8' : '#c2956d' }} />
                      : <span className="muted text-xs">{i + 1}</span>}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{tech.full_name}</div>
                    <div className="text-xs muted">{tech.email} · {tech.role}</div>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--success, #22c55e)' }}>{tech.completed_jobs}</td>
                  <td style={{ textAlign: 'right' }}>{tech.active_jobs}</td>
                  <td style={{ textAlign: 'right' }}>{tech.total_jobs}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(tech.total_revenue)}</td>
                  <td style={{ textAlign: 'right' }} className="muted text-sm">{tech.avg_hours != null ? `${tech.avg_hours}h` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!data.length && <div style={{ padding: 24, textAlign: 'center' }} className="muted">No technician accounts yet. Add them in the Staff tab.</div>}
      </div>
    </>
  );
}

// --- Tab: Fleet Health ---
function FleetHealthTab() {
  const [bikes, setBikes] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  useEffect(() => {
    api.get('/workshop/admin/fleet-health')
      .then((r) => setBikes(r.data.bikes))
      .catch(() => toast.error('Could not load fleet health'));
  }, []);

  const filtered = useMemo(() => (bikes || []).filter((b) => {
    if (filter === 'overdue' && b.service_health !== 'overdue') return false;
    if (filter === 'due_soon' && b.service_health !== 'due_soon') return false;
    if (filter === 'in_workshop' && !b.active_job_id) return false;
    return matchesSearch(search, b.registration, b.vin, b.make, b.model, b.org_name);
  }), [bikes, filter, search]);

  if (!bikes) return <Loading />;

  const overdue = bikes.filter((b) => b.service_health === 'overdue').length;
  const dueSoon = bikes.filter((b) => b.service_health === 'due_soon').length;
  const inWorkshop = bikes.filter((b) => b.active_job_id).length;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KPI label="Overdue service" value={overdue} accent="#ef4444" />
        <KPI label="Due within 30d" value={dueSoon} accent="#f97316" />
        <KPI label="In workshop" value={inWorkshop} accent="#6366f1" />
        <KPI label="Total bikes" value={bikes.length} accent="#6b7280" />
      </div>
      <div className="mb-3" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search registration, VIN, make, fleet…" style={{ flex: '1 1 240px', maxWidth: 340 }} />
        <div className="filter-pills">
          {[['all', 'All'], ['overdue', 'Overdue'], ['due_soon', 'Due soon'], ['in_workshop', 'In workshop']].map(([val, label]) => (
            <button key={val} className={`filter-pill ${filter === val ? 'active' : ''}`} onClick={() => setFilter(val)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Bike</th><th>Fleet</th><th>Service status</th><th>Last service</th><th>Next service</th><th>Next service km</th><th>Odometer</th><th>Workshop</th></tr>
          </thead>
          <tbody>
            {filtered.map((bike) => (
              <tr key={bike.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{bike.registration || bike.vin || '—'}</div>
                  <div className="text-xs muted">{bike.make} {bike.model}{bike.year ? ` · ${bike.year}` : ''}</div>
                </td>
                <td className="text-xs muted">{bike.org_name || '—'}</td>
                <td>
                  {bike.service_health === 'ok' && !bike.active_job_id
                    ? <Badge status="success">OK</Badge>
                    : <Badge status={HEALTH_COLOR[bike.service_health] || 'info'}>{HEALTH_LABEL[bike.service_health] || '—'}</Badge>}
                </td>
                <td className="text-xs muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(bike.last_service_date)}</td>
                <td className="text-xs" style={{ whiteSpace: 'nowrap', color: bike.service_health === 'overdue' ? 'var(--danger)' : undefined }}>
                  {bike.next_service_date ? fmtDate(bike.next_service_date) : '—'}
                </td>
                <td className="text-xs muted">{bike.next_service_km ? `${bike.next_service_km.toLocaleString()} km` : '—'}</td>
                <td className="text-xs muted">{bike.odometer_km ? `${bike.odometer_km.toLocaleString()} km` : '—'}</td>
                <td>
                  {bike.active_job_id
                    ? <Badge status={STATUS_COLOR[bike.active_job_status] || 'info'}>{(bike.active_job_status || '').replace('_', ' ')}</Badge>
                    : <span className="muted text-xs">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && <div style={{ padding: 24, textAlign: 'center' }} className="muted">No bikes match the current filter.</div>}
      </div>
    </>
  );
}

// --- Tab: Staff ---
function StaffTab() {
  const [staff, setStaff] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', password: '' });
  const [busy, setBusy] = useState(false);

  const workshopUrl = `${window.location.origin}/workshop/login`;

  const load = () => api.get('/workshop/admin/staff').then((r) => setStaff(r.data.staff)).catch(() => toast.error('Could not load staff'));
  useEffect(() => { load(); }, []);

  const createUser = async () => {
    try {
      setBusy(true);
      await api.post('/workshop/admin/staff', form);
      toast.success(`Technician account created for ${form.email}`);
      setShowCreate(false);
      setForm({ full_name: '', email: '', phone: '', password: '' });
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create account');
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (user) => {
    try {
      const newStatus = user.status === 'active' ? 'suspended' : 'active';
      await api.put(`/workshop/admin/staff/${user.id}`, { status: newStatus });
      toast.success(`${user.full_name} ${newStatus === 'active' ? 'reactivated' : 'suspended'}`);
      await load();
    } catch {
      toast.error('Could not update status');
    }
  };

  if (!staff) return <Loading />;

  return (
    <>
      <div className="flex-between mb-3">
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Workshop Staff</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="muted text-xs">Login link:</span>
            <code style={{ fontSize: 12, background: 'var(--bg)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)' }}>{workshopUrl}</code>
            <CopyButton text={workshopUrl} />
          </div>
        </div>
        <button className="btn" onClick={() => setShowCreate(true)}>+ Add technician</button>
      </div>

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Phone</th><th style={{ textAlign: 'right' }}>Completed</th><th style={{ textAlign: 'right' }}>Active</th><th>Status</th><th>Created</th><th style={{ width: 100 }}></th></tr>
          </thead>
          <tbody>
            {staff.map((user) => (
              <tr key={user.id}>
                <td style={{ fontWeight: 600 }}>{user.full_name}</td>
                <td className="text-sm">{user.email}</td>
                <td className="text-sm muted">{user.phone || '—'}</td>
                <td style={{ textAlign: 'right' }}>{user.completed_jobs}</td>
                <td style={{ textAlign: 'right' }}>{user.active_jobs}</td>
                <td><Badge status={user.status === 'active' ? 'success' : 'danger'}>{user.status}</Badge></td>
                <td className="text-xs muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(user.created_at)}</td>
                <td>
                  <button className={`btn btn-sm ${user.status === 'active' ? 'btn-secondary' : 'btn'}`} onClick={() => toggleStatus(user)}>
                    {user.status === 'active' ? 'Suspend' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!staff.length && (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <p className="muted">No technician accounts yet.</p>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setShowCreate(true)}>Add first technician</button>
          </div>
        )}
      </div>

      {showCreate && (
        <Modal title="Add technician account" onClose={() => setShowCreate(false)}>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="label">Full name</label>
              <input value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} placeholder="e.g. Thabo Nkosi" />
            </div>
            <div className="field">
              <label className="label">Email address</label>
              <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="thabo@example.com" />
            </div>
            <div className="field">
              <label className="label">Phone (optional)</label>
              <input type="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+27 82 000 0000" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="label">Password</label>
              <input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="Min. 8 characters" autoComplete="new-password" />
            </div>
          </div>
          <div className="card" style={{ padding: '10px 14px', marginTop: 4, marginBottom: 4, background: 'rgba(99,102,241,0.06)' }}>
            <div className="text-xs muted">The technician will log in at:</div>
            <code style={{ fontSize: 12 }}>{workshopUrl}</code>
            <CopyButton text={workshopUrl} />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn" onClick={createUser} disabled={busy || !form.full_name || !form.email || !form.password}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// --- Main component ---
export default function AdminWorkshop() {
  const [tab, setTab] = useState('Overview');

  return (
    <>
      <div className="mb-4">
        <h1 className="page-title">Workshop</h1>
        <p className="page-sub">Manage job cards, technicians, and fleet service health</p>
      </div>

      <div className="filter-pills mb-4">
        {TABS.map((t) => (
          <button key={t} className={`filter-pill ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === 'Overview' && <OverviewTab />}
      {tab === 'All Jobs' && <AllJobsTab />}
      {tab === 'Technicians' && <TechniciansTab />}
      {tab === 'Fleet Health' && <FleetHealthTab />}
      {tab === 'Staff' && <StaffTab />}
    </>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Zap, LayoutList, LayoutGrid } from 'lucide-react';
import api from '../../api';
import { Badge, Loading, Modal, SearchInput, fmt, fmtDateTime, matchesSearch } from '../../components/ui';
import { useAuth } from '../../auth';

const STATUS_PILLS = ['all', 'open', 'in_progress', 'completed', 'cancelled'];
const STATUS_COLOR = { open: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };
const PRIORITY_COLOR = { urgent: 'danger', high: 'warning', normal: '', low: '' };
const PRIORITY_BG = { urgent: 'rgba(239,68,68,0.06)', high: 'rgba(249,115,22,0.05)', normal: '', low: '' };
const PRIORITY_BORDER = { urgent: '#ef4444', high: '#f97316', normal: '#3b82f6', low: '#6b7280' };
const JOB_TYPES = ['service', 'repair', 'inspection', 'tyres', 'brakes', 'electrical', 'bodywork', 'other'];
const PRIORITIES = ['normal', 'high', 'urgent'];

const KANBAN_COLS = [
  { key: 'open', label: 'Open', accent: '#3b82f6' },
  { key: 'in_progress', label: 'In Progress', accent: '#eab308' },
  { key: 'completed', label: 'Completed', accent: '#22c55e' },
  { key: 'cancelled', label: 'Cancelled', accent: '#6b7280' },
];

const EMPTY_FORM = {
  bike_id: '', vin: '', registration: '', make: '', model: '', year: '', color: '', engine_cc: '',
  fleet_owner_name: '', job_type: 'service', description: '', priority: 'normal', technician_id: ''
};

function KanbanCard({ job, onStart, startingId, nav }) {
  return (
    <div
      className="card"
      style={{ padding: 0, cursor: 'pointer', marginBottom: 8, overflow: 'hidden', borderLeft: `3px solid ${PRIORITY_BORDER[job.priority] || PRIORITY_BORDER.normal}` }}
      onClick={() => nav(`/workshop/app/job-cards/${job.id}`)}
    >
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{job.display_registration || job.display_make || '—'}</div>
        <div className="text-xs muted" style={{ marginBottom: 6 }}>{job.display_make} {job.display_model} · {job.job_type}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <div>
            {job.priority !== 'normal' && <Badge status={PRIORITY_COLOR[job.priority]}>{job.priority}</Badge>}
          </div>
          <span style={{ fontWeight: 700, fontSize: 12 }}>{fmt(job.total_cost)}</span>
        </div>
        {job.technician_name && (
          <div className="text-xs muted" style={{ marginTop: 4 }}>{job.technician_name}</div>
        )}
      </div>
      {job.status === 'open' && (
        <div
          style={{ borderTop: '1px solid var(--border)', padding: '6px 12px', display: 'flex', justifyContent: 'flex-end' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="btn btn-sm"
            disabled={startingId === job.id}
            onClick={(e) => onStart(e, job.id)}
            style={{ fontSize: 11, padding: '3px 8px' }}
          >
            <Zap size={11} /> {startingId === job.id ? '…' : 'Start'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function WorkshopJobCards() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [jobs, setJobs] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [myJobsOnly, setMyJobsOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('list');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [bikeSearch, setBikeSearch] = useState('');
  const [bikeResults, setBikeResults] = useState([]);
  const [selectedBike, setSelectedBike] = useState(null);
  const [useManual, setUseManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startingId, setStartingId] = useState(null);

  const load = useCallback(async () => {
    const [jobsRes, techRes] = await Promise.all([
      api.get('/workshop/job-cards'),
      api.get('/workshop/technicians')
    ]);
    setJobs(jobsRes.data.job_cards);
    setTechnicians(techRes.data.technicians);
  }, []);

  useEffect(() => { load().catch(() => toast.error('Could not load job cards')); }, [load]);

  useEffect(() => {
    if (!bikeSearch || bikeSearch.length < 2) { setBikeResults([]); return; }
    const t = setTimeout(() => {
      api.get('/workshop/bikes/search', { params: { q: bikeSearch } })
        .then((r) => setBikeResults(r.data.bikes))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [bikeSearch]);

  const filtered = useMemo(() => (jobs || []).filter((j) => {
    if (statusFilter !== 'all' && j.status !== statusFilter) return false;
    if (myJobsOnly && j.technician_id !== user?.id) return false;
    return matchesSearch(search, j.display_registration, j.display_make, j.display_model, j.display_vin, j.technician_name, j.fleet_org_name, j.description);
  }), [jobs, statusFilter, myJobsOnly, search, user?.id]);

  const kanbanFiltered = useMemo(() => (jobs || []).filter((j) => {
    if (myJobsOnly && j.technician_id !== user?.id) return false;
    return matchesSearch(search, j.display_registration, j.display_make, j.display_model, j.display_vin, j.technician_name, j.fleet_org_name, j.description);
  }), [jobs, myJobsOnly, search, user?.id]);

  const selectBike = (bike) => {
    setSelectedBike(bike);
    setBikeSearch('');
    setBikeResults([]);
    setForm((f) => ({ ...f, bike_id: String(bike.id), vin: '', registration: '', make: '', model: '', year: '', color: '', engine_cc: '' }));
    setUseManual(false);
  };

  const clearBike = () => { setSelectedBike(null); setForm((f) => ({ ...f, bike_id: '' })); };

  const closeCreate = () => { setShowCreate(false); setForm(EMPTY_FORM); setSelectedBike(null); setBikeSearch(''); setBikeResults([]); setUseManual(false); };

  const createJob = async () => {
    try {
      setBusy(true);
      const payload = { ...form };
      if (form.bike_id) {
        ['vin', 'registration', 'make', 'model', 'year', 'color', 'engine_cc'].forEach((k) => delete payload[k]);
      }
      const { data } = await api.post('/workshop/job-cards', payload);
      toast.success('Job card created');
      closeCreate();
      nav(`/workshop/app/job-cards/${data.id}`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create job card');
    } finally {
      setBusy(false);
    }
  };

  const startJob = async (e, jobId) => {
    e.stopPropagation();
    try {
      setStartingId(jobId);
      await api.post(`/workshop/job-cards/${jobId}/start`);
      toast.success('Job started');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not start job');
    } finally {
      setStartingId(null);
    }
  };

  const canCreate = form.bike_id || (form.vin && form.make && form.model);

  const openCount = (jobs || []).filter((j) => j.status === 'open').length;
  const inProgressCount = (jobs || []).filter((j) => j.status === 'in_progress').length;

  if (!jobs) return <Loading />;

  return (
    <>
      <div className="flex-between mb-3" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Job Cards</h1>
          <p className="page-sub">{openCount} open · {inProgressCount} in progress · {jobs.length} total</p>
        </div>
        <button className="btn" onClick={() => setShowCreate(true)}>+ New job card</button>
      </div>

      <div className="mb-3" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search bike, VIN, technician, description…" style={{ flex: '1 1 260px', maxWidth: 360 }} />
        {viewMode === 'list' && (
          <div className="filter-pills">
            {STATUS_PILLS.map((s) => (
              <button key={s} className={`filter-pill ${statusFilter === s ? 'active' : ''}`} onClick={() => setStatusFilter(s)}>
                {s === 'all' ? 'All' : s.replace('_', ' ')}
              </button>
            ))}
          </div>
        )}
        <button
          className={`filter-pill ${myJobsOnly ? 'active' : ''}`}
          onClick={() => setMyJobsOnly((v) => !v)}
          title="Show only jobs assigned to me"
        >
          My jobs
        </button>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 2 }}>
          <button
            onClick={() => setViewMode('list')}
            title="List view"
            style={{ background: viewMode === 'list' ? 'var(--accent)' : 'transparent', color: viewMode === 'list' ? '#fff' : 'var(--muted)', border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <LayoutList size={15} />
          </button>
          <button
            onClick={() => setViewMode('kanban')}
            title="Kanban view"
            style={{ background: viewMode === 'kanban' ? 'var(--accent)' : 'transparent', color: viewMode === 'kanban' ? '#fff' : 'var(--muted)', border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <LayoutGrid size={15} />
          </button>
        </div>
      </div>

      {viewMode === 'kanban' ? (
        <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(220px, 1fr))', gap: 14, alignItems: 'start', minWidth: 900 }}>
            {KANBAN_COLS.map((col) => {
              const colJobs = kanbanFiltered.filter((j) => j.status === col.key);
              return (
                <div key={col.key}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '0 4px' }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: col.accent, flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{col.label}</span>
                    <span
                      style={{ marginLeft: 'auto', background: col.accent + '22', color: col.accent, borderRadius: 10, fontSize: 11, padding: '1px 7px', fontWeight: 700 }}
                    >
                      {colJobs.length}
                    </span>
                  </div>
                  <div style={{ minHeight: 80 }}>
                    {colJobs.map((job) => (
                      <KanbanCard key={job.id} job={job} onStart={startJob} startingId={startingId} nav={nav} />
                    ))}
                    {colJobs.length === 0 && (
                      <div
                        style={{ padding: '24px 0', textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 8 }}
                        className="muted text-xs"
                      >
                        No jobs
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <div className="card table-wrap" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Bike</th>
                  <th className="col-mobile-hide">Type</th>
                  <th className="col-mobile-hide">Priority</th>
                  <th>Status</th>
                  <th className="col-mobile-hide">Technician</th>
                  <th className="col-mobile-hide">Fleet</th>
                  <th style={{ textAlign: 'right' }}>Cost</th>
                  <th className="col-mobile-hide">Created</th>
                  <th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((job) => (
                  <tr
                    key={job.id}
                    style={{ cursor: 'pointer', background: PRIORITY_BG[job.priority] || undefined }}
                    onClick={() => nav(`/workshop/app/job-cards/${job.id}`)}
                  >
                    <td>
                      <div style={{ fontWeight: 700 }}>{job.display_registration || '—'}</div>
                      <div className="text-xs muted">{job.display_make} {job.display_model}</div>
                      {/* Status + priority shown inline on mobile (desktop hides this) */}
                      <div className="mobile-only" style={{ marginTop: 5, gap: 4, flexWrap: 'wrap' }}>
                        <Badge status={STATUS_COLOR[job.status]}>{job.status.replace('_', ' ')}</Badge>
                        {job.priority !== 'normal' && <Badge status={PRIORITY_COLOR[job.priority]}>{job.priority}</Badge>}
                      </div>
                    </td>
                    <td className="col-mobile-hide text-sm">{job.job_type}</td>
                    <td className="col-mobile-hide">
                      {job.priority !== 'normal'
                        ? <Badge status={PRIORITY_COLOR[job.priority]}>{job.priority}</Badge>
                        : <span className="muted text-xs">normal</span>}
                    </td>
                    <td className="col-mobile-hide"><Badge status={STATUS_COLOR[job.status]}>{job.status.replace('_', ' ')}</Badge></td>
                    <td className="col-mobile-hide text-sm">{job.technician_name || <span className="muted">—</span>}</td>
                    <td className="col-mobile-hide text-xs muted">{job.fleet_org_name || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(job.total_cost)}</td>
                    <td className="col-mobile-hide" style={{ whiteSpace: 'nowrap' }}><span className="text-xs muted">{fmtDateTime(job.created_at)}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {job.status === 'open' && (
                        <button className="btn btn-sm" disabled={startingId === job.id} onClick={(e) => startJob(e, job.id)} title="Start this job">
                          <Zap size={12} /> {startingId === job.id ? '…' : 'Start'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <p className="muted">{search || statusFilter !== 'all' || myJobsOnly ? 'No job cards match your filters.' : 'No job cards yet.'}</p>
                <button className="btn" style={{ marginTop: 12 }} onClick={() => setShowCreate(true)}>Create first job card</button>
              </div>
            )}
          </div>
        </>
      )}

      {showCreate && (
        <Modal title="New Job Card" onClose={closeCreate}>
          <div className="field">
            <label className="label">Bike</label>
            {selectedBike ? (
              <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{selectedBike.registration || selectedBike.vin}</div>
                  <div className="text-xs muted">{selectedBike.make} {selectedBike.model}{selectedBike.year ? ` · ${selectedBike.year}` : ''}{selectedBike.org_name ? ` · ${selectedBike.org_name}` : ''}</div>
                </div>
                <button className="btn btn-sm btn-secondary" onClick={clearBike}>Change</button>
              </div>
            ) : !useManual ? (
              <div style={{ position: 'relative' }}>
                <input
                  value={bikeSearch}
                  onChange={(e) => setBikeSearch(e.target.value)}
                  placeholder="Search by registration, VIN, make…"
                />
                {bikeResults.length > 0 && (
                  <div className="card" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, padding: 8, maxHeight: 220, overflowY: 'auto' }}>
                    {bikeResults.map((b) => (
                      <button key={b.id} className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 4 }} onClick={() => selectBike(b)}>
                        <strong>{b.registration || b.vin}</strong>&nbsp;·&nbsp;{b.make} {b.model}{b.org_name ? ` · ${b.org_name}` : ''}
                      </button>
                    ))}
                  </div>
                )}
                <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={() => setUseManual(true)}>
                  Register new bike instead
                </button>
              </div>
            ) : (
              <div>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <div className="field"><label className="label">VIN <span style={{ color: 'var(--danger)' }}>*</span></label><input value={form.vin} onChange={(e) => setForm((f) => ({ ...f, vin: e.target.value }))} placeholder="Required" /></div>
                  <div className="field"><label className="label">Registration</label><input value={form.registration} onChange={(e) => setForm((f) => ({ ...f, registration: e.target.value }))} /></div>
                  <div className="field"><label className="label">Make <span style={{ color: 'var(--danger)' }}>*</span></label><input value={form.make} onChange={(e) => setForm((f) => ({ ...f, make: e.target.value }))} /></div>
                  <div className="field"><label className="label">Model <span style={{ color: 'var(--danger)' }}>*</span></label><input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} /></div>
                  <div className="field"><label className="label">Year</label><input type="number" value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))} /></div>
                  <div className="field"><label className="label">Color</label><input value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} /></div>
                  <div className="field"><label className="label">Engine cc</label><input type="number" value={form.engine_cc} onChange={(e) => setForm((f) => ({ ...f, engine_cc: e.target.value }))} /></div>
                  <div className="field"><label className="label">Fleet owner name</label><input value={form.fleet_owner_name} onChange={(e) => setForm((f) => ({ ...f, fleet_owner_name: e.target.value }))} placeholder="Optional" /></div>
                </div>
                <button className="btn btn-sm btn-secondary" style={{ marginTop: 4 }} onClick={() => { setUseManual(false); setForm((f) => ({ ...f, vin: '', registration: '', make: '', model: '', year: '', color: '', engine_cc: '' })); }}>
                  ← Search existing bike
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label className="label">Job type</label>
              <select value={form.job_type} onChange={(e) => setForm((f) => ({ ...f, job_type: e.target.value }))}>
                {JOB_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Priority</label>
              <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label className="label">Assign technician</label>
            <select value={form.technician_id} onChange={(e) => setForm((f) => ({ ...f, technician_id: e.target.value }))}>
              <option value="">Assign later</option>
              {technicians.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label">Description / fault report</label>
            <textarea rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Describe the work needed…" />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={closeCreate}>Cancel</button>
            <button className="btn" onClick={createJob} disabled={busy || !canCreate}>{busy ? 'Creating…' : 'Create job card'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

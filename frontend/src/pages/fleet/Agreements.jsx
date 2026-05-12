import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { FleetHelpTip } from './helpSupport';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, EmptyState, Loading, Modal, Pagination, SearchInput, fmt, fmtDate, matchesSearch, paginateItems } from '../../components/ui';
import { canManageFleetSection } from './access';

const STATUS_OPTIONS = ['', 'active', 'completed', 'defaulted', 'cancelled', 'paused', 'discontinued'];

function labelize(value) {
  if (!value) return 'All';
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const emptyPortal = {
  bikes: [],
  agreements: [],
  rider_options: []
};

export default function FleetOwnerAgreements() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'agreements');
  const [portal, setPortal] = useState(emptyPortal);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [actionBusy, setActionBusy] = useState('');
  const [editingRemainingId, setEditingRemainingId] = useState(null);
  const [savingRemainingId, setSavingRemainingId] = useState(null);
  const [remainingDrafts, setRemainingDrafts] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [createForm, setCreateForm] = useState({ bike_id: '', rider_id: '', start_date: todayIso(), weekly_amount: '', total_weeks: '', notes: '' });
  const [reassignForm, setReassignForm] = useState({ agreement_id: '', target_bike_id: '', note: '' });

  const load = async () => {
    const { data } = await api.get('/fleet/portal-data');
    const nextPortal = { ...emptyPortal, ...data };
    setPortal(nextPortal);
    setRemainingDrafts(Object.fromEntries((nextPortal.agreements || []).map((agreement) => [agreement.id, String(Number(agreement.remaining_balance || 0).toFixed(2))])));
  };

  useEffect(() => { load().catch(() => toast.error('Could not load agreements')); }, []);
  useEffect(() => { setPage(1); }, [search, status]);

  const agreements = useMemo(() => (portal.agreements || []).filter((agreement) => {
    if (status && agreement.status !== status) return false;
    return matchesSearch(search, agreement.agreement_no, agreement.rider_name, agreement.rider_email, agreement.bike_registration, agreement.make, agreement.model, agreement.status, agreement.bike_status, agreement.weekly_amount, agreement.total_amount);
  }), [portal.agreements, search, status]);
  const pagination = useMemo(() => paginateItems(agreements, page, pageSize), [agreements, page, pageSize]);
  const readyBikeOptions = useMemo(() => (portal.bikes || []).filter((bike) => bike.status === 'ready_to_go'), [portal.bikes]);
  const riderOptions = useMemo(() => (portal.rider_options || []).filter((rider) => !Number(rider.has_open_agreement)), [portal.rider_options]);

  const openCreate = () => {
    setCreateForm({ bike_id: '', rider_id: '', start_date: todayIso(), weekly_amount: '', total_weeks: '', notes: '' });
    setShowCreate(true);
  };

  const openReassign = (agreement) => {
    setReassignForm({ agreement_id: String(agreement.id), target_bike_id: '', note: '' });
    setShowReassign(true);
  };

  const submitCreate = async () => {
    try {
      setActionBusy('create');
      await api.post('/fleet/agreements', {
        bike_id: Number(createForm.bike_id),
        rider_id: Number(createForm.rider_id),
        start_date: createForm.start_date,
        weekly_amount: createForm.weekly_amount ? Number(createForm.weekly_amount) : undefined,
        total_weeks: createForm.total_weeks ? Number(createForm.total_weeks) : undefined,
        notes: createForm.notes || undefined
      });
      toast.success('Agreement created');
      setShowCreate(false);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create agreement');
    } finally {
      setActionBusy('');
    }
  };

  const submitReassign = async () => {
    try {
      setActionBusy('reassign');
      await api.post('/fleet/reassignments', {
        agreement_id: Number(reassignForm.agreement_id),
        target_bike_id: Number(reassignForm.target_bike_id),
        note: reassignForm.note || undefined
      });
      toast.success('Agreement reassigned');
      setShowReassign(false);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reassign agreement');
    } finally {
      setActionBusy('');
    }
  };

  const updateStatus = async (agreement, nextStatus) => {
    const confirmText = nextStatus === 'discontinued'
      ? 'Discontinue this agreement and waive future unpaid schedule rows?'
      : `Change agreement ${agreement.agreement_no} to ${labelize(nextStatus)}?`;
    if (!window.confirm(confirmText)) return;
    try {
      setActionBusy(`${agreement.id}-${nextStatus}`);
      await api.post(`/fleet/agreements/${agreement.id}/status`, { status: nextStatus });
      toast.success(`Agreement updated to ${labelize(nextStatus)}`);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update agreement');
    } finally {
      setActionBusy('');
    }
  };

  const reinstate = async (agreement) => {
    if (!window.confirm('Reinstate this discontinued agreement and resume future payments?')) return;
    try {
      setActionBusy(`${agreement.id}-reinstate`);
      await api.post(`/fleet/agreements/${agreement.id}/reinstate`);
      toast.success('Agreement reinstated');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reinstate agreement');
    } finally {
      setActionBusy('');
    }
  };

  const openRemainingEditor = (agreement) => {
    setEditingRemainingId(agreement.id);
    setRemainingDrafts((current) => ({ ...current, [agreement.id]: String(Number(agreement.remaining_balance || 0).toFixed(2)) }));
  };

  const saveRemainingBalance = async (agreement) => {
    const amount = Number(remainingDrafts[agreement.id]);
    if (!Number.isFinite(amount) || amount < 0) return toast.error('Remaining balance must be zero or greater');
    try {
      setSavingRemainingId(agreement.id);
      await api.patch(`/fleet/agreements/${agreement.id}/remaining-balance`, { remaining_balance: amount });
      toast.success('Remaining balance updated');
      setEditingRemainingId(null);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update remaining balance');
    } finally {
      setSavingRemainingId(null);
    }
  };

  if (!portal.agreements) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Agreements</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>Create new rider agreements, reassign bikes, and manage contract status with the same table-first workflow as the super admin portal.</p>
          <FleetHelpTip section="agreements" tooltip="Use this guide for creating agreements, reassigning bikes, changing statuses, and editing remaining balances." label="Learn more about agreements" />
        </div>
        {canManage && <button className="btn" onClick={openCreate} title="Create a new agreement between a ready bike and an available rider">Add agreement</button>}
      </div>

      <div className="row mb-3" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search agreement, rider, bike, registration" style={{ flex: '1 1 320px', maxWidth: 440 }} />
        <div className="field" style={{ minWidth: 220, marginBottom: 0 }}>
          <label className="label">Agreement status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((value) => <option key={value || 'all'} value={value}>{labelize(value)}</option>)}
          </select>
        </div>
        <button className="btn btn-secondary" onClick={() => { setSearch(''); setStatus(''); }} title="Reset the current agreement search and status filters">Clear filters</button>
        <FleetHelpTip section="agreements" tooltip="Filter by agreement status to focus on active collections, paused contracts, defaulted riders, or completed agreements." label="Filtering help" compact />
      </div>

      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="muted text-sm">Showing {agreements.length} matching agreements</div>
          <FleetHelpTip section="common-questions" tooltip="Remaining balances can be edited on active, paused, and defaulted agreements to recalculate the unpaid schedule." label="Balance help" compact />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="badge badge-muted">Ready bikes: {readyBikeOptions.length}</div>
          <div className="badge badge-muted">Available riders: {riderOptions.length}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Agreement</th>
              <th>Rider</th>
              <th>Bike</th>
              <th>Bike status</th>
              <th>Weekly</th>
              <th>Overdue</th>
              <th title="For active, paused, and defaulted agreements, click the remaining balance value to edit the outstanding amount.">Remaining</th>
              <th>Status</th>
              <th>Start</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((agreement) => {
              const busy = actionBusy.startsWith(`${agreement.id}-`);
              const canEditRemaining = canManage && ['active', 'paused', 'defaulted'].includes(agreement.status);
              const isEditingRemaining = editingRemainingId === agreement.id;
              return (
                <tr key={agreement.id}>
                  <td><strong>{agreement.agreement_no}</strong></td>
                  <td>{agreement.rider_name}<div className="text-xs muted">{agreement.rider_email}</div></td>
                  <td>{agreement.make} {agreement.model}<div className="text-xs muted">{agreement.bike_registration || '—'}</div></td>
                  <td><Badge status={agreement.bike_status}>{labelize(agreement.bike_status)}</Badge></td>
                  <td>{fmt(agreement.weekly_amount)}</td>
                  <td>{fmt(agreement.overdue_balance)}</td>
                  <td>
                    {isEditingRemaining ? (
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={remainingDrafts[agreement.id] ?? ''}
                          onChange={(e) => setRemainingDrafts((current) => ({ ...current, [agreement.id]: e.target.value }))}
                          style={{ width: 120 }}
                        />
                        <button className="btn btn-sm" disabled={savingRemainingId === agreement.id} onClick={() => saveRemainingBalance(agreement)}>{savingRemainingId === agreement.id ? 'Saving…' : 'Save'}</button>
                        <button className="btn btn-sm btn-secondary" disabled={savingRemainingId === agreement.id} onClick={() => setEditingRemainingId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        {canEditRemaining ? (
                          <button className="btn btn-sm btn-secondary" onClick={() => openRemainingEditor(agreement)}>{fmt(agreement.remaining_balance)}</button>
                        ) : (
                          fmt(agreement.remaining_balance)
                        )}
                        {canEditRemaining && <div className="text-xs muted mt-1">Click to edit</div>}
                      </>
                    )}
                  </td>
                  <td><Badge status={agreement.status}>{labelize(agreement.status)}</Badge></td>
                  <td>{fmtDate(agreement.start_date)}</td>
                  <td>
                    {canManage ? (
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        {['active', 'paused', 'defaulted'].includes(agreement.status) && <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => openReassign(agreement)}>Reassign</button>}
                        {agreement.status === 'active' && <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => updateStatus(agreement, 'paused')}>Pause</button>}
                        {agreement.status === 'paused' && <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => updateStatus(agreement, 'active')}>Resume</button>}
                        {agreement.status === 'active' && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => updateStatus(agreement, 'defaulted')}>Default</button>}
                        {!['completed', 'cancelled', 'discontinued'].includes(agreement.status) && <button className="btn btn-sm" disabled={busy} onClick={() => updateStatus(agreement, 'completed')}>Complete</button>}
                        {!['completed', 'cancelled', 'discontinued'].includes(agreement.status) && <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => updateStatus(agreement, 'cancelled')}>Cancel</button>}
                        {!['completed', 'cancelled', 'discontinued'].includes(agreement.status) && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => updateStatus(agreement, 'discontinued')}>Discontinue</button>}
                        {agreement.status === 'discontinued' && agreement.discontinued_reason === 'bike_stolen' && <button className="btn btn-sm" disabled={busy} onClick={() => reinstate(agreement)}>Reinstate</button>}
                      </div>
                    ) : <span className="muted text-sm">No action</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!pagination.items.length && <EmptyState title="No agreements found" sub={search || status ? 'Adjust your filters or search terms to see more agreements.' : 'Create your first rider agreement to start collections tracking.'} action={canManage ? <button className="btn" onClick={openCreate}>Add agreement</button> : null} />}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="agreements" />

      {showCreate && (
        <Modal title="Add agreement" onClose={() => setShowCreate(false)}>
          <div className="mb-3">
            <FleetHelpTip section="agreements" tooltip="Create agreements only with ready bikes and riders who do not already have an open agreement." label="Open agreement creation guide" compact />
          </div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Bike</label><select value={createForm.bike_id} onChange={(e) => setCreateForm({ ...createForm, bike_id: e.target.value })}><option value="">Select ready bike</option>{readyBikeOptions.map((bike) => <option key={bike.id} value={bike.id}>{bike.registration || `Bike #${bike.id}`} · {bike.make} {bike.model}</option>)}</select></div>
            <div className="field"><label className="label">Rider</label><select value={createForm.rider_id} onChange={(e) => setCreateForm({ ...createForm, rider_id: e.target.value })}><option value="">Select rider</option>{riderOptions.map((rider) => <option key={rider.id} value={rider.id}>{rider.full_name} · {rider.email}</option>)}</select></div>
            <div className="field"><label className="label">Start date</label><input type="date" value={createForm.start_date} onChange={(e) => setCreateForm({ ...createForm, start_date: e.target.value })} /></div>
            <div className="field"><label className="label">Weekly amount</label><input type="number" value={createForm.weekly_amount} onChange={(e) => setCreateForm({ ...createForm, weekly_amount: e.target.value })} /></div>
            <div className="field"><label className="label">Total weeks</label><input type="number" value={createForm.total_weeks} onChange={(e) => setCreateForm({ ...createForm, total_weeks: e.target.value })} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Notes</label><textarea rows={3} value={createForm.notes} onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })} /></div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn" onClick={submitCreate} disabled={actionBusy === 'create' || !readyBikeOptions.length || !riderOptions.length}>{actionBusy === 'create' ? 'Creating…' : 'Create agreement'}</button>
          </div>
        </Modal>
      )}

      {showReassign && (
        <Modal title="Reassign bike" onClose={() => setShowReassign(false)}>
          <div className="mb-3">
            <FleetHelpTip section="agreements" tooltip="Reassign when the rider should continue the same agreement on a different ready bike instead of starting a new contract." label="When to reassign" compact />
          </div>
          <div className="field"><label className="label">Target bike</label><select value={reassignForm.target_bike_id} onChange={(e) => setReassignForm({ ...reassignForm, target_bike_id: e.target.value })}><option value="">Select ready bike</option>{readyBikeOptions.map((bike) => <option key={bike.id} value={bike.id}>{bike.registration || `Bike #${bike.id}`} · {bike.make} {bike.model}</option>)}</select></div>
          <div className="field"><label className="label">Note</label><textarea rows={3} value={reassignForm.note} onChange={(e) => setReassignForm({ ...reassignForm, note: e.target.value })} /></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setShowReassign(false)}>Cancel</button>
            <button className="btn" onClick={submitReassign} disabled={actionBusy === 'reassign'}>{actionBusy === 'reassign' ? 'Reassigning…' : 'Reassign bike'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

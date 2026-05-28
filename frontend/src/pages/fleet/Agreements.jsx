import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { FleetHelpTip } from './helpSupport';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, ConfirmModal, EmptyState, Loading, Modal, Pagination, SearchInput, fmt, fmtDate, matchesSearch, paginateItems } from '../../components/ui';
import { canManageFleetSection } from './access';

const STATUS_OPTIONS = ['', 'active', 'completed', 'defaulted', 'cancelled', 'paused', 'discontinued'];

function labelize(value) {
  if (!value) return 'All';
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysOverdue(agreement) {
  if (!['defaulted', 'paused'].includes(agreement.status)) return null;
  if (!(agreement.overdue_balance > 0)) return null;
  if (!agreement.start_date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(agreement.start_date);
  return Math.max(0, Math.round((today - start) / 86400000));
}

const emptyPortal = { bikes: [], agreements: [], rider_options: [] };

export default function FleetOwnerAgreements() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'agreements');
  const [portal, setPortal] = useState(emptyPortal);
  const [loading, setLoading] = useState(true);
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
  const [showBalanceModal, setShowBalanceModal] = useState(null);
  const [balanceDraft, setBalanceDraft] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [createForm, setCreateForm] = useState({ bike_id: '', rider_id: '', start_date: todayIso(), weekly_amount: '', total_weeks: '', notes: '' });
  const [reassignForm, setReassignForm] = useState({ agreement_id: '', target_bike_id: '', note: '' });

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    const { data } = await api.get('/fleet/portal-data');
    const nextPortal = { ...emptyPortal, ...data };
    setPortal(nextPortal);
    setRemainingDrafts(Object.fromEntries((nextPortal.agreements || []).map((a) => [a.id, String(Number(a.remaining_balance || 0).toFixed(2))])));
    if (!silent) setLoading(false);
  };

  useEffect(() => { load().catch(() => { toast.error('Could not load agreements'); setLoading(false); }); }, []);
  useEffect(() => { setPage(1); }, [search, status]);

  const agreements = useMemo(() => (portal.agreements || []).filter((a) => {
    if (status && a.status !== status) return false;
    return matchesSearch(search, a.agreement_no, a.rider_name, a.rider_email, a.bike_registration, a.make, a.model, a.status, a.bike_status, a.weekly_amount, a.total_amount);
  }), [portal.agreements, search, status]);
  const pagination = useMemo(() => paginateItems(agreements, page, pageSize), [agreements, page, pageSize]);
  const readyBikeOptions = useMemo(() => (portal.bikes || []).filter((b) => b.status === 'ready_to_go'), [portal.bikes]);
  const riderOptions = useMemo(() => (portal.rider_options || []).filter((r) => !Number(r.has_open_agreement)), [portal.rider_options]);

  const openCreate = () => {
    setCreateForm({ bike_id: '', rider_id: '', start_date: todayIso(), weekly_amount: '', total_weeks: '', notes: '' });
    setShowCreate(true);
  };

  const openReassign = (agreement) => {
    setReassignForm({ agreement_id: String(agreement.id), target_bike_id: '', note: '' });
    setShowReassign(true);
  };

  const openBalanceModal = (agreement) => {
    setShowBalanceModal(agreement);
    setBalanceDraft(String(Number(agreement.remaining_balance || 0).toFixed(2)));
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
      await load({ silent: true });
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
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reassign agreement');
    } finally {
      setActionBusy('');
    }
  };

  const saveBalance = async () => {
    if (!showBalanceModal) return;
    const amount = Number(balanceDraft);
    if (!Number.isFinite(amount) || amount < 0) return toast.error('Remaining balance must be zero or greater');
    try {
      setSavingRemainingId(showBalanceModal.id);
      await api.patch(`/fleet/agreements/${showBalanceModal.id}/remaining-balance`, { remaining_balance: amount });
      toast.success('Remaining balance updated');
      setShowBalanceModal(null);
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update remaining balance');
    } finally {
      setSavingRemainingId(null);
    }
  };

  const requestConfirm = (agreement, nextStatus) => {
    const isDestructive = ['defaulted', 'discontinued', 'cancelled'].includes(nextStatus);
    const messages = {
      paused: 'This will pause collections on the agreement.',
      active: 'This will resume the agreement and continue the payment schedule.',
      defaulted: 'This will mark the agreement as defaulted and flag it for collections follow-up.',
      completed: 'This will mark the agreement as completed and close the contract.',
      cancelled: 'This will cancel the agreement. This action is hard to reverse.',
      discontinued: 'This will discontinue the agreement and waive all future unpaid schedule rows. This cannot be undone.'
    };
    setConfirm({
      title: `${labelize(nextStatus)} agreement ${agreement.agreement_no}?`,
      body: messages[nextStatus] || `Change agreement to ${labelize(nextStatus)}.`,
      danger: isDestructive,
      confirmLabel: labelize(nextStatus),
      onConfirm: () => runStatusChange(agreement, nextStatus)
    });
  };

  const requestReinstate = (agreement) => {
    setConfirm({
      title: `Reinstate agreement ${agreement.agreement_no}?`,
      body: 'This will reinstate the discontinued agreement and resume the future payment schedule.',
      danger: false,
      confirmLabel: 'Reinstate',
      onConfirm: () => runReinstate(agreement)
    });
  };

  const runStatusChange = async (agreement, nextStatus) => {
    try {
      setActionBusy(`${agreement.id}-${nextStatus}`);
      await api.post(`/fleet/agreements/${agreement.id}/status`, { status: nextStatus });
      toast.success(`Agreement updated to ${labelize(nextStatus)}`);
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update agreement');
    } finally {
      setActionBusy('');
      setConfirm(null);
    }
  };

  const runReinstate = async (agreement) => {
    try {
      setActionBusy(`${agreement.id}-reinstate`);
      await api.post(`/fleet/agreements/${agreement.id}/reinstate`);
      toast.success('Agreement reinstated');
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reinstate agreement');
    } finally {
      setActionBusy('');
      setConfirm(null);
    }
  };

  if (loading) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Agreements</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>Create rider agreements, reassign bikes, and manage contract status.</p>
          <FleetHelpTip section="agreements" tooltip="Use this guide for creating agreements, reassigning bikes, changing statuses, and editing remaining balances." label="Learn more about agreements" />
        </div>
        {canManage && <button className="btn" onClick={openCreate} title="Create a new agreement between a ready bike and an available rider">Add agreement</button>}
      </div>

      <div className="row mb-3" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search agreement, rider, bike, registration" style={{ flex: '1 1 320px', maxWidth: 440 }} />
        <div className="field" style={{ minWidth: 200, marginBottom: 0 }}>
          <label className="label">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((value) => <option key={value || 'all'} value={value}>{labelize(value)}</option>)}
          </select>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => { setSearch(''); setStatus(''); }}>Clear filters</button>
        <FleetHelpTip section="agreements" tooltip="Filter by agreement status to focus on active collections, paused contracts, defaulted riders, or completed agreements." label="Filtering help" compact />
      </div>

      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="muted text-sm">Showing {agreements.length} agreement{agreements.length !== 1 ? 's' : ''}</div>
          <FleetHelpTip section="common-questions" tooltip="Remaining balances can be edited on active, paused, and defaulted agreements to recalculate the unpaid schedule." label="Balance help" compact />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="badge badge-muted">Ready bikes: {readyBikeOptions.length}</div>
          <div className="badge badge-muted">Available riders: {riderOptions.length}</div>
        </div>
      </div>

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Agreement</th>
              <th>Rider</th>
              <th>Bike</th>
              <th>Bike status</th>
              <th>Weekly</th>
              <th>Overdue</th>
              <th title="Click the remaining balance on active/paused/defaulted agreements to edit it.">Remaining</th>
              <th>Status</th>
              <th>Start</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((agreement) => {
              const busy = actionBusy.startsWith(`${agreement.id}-`);
              const canEditRemaining = canManage && ['active', 'paused', 'defaulted'].includes(agreement.status);
              const overdueDays = daysOverdue(agreement);
              return (
                <tr key={agreement.id}>
                  <td><strong>{agreement.agreement_no}</strong></td>
                  <td>
                    {agreement.rider_name}
                    <div className="text-xs muted">{agreement.rider_email}</div>
                  </td>
                  <td>
                    {agreement.bike_registration || 'Pending registration'}
                    <div className="text-xs muted">{[agreement.make, agreement.model].filter(Boolean).join(' ') || '—'}</div>
                  </td>
                  <td><Badge status={agreement.bike_status}>{labelize(agreement.bike_status)}</Badge></td>
                  <td>{fmt(agreement.weekly_amount)}</td>
                  <td>
                    {agreement.overdue_balance > 0 ? (
                      <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{fmt(agreement.overdue_balance)}</span>
                    ) : fmt(agreement.overdue_balance)}
                    {overdueDays !== null && <div className="text-xs muted">{overdueDays}d overdue</div>}
                  </td>
                  <td>
                    {canEditRemaining ? (
                      <button className="btn btn-sm btn-secondary" onClick={() => openBalanceModal(agreement)} title="Click to edit remaining balance">
                        {fmt(agreement.remaining_balance)}
                      </button>
                    ) : fmt(agreement.remaining_balance)}
                  </td>
                  <td><Badge status={agreement.status}>{labelize(agreement.status)}</Badge></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(agreement.start_date)}</td>
                  {canManage && (
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {['active', 'paused', 'defaulted'].includes(agreement.status) && <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => openReassign(agreement)}>Reassign</button>}
                        {agreement.status === 'active' && <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => requestConfirm(agreement, 'paused')}>Pause</button>}
                        {agreement.status === 'paused' && <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => requestConfirm(agreement, 'active')}>Resume</button>}
                        {agreement.status === 'active' && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => requestConfirm(agreement, 'defaulted')}>Default</button>}
                        {!['completed', 'cancelled', 'discontinued'].includes(agreement.status) && <button className="btn btn-sm" disabled={busy} onClick={() => requestConfirm(agreement, 'completed')}>Complete</button>}
                        {!['completed', 'cancelled', 'discontinued'].includes(agreement.status) && <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => requestConfirm(agreement, 'cancelled')}>Cancel</button>}
                        {!['completed', 'cancelled', 'discontinued'].includes(agreement.status) && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => requestConfirm(agreement, 'discontinued')}>Discontinue</button>}
                        {agreement.status === 'discontinued' && agreement.discontinued_reason === 'bike_stolen' && <button className="btn btn-sm" disabled={busy} onClick={() => requestReinstate(agreement)}>Reinstate</button>}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!pagination.items.length && (
          <EmptyState
            title="No agreements found"
            sub={search || status ? 'Adjust your filters or search terms to see more agreements.' : 'Create your first rider agreement to start collections tracking.'}
            action={canManage ? <button className="btn" onClick={openCreate}>Add agreement</button> : null}
          />
        )}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="agreements" />

      {/* Confirm modal for status changes */}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          danger={confirm.danger}
          confirmLabel={confirm.confirmLabel}
          busy={!!actionBusy}
          onConfirm={confirm.onConfirm}
          onClose={() => { if (!actionBusy) setConfirm(null); }}
        />
      )}

      {/* Balance edit modal */}
      {showBalanceModal && (
        <Modal title={`Edit remaining balance — ${showBalanceModal.agreement_no}`} onClose={() => { if (!savingRemainingId) setShowBalanceModal(null); }}>
          <div className="mb-3">
            <FleetHelpTip section="common-questions" tooltip="Editing the remaining balance recalculates the unpaid payment schedule. Use this to correct errors or apply manual adjustments." label="Balance edit guide" compact />
          </div>
          <div className="fleet-demo-list mb-4" style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            <div className="flex-between"><span className="muted text-sm">Rider</span><strong>{showBalanceModal.rider_name}</strong></div>
            <div className="flex-between mt-2"><span className="muted text-sm">Current remaining</span><strong>{fmt(showBalanceModal.remaining_balance)}</strong></div>
            <div className="flex-between mt-2"><span className="muted text-sm">Overdue balance</span><strong style={{ color: showBalanceModal.overdue_balance > 0 ? 'var(--danger)' : undefined }}>{fmt(showBalanceModal.overdue_balance)}</strong></div>
          </div>
          <div className="field">
            <label className="label">New remaining balance (R)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={balanceDraft}
              onChange={(e) => setBalanceDraft(e.target.value)}
              autoFocus
            />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => setShowBalanceModal(null)} disabled={!!savingRemainingId}>Cancel</button>
            <button className="btn" onClick={saveBalance} disabled={!!savingRemainingId}>{savingRemainingId ? 'Saving…' : 'Save balance'}</button>
          </div>
        </Modal>
      )}

      {/* Create agreement modal */}
      {showCreate && (
        <Modal title="Add agreement" onClose={() => setShowCreate(false)}>
          <div className="mb-3">
            <FleetHelpTip section="agreements" tooltip="Create agreements only with ready bikes and riders who do not already have an open agreement." label="Open creation guide" compact />
          </div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Bike</label><select value={createForm.bike_id} onChange={(e) => setCreateForm({ ...createForm, bike_id: e.target.value })}><option value="">Select ready bike</option>{readyBikeOptions.map((b) => <option key={b.id} value={b.id}>{b.registration || `Bike #${b.id}`} · {b.make} {b.model}</option>)}</select></div>
            <div className="field"><label className="label">Rider</label><select value={createForm.rider_id} onChange={(e) => setCreateForm({ ...createForm, rider_id: e.target.value })}><option value="">Select rider</option>{riderOptions.map((r) => <option key={r.id} value={r.id}>{r.full_name} · {r.email}</option>)}</select></div>
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

      {/* Reassign modal */}
      {showReassign && (
        <Modal title="Reassign bike" onClose={() => setShowReassign(false)}>
          <div className="mb-3">
            <FleetHelpTip section="agreements" tooltip="Reassign when the rider should continue the same agreement on a different ready bike instead of starting a new contract." label="When to reassign" compact />
          </div>
          <div className="field"><label className="label">Target bike</label><select value={reassignForm.target_bike_id} onChange={(e) => setReassignForm({ ...reassignForm, target_bike_id: e.target.value })}><option value="">Select ready bike</option>{readyBikeOptions.map((b) => <option key={b.id} value={b.id}>{b.registration || `Bike #${b.id}`} · {b.make} {b.model}</option>)}</select></div>
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

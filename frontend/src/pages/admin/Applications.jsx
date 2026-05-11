import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, Pagination, SearchInput, fmt, fmtDate, matchesSearch, paginateItems } from '../../components/ui';

const today = new Date().toISOString().slice(0, 10);
const canReview = (application) => ['submitted', 'under_review'].includes(application.status);

export default function AdminApplications() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const [list, setList] = useState(null);
  const [riders, setRiders] = useState([]);
  const [bikes, setBikes] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showBulkApprove, setShowBulkApprove] = useState(false);
  const [showBulkReject, setShowBulkReject] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkRejectReason, setBulkRejectReason] = useState('');
  const [bulkAssignments, setBulkAssignments] = useState({});
  const [form, setForm] = useState({ user_id: '', preferred_bike_id: '', payout_preference: 'eft' });

  const load = () => api.get('/applications', { params: status ? { status } : {} }).then((response) => setList(response.data.applications));
  useEffect(() => { load(); }, [status]);
  useEffect(() => {
    api.get('/admin/users', { params: { role: 'rider' } }).then((response) => setRiders(response.data.users));
    api.get('/bikes/catalog').then((response) => setBikes(response.data.bikes));
  }, []);
  useEffect(() => { setPage(1); }, [search, status]);
  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => (list || []).some((application) => application.id === id && canReview(application))));
  }, [list]);

  const createApplication = async () => {
    try {
      await api.post('/applications/admin-create', { ...form, user_id: Number(form.user_id), preferred_bike_id: Number(form.preferred_bike_id) });
      toast.success('Application created');
      setShowCreate(false);
      setForm({ user_id: '', preferred_bike_id: '', payout_preference: 'eft' });
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create application');
    }
  };

  const filtered = (list || []).filter((application) => matchesSearch(
    search,
    application.full_name,
    application.email,
    application.phone,
    application.make,
    application.model,
    application.registration,
    application.status,
    application.auto_decision,
    application.average_weekly_earnings,
    application.id
  ));

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);
  const pagedApplications = pagination.items;
  const selectedApplications = filtered.filter((application) => selectedIds.includes(application.id));
  const selectedOnPage = pagedApplications.filter((application) => selectedIds.includes(application.id)).length;
  const allReviewableOnPage = pagedApplications.filter(canReview);

  const toggleSelected = (applicationId) => {
    setSelectedIds((current) => current.includes(applicationId)
      ? current.filter((id) => id !== applicationId)
      : [...current, applicationId]);
  };

  const toggleSelectAllOnPage = () => {
    const reviewableIds = allReviewableOnPage.map((application) => application.id);
    if (!reviewableIds.length) return;
    setSelectedIds((current) => {
      const everySelected = reviewableIds.every((id) => current.includes(id));
      return everySelected ? current.filter((id) => !reviewableIds.includes(id)) : [...new Set([...current, ...reviewableIds])];
    });
  };

  const openBulkApprove = () => {
    if (!selectedApplications.length) return;
    const defaults = {};
    selectedApplications.forEach((application) => {
      const preferredBike = bikes.find((bike) => bike.id === Number(application.preferred_bike_id));
      defaults[application.id] = {
        bike_id: preferredBike ? String(preferredBike.id) : '',
        weekly_amount: preferredBike?.rental_weekly || '',
        total_weeks: preferredBike?.total_weeks || 78,
        start_date: today
      };
    });
    setBulkAssignments(defaults);
    setShowBulkApprove(true);
  };

  const bulkApprove = async () => {
    const approvals = selectedApplications.map((application) => ({
      application_id: application.id,
      ...bulkAssignments[application.id]
    }));
    const invalid = approvals.find((item) => !item.bike_id || !item.weekly_amount || !item.start_date);
    if (invalid) return toast.error('Choose a bike, weekly amount, and start date for every selected application');

    try {
      const { data } = await api.post('/applications/bulk-review', { action: 'approve', approvals });
      if (data.failed) toast.success(`Approved ${data.processed} applications. ${data.failed} need attention.`);
      else toast.success(`Approved ${data.processed} applications`);
      setSelectedIds([]);
      setShowBulkApprove(false);
      setBulkAssignments({});
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not bulk approve applications');
    }
  };

  const bulkReject = async () => {
    if (!selectedIds.length) return;
    try {
      const { data } = await api.post('/applications/bulk-review', { action: 'reject', application_ids: selectedIds, reason: bulkRejectReason });
      if (data.failed) toast.success(`Declined ${data.processed} applications. ${data.failed} need attention.`);
      else toast.success(`Declined ${data.processed} applications`);
      setSelectedIds([]);
      setShowBulkReject(false);
      setBulkRejectReason('');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not bulk decline applications');
    }
  };

  const bikeTakenByAnotherSelection = (applicationId, bikeId) => Object.entries(bulkAssignments)
    .some(([id, value]) => Number(id) !== applicationId && String(value?.bike_id || '') === String(bikeId));

  if (!list) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Applications</h1>
          <p className="page-sub">Review rider applications, payslips, selfies, and pre-approval decisions.</p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" disabled={!selectedIds.length} onClick={openBulkApprove}>Bulk approve</button>
          <button className="btn btn-secondary" disabled={!selectedIds.length} onClick={() => setShowBulkReject(true)}>Bulk decline</button>
          <button className="btn" onClick={() => setShowCreate(true)}>+ Add application</button>
        </div>
      </div>
      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search rider, phone, bike, registration, status" style={{ flex: '1 1 320px', maxWidth: 420 }} />
        <div className="muted text-sm">{selectedIds.length} selected · {filtered.length} matching applications</div>
      </div>
      <div className="row mb-4" style={{ flexWrap: 'wrap' }}>
        {['', 'submitted', 'under_review', 'approved', 'rejected'].map((value) => (
          <button key={value} onClick={() => setParams(value ? { status: value } : {})} className={`btn btn-sm ${status === value ? '' : 'btn-secondary'}`}>{value || 'All'}</button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 44 }}>
                <input
                  type="checkbox"
                  checked={allReviewableOnPage.length > 0 && selectedOnPage === allReviewableOnPage.length}
                  onChange={toggleSelectAllOnPage}
                  title="Select page"
                />
              </th>
              <th>Submitted</th>
              <th>Rider</th>
              <th>Bike</th>
              <th>Avg weekly</th>
              <th>Docs</th>
              <th>Decision</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pagedApplications.map((application) => (
              <tr key={application.id}>
                <td>
                  {canReview(application) ? (
                    <input type="checkbox" checked={selectedIds.includes(application.id)} onChange={() => toggleSelected(application.id)} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{fmtDate(application.submitted_at)}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="avatar" style={{ backgroundImage: application.avatar_url ? `url(${application.avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }}>{application.avatar_url ? '' : application.full_name?.[0]}</div>
                    <div>
                      <strong>{application.full_name}</strong>
                      <div className="text-xs muted">{application.email}</div>
                      <div className="text-xs muted">{application.phone || 'No phone'}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div>{application.make ? `${application.make} ${application.model}` : '—'}</div>
                  <div className="text-xs muted">{application.registration || 'No registration yet'}</div>
                </td>
                <td>{application.average_weekly_earnings ? fmt(application.average_weekly_earnings) : 'Pending payslips'}</td>
                <td>{application.document_count || 0} files</td>
                <td>{application.auto_decision ? <Badge status={application.auto_decision === 'auto_declined' ? 'rejected' : 'approved'}>{application.auto_decision.replace(/_/g, ' ')}</Badge> : '—'}</td>
                <td><Badge status={application.status} /></td>
                <td><Link to={`/admin/applications/${application.id}`} className="btn btn-sm btn-secondary">Review</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pagedApplications.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{search ? 'No applications match your search.' : 'No applications.'}</div>}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="applications" />

      {showCreate && (
        <Modal title="Add application" onClose={() => setShowCreate(false)}>
          <div className="field"><label className="label">Rider</label>
            <select value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })}>
              <option value="">— Select rider —</option>
              {riders.map((rider) => <option key={rider.id} value={rider.id}>{rider.full_name} · {rider.email}</option>)}
            </select></div>
          <div className="field"><label className="label">Preferred bike</label>
            <select value={form.preferred_bike_id} onChange={(e) => setForm({ ...form, preferred_bike_id: e.target.value })}>
              <option value="">— Select bike —</option>
              {bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {fmt(bike.rental_weekly)}/week</option>)}
            </select></div>
          <div className="field"><label className="label">Payout preference</label>
            <select value={form.payout_preference} onChange={(e) => setForm({ ...form, payout_preference: e.target.value })}>
              <option value="eft">EFT</option>
              <option value="ewallet">E-wallet</option>
            </select></div>
          <div className="row">
            <button className="btn" onClick={createApplication}>Create</button>
            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {showBulkApprove && (
        <Modal title={`Bulk approve ${selectedApplications.length} applications`} onClose={() => setShowBulkApprove(false)}>
          <div className="muted text-sm mb-3">Assign one ready to go bike to each selected rider. A bike can only be chosen once in this batch.</div>
          <div style={{ display: 'grid', gap: 16, maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
            {selectedApplications.map((application) => {
              const assignment = bulkAssignments[application.id] || { bike_id: '', weekly_amount: '', total_weeks: 78, start_date: today };
              return (
                <div key={application.id} className="card" style={{ background: 'var(--surface-2)' }}>
                  <div className="row mb-3" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div>
                      <strong>{application.full_name}</strong>
                      <div className="text-xs muted">Application #{application.id} · {application.email}</div>
                    </div>
                    <Badge status={application.status} />
                  </div>
                  <div className="grid grid-2">
                    <div className="field"><label className="label">Bike</label>
                      <select value={assignment.bike_id} onChange={(e) => {
                        const bike = bikes.find((item) => item.id === Number(e.target.value));
                        setBulkAssignments((current) => ({
                          ...current,
                          [application.id]: {
                            ...current[application.id],
                            bike_id: e.target.value,
                            weekly_amount: bike?.rental_weekly || '',
                            total_weeks: bike?.total_weeks || 78,
                            start_date: current[application.id]?.start_date || today
                          }
                        }));
                      }}>
                        <option value="">— Select ready to go bike —</option>
                        {bikes.map((bike) => <option key={bike.id} value={bike.id} disabled={bikeTakenByAnotherSelection(application.id, bike.id)}>{bike.make} {bike.model} · {fmt(bike.rental_weekly)}/week</option>)}
                      </select>
                    </div>
                    <div className="field"><label className="label">Start date</label><input type="date" value={assignment.start_date} onChange={(e) => setBulkAssignments((current) => ({ ...current, [application.id]: { ...current[application.id], start_date: e.target.value } }))} /></div>
                    <div className="field"><label className="label">Weekly amount</label><input type="number" value={assignment.weekly_amount} onChange={(e) => setBulkAssignments((current) => ({ ...current, [application.id]: { ...current[application.id], weekly_amount: e.target.value } }))} /></div>
                    <div className="field"><label className="label">Total weeks</label><input type="number" value={assignment.total_weeks} onChange={(e) => setBulkAssignments((current) => ({ ...current, [application.id]: { ...current[application.id], total_weeks: Number(e.target.value) } }))} /></div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="row mt-3"><button className="btn btn-success" onClick={bulkApprove}>Approve selected</button><button className="btn btn-secondary" onClick={() => setShowBulkApprove(false)}>Cancel</button></div>
        </Modal>
      )}

      {showBulkReject && (
        <Modal title={`Bulk decline ${selectedIds.length} applications`} onClose={() => setShowBulkReject(false)}>
          <div className="field"><label className="label">Reason sent to riders</label><textarea rows={4} value={bulkRejectReason} onChange={(e) => setBulkRejectReason(e.target.value)} /></div>
          <div className="row"><button className="btn btn-danger" onClick={bulkReject}>Decline selected</button><button className="btn btn-secondary" onClick={() => setShowBulkReject(false)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

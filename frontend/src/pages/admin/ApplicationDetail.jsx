import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, Pagination, fmt, fmtDate, fmtDateTime, paginateItems, CopyableContactValue } from '../../components/ui';

const DOC_TYPE_OPTIONS = [
  { value: 'id_document', label: 'ID document' },
  { value: 'drivers_license', label: "Driver's licence" },
  { value: 'payslip', label: 'Payslip' },
  { value: 'other', label: 'Other / selfie' }
];

const PLATFORM_OPTIONS = ['Uber Eats', 'Mr D', 'Bolt Food', 'Takealot', 'Checkers Sixty60', 'Other'];

export default function AdminApplicationDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [bikes, setBikes] = useState([]);
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [docPage, setDocPage] = useState(1);
  const [docPageSize, setDocPageSize] = useState(10);
  const [approveForm, setApproveForm] = useState({ bike_id: '', weekly_amount: '', total_weeks: 78, start_date: new Date().toISOString().slice(0, 10) });
  const [rejectReason, setRejectReason] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [savingDocId, setSavingDocId] = useState(null);
  const [docAmountEdits, setDocAmountEdits] = useState({});
  const [editForm, setEditForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    id_number: '',
    address: '',
    city: '',
    province: '',
    preferred_bike_id: '',
    delivery_platforms: [],
    has_riding_experience: true,
    years_riding: '',
    has_drivers_license: true,
    payout_preference: 'eft',
    bank_name: '',
    account_holder: '',
    account_number: '',
    branch_code: '',
    ewallet_number: ''
  });
  const [uploadForm, setUploadForm] = useState({ doc_type: 'payslip', file: null });

  const load = async () => {
    const [applicationResponse, bikesResponse] = await Promise.all([
      api.get(`/applications/${id}`),
      api.get('/bikes')
    ]);
    setData(applicationResponse.data);
    setBikes(bikesResponse.data.bikes || []);
  };

  useEffect(() => {
    load().catch(() => toast.error('Could not load application detail'));
  }, [id]);

  useEffect(() => { setDocPage(1); }, [data?.documents?.length]);

  useEffect(() => {
    if (!data?.application) return;
    const application = data.application;
    setEditForm({
      full_name: application.full_name || '',
      email: application.email || '',
      phone: application.phone || '',
      id_number: application.id_number || '',
      address: application.address || '',
      city: application.city || '',
      province: application.province || '',
      preferred_bike_id: application.preferred_bike_id || '',
      delivery_platforms: String(application.delivery_platforms || '').split(',').map((item) => item.trim()).filter(Boolean),
      has_riding_experience: !!application.has_riding_experience,
      years_riding: application.years_riding ?? '',
      has_drivers_license: !!application.has_drivers_license,
      payout_preference: application.payout_preference || 'eft',
      bank_name: application.bank_name || '',
      account_holder: application.account_holder || '',
      account_number: application.account_number || '',
      branch_code: application.branch_code || '',
      ewallet_number: application.ewallet_number || ''
    });
  }, [data?.application]);

  useEffect(() => {
    const next = {};
    for (const doc of (data?.documents || [])) next[doc.id] = doc.extracted_amount ?? '';
    setDocAmountEdits(next);
  }, [data?.documents]);

  if (!data) return <Loading />;
  const application = data.application;
  const documents = data.documents || [];
  const payslips = documents.filter((doc) => doc.doc_type === 'payslip');
  const docPagination = paginateItems(documents, docPage, docPageSize);
  const riderSelfie = application.avatar_url;

  const approve = async () => {
    if (!approveForm.bike_id || !approveForm.weekly_amount) return toast.error('Bike and weekly amount are required');
    try {
      const response = await api.post(`/applications/${id}/approve`, approveForm);
      toast.success(`Agreement ${response.data.agreement_no} created`);
      nav(`/admin/agreements/${response.data.agreement_id}`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not approve application');
    }
  };

  const reject = async () => {
    try {
      await api.post(`/applications/${id}/reject`, { reason: rejectReason });
      toast.success('Application rejected');
      setShowReject(false);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reject application');
    }
  };

  const saveEdits = async () => {
    setSavingEdit(true);
    try {
      await api.patch(`/applications/${id}/admin-update`, {
        ...editForm,
        preferred_bike_id: editForm.preferred_bike_id ? Number(editForm.preferred_bike_id) : null,
        years_riding: editForm.years_riding === '' ? null : Number(editForm.years_riding)
      });
      toast.success('Application details updated');
      setShowEdit(false);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update application details');
    } finally {
      setSavingEdit(false);
    }
  };

  const uploadDocument = async () => {
    if (!uploadForm.file) return toast.error('Choose a file first');
    const fd = new FormData();
    fd.append('doc_type', uploadForm.doc_type);
    fd.append('file', uploadForm.file);
    setUploadingDoc(true);
    try {
      await api.post(`/applications/${id}/documents`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Document uploaded');
      setUploadForm({ doc_type: uploadForm.doc_type, file: null });
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not upload document');
    } finally {
      setUploadingDoc(false);
    }
  };

  const saveDocumentAmount = async (doc) => {
    setSavingDocId(doc.id);
    try {
      await api.patch(`/applications/${id}/documents/${doc.id}`, { extracted_amount: docAmountEdits[doc.id] === '' ? null : Number(docAmountEdits[doc.id]) });
      toast.success('Payslip amount updated');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update payslip amount');
    } finally {
      setSavingDocId(null);
    }
  };

  const togglePlatform = (platform) => setEditForm((current) => ({
    ...current,
    delivery_platforms: current.delivery_platforms.includes(platform)
      ? current.delivery_platforms.filter((item) => item !== platform)
      : [...current.delivery_platforms, platform]
  }));

  const uploadAccept = useMemo(() => uploadForm.doc_type === 'payslip'
    ? 'application/pdf'
    : 'application/pdf,image/jpeg,image/jpg,image/png,image/webp', [uploadForm.doc_type]);

  return (
    <>
      <Link to="/admin/applications" className="muted text-sm">← Back</Link>
      <div className="flex-between mt-2 mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Application #{application.id}</h1>
          <div className="muted">Submitted {fmtDate(application.submitted_at)}</div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Badge status={application.status}>{application.auto_decision === 'pre_approved' ? 'pre-approved' : application.status}</Badge>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowEdit(true)}>Edit application info</button>
        </div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Payslips" value={`${payslips.length} / 3`} />
        <Stat label="Total paid" value={application.total_paid_last_3 ? fmt(application.total_paid_last_3) : 'Pending'} />
        <Stat label="Avg weekly earnings" value={application.average_weekly_earnings ? fmt(application.average_weekly_earnings) : 'Pending'} />
        <Stat label="Payout" value={application.payout_preference || '—'} />
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <div className="row mb-3" style={{ alignItems: 'center', gap: 16 }}>
            <div className="avatar" style={{ width: 88, height: 88, backgroundImage: riderSelfie ? `url(${riderSelfie})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center', fontSize: 28 }}>{riderSelfie ? '' : application.full_name?.[0]}</div>
            <div>
              <h3 style={{ marginBottom: 4 }}>Rider details</h3>
              <div className="muted text-sm">Admin can edit contact details and application information from this page.</div>
            </div>
          </div>
          <Row k="Name" v={application.full_name} />
          <Row k="Email" v={application.email} />
          <Row k="Phone" v={<CopyableContactValue value={application.phone} />} />
          <Row k="ID number / Passport / Asylum" v={application.id_number} />
          <Row k="Address" v={[application.address, application.city, application.province].filter(Boolean).join(', ')} />
        </div>
        <div className="card">
          <h3 className="mb-3">Bike preference</h3>
          {application.image_url ? (
            <div style={{ height: 220, borderRadius: 12, background: '#0a1219 center/cover no-repeat', backgroundImage: `url("${application.image_url}")`, marginBottom: 16 }} />
          ) : null}
          <Row k="Preferred bike" v={application.make ? `${application.make} ${application.model}` : '—'} />
          <Row k="Registration" v={application.registration || '—'} />
          <Row k="Delivery platforms" v={application.delivery_platforms || '—'} />
          <Row k="Riding experience" v={application.has_riding_experience ? `${application.years_riding || 0} years` : 'None'} />
          <Row k="Driver's licence" v={application.has_drivers_license ? 'Yes' : 'No'} />
          <Row k="Auto decision" v={application.auto_decision ? application.auto_decision.replace(/_/g, ' ') : 'Pending'} />
          <Row k="Retry after" v={application.retry_after_date ? fmtDate(application.retry_after_date) : '—'} />
        </div>
      </div>

      <div className="card mt-4">
        <h3 className="mb-3">Payout details</h3>
        {application.payout_preference === 'ewallet' ? (
          <Row k="E-wallet number" v={<CopyableContactValue value={application.ewallet_number} />} />
        ) : (
          <>
            <Row k="Bank" v={application.bank_name || '—'} />
            <Row k="Account holder" v={application.account_holder || '—'} />
            <Row k="Account number" v={application.account_number || '—'} />
            <Row k="Branch code" v={application.branch_code || '—'} />
          </>
        )}
      </div>

      <div className="card mt-4">
        <div className="card-title"><h3>Admin document tools</h3><Badge status="info">Upload and edit</Badge></div>
        <div className="grid grid-3" style={{ alignItems: 'end' }}>
          <div className="field">
            <label className="label">Document type</label>
            <select value={uploadForm.doc_type} onChange={(e) => setUploadForm((current) => ({ ...current, doc_type: e.target.value, file: null }))}>
              {DOC_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label">File</label>
            <input type="file" accept={uploadAccept} onChange={(e) => setUploadForm((current) => ({ ...current, file: e.target.files?.[0] || null }))} />
            <div className="muted text-xs mt-1">Payslips remain PDF-only. Other documents support PDF, JPG, JPEG, PNG, and WEBP.</div>
          </div>
          <div>
            <button className="btn" onClick={uploadDocument} disabled={uploadingDoc || !uploadForm.file}>{uploadingDoc ? 'Uploading…' : 'Upload document'}</button>
          </div>
        </div>
      </div>

      <div className="card mt-4">
        <div className="flex-between mb-3" style={{ gap: 12, flexWrap: 'wrap' }}>
          <h3>Application documents</h3>
          {data.agreement?.contract_file_path && <a className="btn btn-sm btn-secondary" href={data.agreement.contract_file_path} target="_blank" rel="noreferrer">View contract</a>}
        </div>
        <table className="table">
          <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Extracted amount</th><th></th></tr></thead>
          <tbody>
            {docPagination.items.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.doc_type.replace(/_/g, ' ')}</td>
                <td>
                  {doc.original_name}
                  <div className="text-xs muted">{doc.mime_type || '—'}</div>
                </td>
                <td>{fmtDateTime(doc.uploaded_at)}</td>
                <td>
                  {doc.doc_type === 'payslip' ? (
                    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={docAmountEdits[doc.id] ?? ''}
                        onChange={(e) => setDocAmountEdits((current) => ({ ...current, [doc.id]: e.target.value }))}
                        style={{ maxWidth: 140 }}
                      />
                      <button className="btn btn-sm btn-secondary" onClick={() => saveDocumentAmount(doc)} disabled={savingDocId === doc.id}>
                        {savingDocId === doc.id ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  ) : (doc.extracted_amount ? fmt(doc.extracted_amount) : '—')}
                </td>
                <td><a href={doc.file_path} className="btn btn-sm btn-secondary" target="_blank" rel="noreferrer">Open</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!docPagination.items.length && <div className="muted text-sm">No documents uploaded yet.</div>}
        <Pagination page={docPagination.currentPage} pageSize={docPagination.pageSize} totalItems={docPagination.totalItems} onPageChange={setDocPage} onPageSizeChange={setDocPageSize} label="documents" />
        {data.agreement?.signed_contract_path && <div className="mt-3"><a href={data.agreement.signed_contract_path} target="_blank" rel="noreferrer">Signed contract</a></div>}
      </div>

      {['submitted', 'under_review'].includes(application.status) && (
        <div className="row mt-4">
          <button className="btn btn-success" onClick={() => setShowApprove(true)}>Approve & allocate bike</button>
          <button className="btn btn-danger" onClick={() => setShowReject(true)}>Reject</button>
        </div>
      )}

      {showEdit && (
        <Modal title="Edit application details" onClose={() => setShowEdit(false)}>
          <div className="grid grid-2">
            <div className="field"><label className="label">Full name</label><input value={editForm.full_name} onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })} /></div>
            <div className="field"><label className="label">Email</label><input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} /></div>
            <div className="field"><label className="label">Phone</label><input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} /></div>
            <div className="field"><label className="label">ID number / Passport / Asylum</label><input value={editForm.id_number} onChange={(e) => setEditForm({ ...editForm, id_number: e.target.value })} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Address</label><input value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} /></div>
            <div className="field"><label className="label">City</label><input value={editForm.city} onChange={(e) => setEditForm({ ...editForm, city: e.target.value })} /></div>
            <div className="field"><label className="label">Province</label><input value={editForm.province} onChange={(e) => setEditForm({ ...editForm, province: e.target.value })} /></div>
            <div className="field"><label className="label">Preferred bike</label><select value={editForm.preferred_bike_id} onChange={(e) => setEditForm({ ...editForm, preferred_bike_id: e.target.value })}><option value="">— No bike selected —</option>{bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.registration || 'no reg'}</option>)}</select></div>
            <div className="field"><label className="label">Payout preference</label><select value={editForm.payout_preference} onChange={(e) => setEditForm({ ...editForm, payout_preference: e.target.value })}><option value="eft">EFT</option><option value="ewallet">E-wallet</option></select></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="label">Delivery platforms</label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {PLATFORM_OPTIONS.map((platform) => (
                  <label key={platform} className="row" style={{ background: editForm.delivery_platforms.includes(platform) ? 'var(--primary)' : 'var(--surface-2)', padding: '8px 14px', borderRadius: 100, cursor: 'pointer', userSelect: 'none', color: editForm.delivery_platforms.includes(platform) ? 'white' : 'var(--text)' }}>
                    <input type="checkbox" checked={editForm.delivery_platforms.includes(platform)} onChange={() => togglePlatform(platform)} style={{ display: 'none' }} />
                    {platform}
                  </label>
                ))}
              </div>
            </div>
            <div className="field"><label className="label">Has riding experience</label><select value={editForm.has_riding_experience ? '1' : '0'} onChange={(e) => setEditForm({ ...editForm, has_riding_experience: e.target.value === '1' })}><option value="1">Yes</option><option value="0">No</option></select></div>
            <div className="field"><label className="label">Years riding</label><input type="number" min="0" value={editForm.years_riding} onChange={(e) => setEditForm({ ...editForm, years_riding: e.target.value })} /></div>
            <div className="field"><label className="label">Driver's licence</label><select value={editForm.has_drivers_license ? '1' : '0'} onChange={(e) => setEditForm({ ...editForm, has_drivers_license: e.target.value === '1' })}><option value="1">Yes</option><option value="0">No</option></select></div>
          </div>

          {editForm.payout_preference === 'ewallet' ? (
            <div className="field"><label className="label">E-wallet number</label><input value={editForm.ewallet_number} onChange={(e) => setEditForm({ ...editForm, ewallet_number: e.target.value })} /></div>
          ) : (
            <div className="grid grid-2">
              <div className="field"><label className="label">Bank</label><input value={editForm.bank_name} onChange={(e) => setEditForm({ ...editForm, bank_name: e.target.value })} /></div>
              <div className="field"><label className="label">Account holder</label><input value={editForm.account_holder} onChange={(e) => setEditForm({ ...editForm, account_holder: e.target.value })} /></div>
              <div className="field"><label className="label">Account number</label><input value={editForm.account_number} onChange={(e) => setEditForm({ ...editForm, account_number: e.target.value })} /></div>
              <div className="field"><label className="label">Branch code</label><input value={editForm.branch_code} onChange={(e) => setEditForm({ ...editForm, branch_code: e.target.value })} /></div>
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setShowEdit(false)}>Cancel</button>
            <button className="btn" onClick={saveEdits} disabled={savingEdit}>{savingEdit ? 'Saving…' : 'Save changes'}</button>
          </div>
        </Modal>
      )}

      {showApprove && (
        <Modal title="Approve & allocate bike" onClose={() => setShowApprove(false)}>
          <div className="field"><label className="label">Bike</label>
            <select value={approveForm.bike_id} onChange={(e) => {
              const bike = bikes.find((item) => item.id === Number(e.target.value));
              setApproveForm({ ...approveForm, bike_id: e.target.value, weekly_amount: bike?.rental_weekly || '', total_weeks: bike?.total_weeks || 78 });
            }}>
              <option value="">— Select ready to go bike —</option>
              {bikes.filter((bike) => bike.status === 'ready_to_go').map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.registration || 'no reg'} · {fmt(bike.rental_weekly)}/week</option>)}
            </select></div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Weekly amount</label><input type="number" value={approveForm.weekly_amount} onChange={(e) => setApproveForm({ ...approveForm, weekly_amount: e.target.value })} /></div>
            <div className="field"><label className="label">Total weeks</label><input type="number" value={approveForm.total_weeks} onChange={(e) => setApproveForm({ ...approveForm, total_weeks: Number(e.target.value) })} /></div>
          </div>
          <div className="field"><label className="label">Start date</label><input type="date" value={approveForm.start_date} onChange={(e) => setApproveForm({ ...approveForm, start_date: e.target.value })} /></div>
          <div className="card mb-3" style={{ background: 'var(--surface-2)' }}><strong>Total contract value: {fmt((approveForm.weekly_amount || 0) * (approveForm.total_weeks || 0))}</strong></div>
          <div className="row"><button className="btn btn-success" onClick={approve}>Confirm approval</button><button className="btn btn-secondary" onClick={() => setShowApprove(false)}>Cancel</button></div>
        </Modal>
      )}

      {showReject && (
        <Modal title="Reject application" onClose={() => setShowReject(false)}>
          <div className="field"><label className="label">Reason</label><textarea rows={4} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} /></div>
          <div className="row"><button className="btn btn-danger" onClick={reject}>Confirm rejection</button><button className="btn btn-secondary" onClick={() => setShowReject(false)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

function Row({ k, v }) {
  return <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><span className="muted text-sm">{k}</span><span style={{ textAlign: 'right' }}>{v || '—'}</span></div>;
}

function Stat({ label, value }) {
  return <div className="stat"><div className="stat-label">{label}</div><div className="stat-value" style={{ fontSize: 22 }}>{value}</div></div>;
}

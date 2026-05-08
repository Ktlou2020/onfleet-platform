import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, SearchInput, Pagination, fmt, fmtDate, matchesSearch, paginateItems } from '../../components/ui';

const PLATFORMS = ['Uber Eats', 'Mr D', 'Bolt Food', 'Takealot', 'Checkers Sixty60', 'Other'];

export default function RiderApplication() {
  const [apps, setApps] = useState(null);
  const [bikes, setBikes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [docSearch, setDocSearch] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(6);
  const [docPage, setDocPage] = useState(1);
  const [docPageSize, setDocPageSize] = useState(8);
  const [form, setForm] = useState({
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

  const load = () => Promise.all([api.get('/applications/mine'), api.get('/bikes/catalog')])
    .then(([applicationsResponse, bikesResponse]) => {
      setApps(applicationsResponse.data.applications);
      setBikes(bikesResponse.data.bikes);
    });

  useEffect(() => { load(); }, []);

  const latest = useMemo(() => (apps && apps.length ? apps[0] : null), [apps]);
  const payslips = latest?.documents?.filter((doc) => doc.doc_type === 'payslip') || [];
  const canCreate = !latest || (latest.status === 'rejected' && (!latest.retry_after_date || latest.retry_after_date <= new Date().toISOString().slice(0, 10)));

  const filteredHistory = useMemo(() => (apps || []).filter((application) => matchesSearch(
    historySearch,
    application.id,
    application.make,
    application.model,
    application.registration,
    application.status,
    application.auto_decision,
    application.average_weekly_earnings,
    application.submitted_at
  )), [apps, historySearch]);

  const filteredDocs = useMemo(() => (latest?.documents || []).filter((doc) => matchesSearch(
    docSearch,
    doc.doc_type,
    doc.original_name,
    doc.uploaded_at,
    doc.extracted_amount
  )), [latest, docSearch]);

  useEffect(() => { setHistoryPage(1); }, [historySearch]);
  useEffect(() => { setDocPage(1); }, [docSearch, latest?.id]);

  const historyPagination = useMemo(() => paginateItems(filteredHistory, historyPage, historyPageSize), [filteredHistory, historyPage, historyPageSize]);
  const docPagination = useMemo(() => paginateItems(filteredDocs, docPage, docPageSize), [filteredDocs, docPage, docPageSize]);

  const togglePlatform = (platform) => setForm((current) => ({
    ...current,
    delivery_platforms: current.delivery_platforms.includes(platform)
      ? current.delivery_platforms.filter((item) => item !== platform)
      : [...current.delivery_platforms, platform]
  }));

  const submit = async (event) => {
    event.preventDefault();
    if (!form.preferred_bike_id) return toast.error('Please choose a bike');
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        preferred_bike_id: Number(form.preferred_bike_id),
        years_riding: form.years_riding ? Number(form.years_riding) : null
      };
      await api.post('/applications', payload);
      toast.success('Application created. Now upload your ID, licence, and 3 payslips.');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create application');
    } finally {
      setSubmitting(false);
    }
  };

  const uploadDocument = async (docType, file) => {
    if (!latest) return;
    const fd = new FormData();
    fd.append('doc_type', docType);
    fd.append('file', file);
    setUploading(docType);
    try {
      const { data } = await api.post(`/applications/${latest.id}/documents`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      if (data?.extracted_amount) toast.success(`Uploaded. Extracted total paid ${fmt(data.extracted_amount)}`);
      else toast.success('Uploaded successfully');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Upload failed');
    } finally {
      setUploading('');
    }
  };

  if (!apps) return <Loading />;

  return (
    <>
      <h1 className="page-title">Application</h1>
      <p className="page-sub">Submit your rider application, upload compliance documents, and track your pre-approval.</p>

      <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>Document rules</strong>
            <div className="muted text-sm mt-1">Accepted file types: PDF, JPG, JPEG, PNG. No proof of address required. Upload 3 latest payslips so OnFleet can calculate average weekly earnings.</div>
          </div>
          <div className="badge badge-info">Minimum R1000/week</div>
        </div>
      </div>

      {apps.length > 0 && (
        <div className="card mb-4">
          <div className="flex-between mb-3" style={{ gap: 12, flexWrap: 'wrap' }}>
            <h3 style={{ marginBottom: 0 }}>Application history</h3>
            <SearchInput value={historySearch} onChange={setHistorySearch} placeholder="Search bike, registration, status, application ID" style={{ width: 320 }} />
          </div>
          <table className="table">
            <thead><tr><th>Submitted</th><th>Bike</th><th>Status</th><th>Avg weekly</th><th>Docs</th></tr></thead>
            <tbody>
              {historyPagination.items.map((application) => (
                <tr key={application.id}>
                  <td>{fmtDate(application.submitted_at)}</td>
                  <td>{application.make ? `${application.make} ${application.model}` : '—'}<div className="text-xs muted">{application.registration || 'No registration yet'}</div></td>
                  <td>
                    <Badge status={application.status}>{application.auto_decision === 'pre_approved' ? 'pre-approved' : application.status}</Badge>
                  </td>
                  <td>{application.average_weekly_earnings ? fmt(application.average_weekly_earnings) : 'Awaiting payslips'}</td>
                  <td>{application.document_count || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!historyPagination.items.length && <div className="muted text-sm" style={{ paddingTop: 16 }}>{historySearch ? 'No applications match your search.' : 'No application history yet.'}</div>}
          <Pagination page={historyPagination.currentPage} pageSize={historyPagination.pageSize} totalItems={historyPagination.totalItems} onPageChange={setHistoryPage} onPageSizeChange={setHistoryPageSize} label="applications" />
        </div>
      )}

      {canCreate && (
        <form className="card mb-4" onSubmit={submit}>
          <h3 className="mb-3">New application</h3>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">Preferred bike</label>
              <select value={form.preferred_bike_id} onChange={(e) => setForm({ ...form, preferred_bike_id: e.target.value })} required>
                <option value="">— Select a bike —</option>
                {bikes.map((bike) => (
                  <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.engine_cc}cc · {fmt(bike.rental_weekly)}/week</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label">Payout preference</label>
              <select value={form.payout_preference} onChange={(e) => setForm({ ...form, payout_preference: e.target.value })}>
                <option value="eft">EFT banking details</option>
                <option value="ewallet">E-wallet number</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label className="label">Delivery platforms</label>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {PLATFORMS.map((platform) => (
                <label key={platform} className="row" style={{ background: form.delivery_platforms.includes(platform) ? 'var(--primary)' : 'var(--surface-2)', padding: '8px 14px', borderRadius: 100, cursor: 'pointer', userSelect: 'none', color: form.delivery_platforms.includes(platform) ? 'white' : 'var(--text)' }}>
                  <input type="checkbox" checked={form.delivery_platforms.includes(platform)} onChange={() => togglePlatform(platform)} style={{ display: 'none' }} />
                  {platform}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-2">
            <div className="field">
              <label className="label">Years of riding experience</label>
              <input type="number" min="0" value={form.years_riding} onChange={(e) => setForm({ ...form, years_riding: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">Valid driver's licence</label>
              <select value={form.has_drivers_license ? '1' : '0'} onChange={(e) => setForm({ ...form, has_drivers_license: e.target.value === '1' })}>
                <option value="1">Yes</option>
                <option value="0">No</option>
              </select>
            </div>
          </div>

          {form.payout_preference === 'eft' ? (
            <div className="grid grid-2">
              <div className="field"><label className="label">Bank name</label><input value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} /></div>
              <div className="field"><label className="label">Account holder</label><input value={form.account_holder} onChange={(e) => setForm({ ...form, account_holder: e.target.value })} /></div>
              <div className="field"><label className="label">Account number</label><input value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} /></div>
              <div className="field"><label className="label">Branch code</label><input value={form.branch_code} onChange={(e) => setForm({ ...form, branch_code: e.target.value })} /></div>
            </div>
          ) : (
            <div className="field"><label className="label">E-wallet number</label><input value={form.ewallet_number} onChange={(e) => setForm({ ...form, ewallet_number: e.target.value })} placeholder="Cellphone number for wallet payouts" /></div>
          )}

          <button className="btn" disabled={submitting}>{submitting ? 'Submitting…' : 'Create application'}</button>
        </form>
      )}

      {latest && (
        <>
          <div className="grid grid-4 mb-4">
            <SummaryCard label="Application status" value={latest.auto_decision === 'pre_approved' ? 'Pre-approved' : latest.status} />
            <SummaryCard label="Payslips uploaded" value={`${payslips.length} / 3`} />
            <SummaryCard label="Total paid" value={latest.total_paid_last_3 ? fmt(latest.total_paid_last_3) : 'Pending extraction'} />
            <SummaryCard label="Average weekly earnings" value={latest.average_weekly_earnings ? fmt(latest.average_weekly_earnings) : 'Pending extraction'} />
          </div>

          {latest.status === 'rejected' && latest.retry_after_date && (
            <div className="card mb-4" style={{ borderColor: 'rgba(220,53,69,.4)' }}>
              <strong>Retry window</strong>
              <div className="muted text-sm mt-1">This application was auto-declined. You can submit a fresh application after {fmtDate(latest.retry_after_date)}.</div>
            </div>
          )}

          <div className="card mb-4">
            <h3 className="mb-3">Upload application documents</h3>
            <div className="grid grid-2">
              <UploadCard title="ID document" sub="South African ID / passport" onPick={(file) => uploadDocument('id_document', file)} busy={uploading === 'id_document'} />
              <UploadCard title="Driver's licence" sub="Front / single PDF" onPick={(file) => uploadDocument('drivers_license', file)} busy={uploading === 'drivers_license'} />
              {[1, 2, 3].map((slot) => (
                <UploadCard key={slot} title={`Payslip ${slot}`} sub="Latest payslip, PDF or image" onPick={(file) => uploadDocument('payslip', file)} busy={uploading === 'payslip'} />
              ))}
            </div>
          </div>

          <div className="card">
            <div className="flex-between mb-3" style={{ gap: 12, flexWrap: 'wrap' }}>
              <h3 style={{ marginBottom: 0 }}>Uploaded documents</h3>
              <SearchInput value={docSearch} onChange={setDocSearch} placeholder="Search document type or filename" style={{ width: 320 }} />
            </div>
            <table className="table">
              <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Extracted amount</th><th></th></tr></thead>
              <tbody>
                {docPagination.items.map((doc) => (
                  <tr key={doc.id}>
                    <td>{doc.doc_type.replace(/_/g, ' ')}</td>
                    <td>{doc.original_name}</td>
                    <td>{fmtDate(doc.uploaded_at)}</td>
                    <td>{doc.extracted_amount ? fmt(doc.extracted_amount) : '—'}</td>
                    <td><a className="btn btn-sm btn-secondary" href={doc.file_path} target="_blank" rel="noreferrer">View</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!docPagination.items.length && <div className="muted text-sm">{docSearch ? 'No documents match your search.' : 'No documents uploaded yet.'}</div>}
            <Pagination page={docPagination.currentPage} pageSize={docPagination.pageSize} totalItems={docPagination.totalItems} onPageChange={setDocPage} onPageSizeChange={setDocPageSize} label="documents" />
          </div>
        </>
      )}
    </>
  );
}

function UploadCard({ title, sub, onPick, busy }) {
  return (
    <label className="card" style={{ background: 'var(--surface-2)', cursor: 'pointer' }}>
      <strong>{title}</strong>
      <div className="muted text-sm mt-1">{sub}</div>
      <div className="mt-3"><span className="btn btn-secondary btn-sm">{busy ? 'Uploading…' : 'Choose file'}</span></div>
      <input type="file" hidden accept="application/pdf,image/jpeg,image/jpg,image/png" onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])} />
    </label>
  );
}

function SummaryCard({ label, value }) {
  return <div className="stat"><div className="stat-label">{label}</div><div className="stat-value" style={{ fontSize: 22 }}>{value}</div></div>;
}

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { FleetHelpTip } from './helpSupport';
import api from '../../api';
import { useAuth } from '../../auth';
import southAfricanCities from '../../constants/southAfricanCities';
import { Badge, EmptyState, Loading, Pagination, SearchInput, fmt, fmtDate, matchesSearch, normalizePhoneInput, paginateItems } from '../../components/ui';
import { canManageFleetSection } from './access';

const PLATFORMS = ['Uber Eats', 'Mr D', 'Bolt Food', 'Takealot', 'Checkers Sixty60', 'Other'];
const PROVINCES = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape'];
const DOC_TYPE_OPTIONS = [
  { value: 'id_document', label: 'ID document' },
  { value: 'drivers_license', label: "Driver's licence" },
  { value: 'selfie', label: 'Selfie' },
  { value: 'payslip', label: 'Payslip' },
  { value: 'other', label: 'Other' }
];

function buildDecisionForm(application, bikes = []) {
  const preferredBikeId = application?.preferred_bike_id ? String(application.preferred_bike_id) : '';
  const selectedBike = bikes.find((bike) => String(bike.id) === preferredBikeId) || bikes[0] || null;
  return {
    bike_id: selectedBike ? String(selectedBike.id) : preferredBikeId,
    weekly_amount: selectedBike?.rental_weekly ? String(selectedBike.rental_weekly) : '',
    total_weeks: selectedBike?.total_weeks ? String(selectedBike.total_weeks) : '78',
    start_date: new Date().toISOString().slice(0, 10),
    reason: ''
  };
}

function buildInitialForm() {
  return {
    full_name: '',
    email: '',
    phone: '',
    id_number: '',
    date_of_birth: '',
    address: '',
    city: '',
    province: 'Gauteng',
    postal_code: '',
    emergency_contact_name: '',
    emergency_contact_phone: '',
    preferred_bike_id: '',
    delivery_platforms: [],
    has_riding_experience: true,
    years_riding: '1',
    has_drivers_license: true,
    payout_preference: 'eft',
    bank_name: '',
    account_holder: '',
    account_number: '',
    branch_code: '',
    ewallet_number: ''
  };
}

function buildInitialFiles() {
  return {
    id_document: null,
    drivers_license: null,
    selfie: null,
    payslip_1: null,
    payslip_2: null,
    payslip_3: null
  };
}

export default function FleetOwnerRiders() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'riders');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [riders, setRiders] = useState([]);
  const [bikes, setBikes] = useState([]);
  const [sharePath, setSharePath] = useState('');
  const [mode, setMode] = useState('');
  const [form, setForm] = useState(buildInitialForm());
  const [files, setFiles] = useState(buildInitialFiles());
  const [detail, setDetail] = useState(null);
  const [uploadForm, setUploadForm] = useState({ doc_type: 'payslip', file: null });
  const [decisionForm, setDecisionForm] = useState(() => buildDecisionForm(null, []));
  const [decisionBusy, setDecisionBusy] = useState(false);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [riderResponse, shareResponse] = await Promise.all([
        api.get('/fleet/riders'),
        api.get('/fleet/riders/share-link')
      ]);
      setRiders(riderResponse.data.riders || []);
      setSharePath(shareResponse.data.path || '');
      if (canManage) {
        try {
          const bikeResponse = await api.get('/fleet/bikes');
          setBikes((bikeResponse.data.bikes || []).filter((bike) => bike.status === 'ready_to_go' || bike.id === Number(detail?.application?.preferred_bike_id)));
        } catch {
          setBikes([]);
        }
      }
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load riders');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(1); }, [search]);

  const shareUrl = useMemo(() => {
    if (!sharePath) return '';
    if (typeof window === 'undefined') return sharePath;
    return `${window.location.origin}${sharePath}`;
  }, [sharePath]);

  const filtered = useMemo(() => riders.filter((item) => matchesSearch(
    search,
    item.id,
    item.full_name,
    item.email,
    item.phone,
    item.make,
    item.model,
    item.registration,
    item.status,
    item.auto_decision,
    item.average_weekly_earnings
  )), [riders, search]);
  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  const togglePlatform = (platform) => setForm((current) => ({
    ...current,
    delivery_platforms: current.delivery_platforms.includes(platform)
      ? current.delivery_platforms.filter((item) => item !== platform)
      : [...current.delivery_platforms, platform]
  }));

  const setText = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const setPhone = (field) => (event) => setForm((current) => ({ ...current, [field]: normalizePhoneInput(event.target.value) }));
  const setFile = (field, file) => setFiles((current) => ({ ...current, [field]: file || null }));

  const resetEditor = () => {
    setMode('');
    setForm(buildInitialForm());
    setFiles(buildInitialFiles());
    setDetail(null);
    setUploadForm({ doc_type: 'payslip', file: null });
    setDecisionForm(buildDecisionForm(null, bikes));
  };

  const openCreate = () => {
    setMode('create');
    setForm(buildInitialForm());
    setFiles(buildInitialFiles());
    setDetail(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openEdit = async (applicationId) => {
    try {
      setSaving(true);
      const { data } = await api.get(`/fleet/riders/${applicationId}`);
      setDetail(data);
      setForm({
        full_name: data.application.full_name || '',
        email: data.application.email || '',
        phone: data.application.phone || '',
        id_number: data.application.id_number || '',
        date_of_birth: data.application.date_of_birth || '',
        address: data.application.address || '',
        city: data.application.city || '',
        province: data.application.province || 'Gauteng',
        postal_code: data.application.postal_code || '',
        emergency_contact_name: data.application.emergency_contact_name || '',
        emergency_contact_phone: data.application.emergency_contact_phone || '',
        preferred_bike_id: data.application.preferred_bike_id || '',
        delivery_platforms: String(data.application.delivery_platforms || '').split(',').map((item) => item.trim()).filter(Boolean),
        has_riding_experience: !!data.application.has_riding_experience,
        years_riding: data.application.years_riding ?? '',
        has_drivers_license: !!data.application.has_drivers_license,
        payout_preference: data.application.payout_preference || 'eft',
        bank_name: data.application.bank_name || '',
        account_holder: data.application.account_holder || '',
        account_number: data.application.account_number || '',
        branch_code: data.application.branch_code || '',
        ewallet_number: data.application.ewallet_number || ''
      });
      setFiles(buildInitialFiles());
      setDecisionForm(buildDecisionForm(data.application, bikes));
      setMode('edit');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load rider details');
    } finally {
      setSaving(false);
    }
  };

  const validateCreate = () => {
    if (!form.full_name || !form.email || !form.phone || !form.id_number) {
      toast.error('Please complete all required personal details');
      return false;
    }
    if (!form.preferred_bike_id) {
      toast.error('Please choose a preferred bike');
      return false;
    }
    if (!form.delivery_platforms.length) {
      toast.error('Select at least one delivery platform');
      return false;
    }
    if (form.payout_preference === 'eft' && (!form.bank_name || !form.account_holder || !form.account_number || !form.branch_code)) {
      toast.error('Please complete all EFT banking details');
      return false;
    }
    if (form.payout_preference === 'ewallet' && !form.ewallet_number) {
      toast.error('Please provide an e-wallet number');
      return false;
    }
    const missing = Object.entries(files).filter(([, file]) => !file);
    if (missing.length) {
      toast.error('Upload ID document, licence, selfie, and 3 payslips');
      return false;
    }
    return true;
  };

  const buildPayload = () => ({
    ...form,
    preferred_bike_id: form.preferred_bike_id ? Number(form.preferred_bike_id) : null,
    years_riding: form.years_riding === '' ? null : Number(form.years_riding)
  });

  const submitCreate = async () => {
    if (!validateCreate()) return;
    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([key, value]) => {
        if (key === 'delivery_platforms') fd.append(key, JSON.stringify(value));
        else if (typeof value === 'boolean') fd.append(key, value ? '1' : '0');
        else fd.append(key, value ?? '');
      });
      Object.entries(files).forEach(([key, value]) => { if (value) fd.append(key, value); });
      await api.post('/fleet/riders', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Rider created and application submitted');
      resetEditor();
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create rider');
    } finally {
      setSaving(false);
    }
  };

  const submitUpdate = async () => {
    if (!detail?.application?.id) return;
    setSaving(true);
    try {
      const { data } = await api.patch(`/fleet/riders/${detail.application.id}`, buildPayload());
      setDetail((current) => ({ ...current, application: data.application }));
      toast.success('Rider details updated');
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update rider');
    } finally {
      setSaving(false);
    }
  };

  const uploadDocument = async () => {
    if (!detail?.application?.id || !uploadForm.file) return toast.error('Choose a file first');
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('doc_type', uploadForm.doc_type);
      fd.append('file', uploadForm.file);
      const { data } = await api.post(`/fleet/riders/${detail.application.id}/documents`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setDetail((current) => ({ ...current, documents: data.documents || [] }));
      setUploadForm({ doc_type: uploadForm.doc_type, file: null });
      toast.success('Document uploaded');
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not upload document');
    } finally {
      setUploading(false);
    }
  };

  const chooseDecisionBike = (bikeId) => {
    const bike = bikes.find((item) => String(item.id) === String(bikeId));
    setDecisionForm((current) => ({
      ...current,
      bike_id: String(bikeId || ''),
      weekly_amount: bike?.rental_weekly ? String(bike.rental_weekly) : current.weekly_amount,
      total_weeks: bike?.total_weeks ? String(bike.total_weeks) : current.total_weeks
    }));
  };

  const reloadDetail = async (applicationId, preserveReason = '') => {
    const { data } = await api.get(`/fleet/riders/${applicationId}`);
    setDetail(data);
    setDecisionForm((current) => ({
      ...buildDecisionForm(data.application, bikes),
      reason: preserveReason || ''
    }));
  };

  const submitApproval = async () => {
    if (!detail?.application?.id) return;
    if (!decisionForm.bike_id) return toast.error('Select a bike to allocate');
    if (!decisionForm.weekly_amount || Number(decisionForm.weekly_amount) <= 0) return toast.error('Weekly amount must be greater than zero');
    if (!decisionForm.total_weeks || Number(decisionForm.total_weeks) <= 0) return toast.error('Total weeks must be greater than zero');
    if (!decisionForm.start_date) return toast.error('Start date is required');

    setDecisionBusy(true);
    try {
      await api.post(`/fleet/riders/${detail.application.id}/approve`, {
        bike_id: Number(decisionForm.bike_id),
        weekly_amount: Number(decisionForm.weekly_amount),
        total_weeks: Number(decisionForm.total_weeks),
        start_date: decisionForm.start_date
      });
      toast.success('Application approved and bike allocated');
      await reloadDetail(detail.application.id);
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not approve application');
    } finally {
      setDecisionBusy(false);
    }
  };

  const submitRejection = async () => {
    if (!detail?.application?.id) return;
    const reason = String(decisionForm.reason || '').trim();
    if (!reason) return toast.error('Decline reason is required');
    if (!window.confirm('Decline this rider application?')) return;

    setDecisionBusy(true);
    try {
      await api.post(`/fleet/riders/${detail.application.id}/reject`, { reason });
      toast.success('Application declined');
      await reloadDetail(detail.application.id, reason);
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not decline application');
    } finally {
      setDecisionBusy(false);
    }
  };

  const copyShareLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Share link copied');
    } catch {
      toast.error('Could not copy link');
    }
  };

  if (loading) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Riders</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>Create rider applications on behalf of riders, keep their details current, upload compliance documents, and share a no-login rider application link.</p>
          <FleetHelpTip section="riders" tooltip="Use this guide for sharing the public rider form, capturing applications manually, reviewing documents, and approving or declining riders." label="Learn more about riders" />
        </div>
        {canManage && <button className="btn" onClick={openCreate} title="Create a rider application manually for someone who has not used the public form">Add rider</button>}
      </div>

      <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
        <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <strong>Public rider application link</strong>
            <div className="muted text-sm mt-1">Share this link with a rider so they can submit the same onboarding details and documents without logging in.</div>
            <div className="mt-2"><FleetHelpTip section="riders" tooltip="Use the public link when riders should complete their own application and upload their own compliance documents." label="When to use this link" compact /></div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={shareUrl} readOnly style={{ minWidth: 320 }} />
            <button className="btn btn-secondary" onClick={copyShareLink}>Copy link</button>
            {shareUrl ? <a className="btn btn-secondary" href={shareUrl} target="_blank" rel="noreferrer">Open</a> : null}
          </div>
        </div>
      </div>

      {mode && canManage && (
        <div className="card mb-4">
          <div className="flex-between mb-3" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ marginBottom: 4 }}>{mode === 'create' ? 'Create rider application' : `Update rider #${detail?.application?.id || ''}`}</h3>
              <div className="muted text-sm">Use the same rider onboarding fields as the public rider sign-up flow, without requiring a password.</div>
              <div className="mt-2"><FleetHelpTip section="riders" tooltip="Complete personal details, payout details, preferred bike, and compliance fields before creating or updating the application." label="Application field guide" compact /></div>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {detail?.application?.status ? <Badge status={detail.application.status}>{detail.application.auto_decision === 'pre_approved' ? 'pre-approved' : detail.application.status}</Badge> : null}
              <button className="btn btn-secondary" onClick={resetEditor}>Close</button>
            </div>
          </div>

          <div className="grid grid-2">
            <div className="field"><label className="label">Full name *</label><input value={form.full_name} onChange={setText('full_name')} /></div>
            <div className="field"><label className="label">Email *</label><input type="email" value={form.email} onChange={setText('email')} /></div>
            <div className="field"><label className="label">Phone *</label><input value={form.phone} onChange={setPhone('phone')} placeholder="+27 82 123 4567" /></div>
            <div className="field"><label className="label">ID number / Passport / Asylum *</label><input value={form.id_number} onChange={setText('id_number')} /></div>
            <div className="field"><label className="label">Date of birth</label><input type="date" value={form.date_of_birth} onChange={setText('date_of_birth')} /></div>
            <div className="field"><label className="label">Postal code</label><input value={form.postal_code} onChange={setText('postal_code')} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Street address</label><input value={form.address} onChange={setText('address')} /></div>
            <div className="field"><label className="label">City</label><select value={form.city} onChange={setText('city')}><option value="">Select city</option>{southAfricanCities.map((city) => <option key={city} value={city}>{city}</option>)}</select></div>
            <div className="field"><label className="label">Province</label><select value={form.province} onChange={setText('province')}>{PROVINCES.map((province) => <option key={province} value={province}>{province}</option>)}</select></div>
            <div className="field"><label className="label">Emergency contact name</label><input value={form.emergency_contact_name} onChange={setText('emergency_contact_name')} /></div>
            <div className="field"><label className="label">Emergency contact phone</label><input value={form.emergency_contact_phone} onChange={setPhone('emergency_contact_phone')} /></div>
          </div>

          <h3 className="mt-4 mb-3">Application details</h3>
          <div className="grid grid-2">
            <div className="field"><label className="label">Preferred bike *</label><select value={form.preferred_bike_id} onChange={setText('preferred_bike_id')}><option value="">— Select a bike —</option>{bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.registration || 'No reg'} · {fmt(bike.rental_weekly)}/week</option>)}</select></div>
            <div className="field"><label className="label">Payout preference</label><select value={form.payout_preference} onChange={setText('payout_preference')}><option value="eft">EFT banking details</option><option value="ewallet">E-wallet number</option></select></div>
          </div>

          <div className="field"><label className="label">Delivery platforms *</label>
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
            <div className="field"><label className="label">Years of riding experience</label><input type="number" min="0" value={form.years_riding} onChange={setText('years_riding')} /></div>
            <div className="field"><label className="label">Valid driver's licence</label><select value={form.has_drivers_license ? '1' : '0'} onChange={(event) => setForm((current) => ({ ...current, has_drivers_license: event.target.value === '1' }))}><option value="1">Yes</option><option value="0">No</option></select></div>
          </div>

          {form.payout_preference === 'eft' ? (
            <div className="grid grid-2">
              <div className="field"><label className="label">Bank name</label><input value={form.bank_name} onChange={setText('bank_name')} /></div>
              <div className="field"><label className="label">Account holder</label><input value={form.account_holder} onChange={setText('account_holder')} /></div>
              <div className="field"><label className="label">Account number</label><input value={form.account_number} onChange={setText('account_number')} /></div>
              <div className="field"><label className="label">Branch code</label><input value={form.branch_code} onChange={setText('branch_code')} /></div>
            </div>
          ) : (
            <div className="field"><label className="label">E-wallet number</label><input value={form.ewallet_number} onChange={setPhone('ewallet_number')} /></div>
          )}

          {mode === 'edit' && detail && canManage && ['submitted', 'under_review'].includes(detail.application?.status) ? (
            <>
              <div className="fleet-help-meta mt-4 mb-3">
                <h3>Application decision</h3>
                <FleetHelpTip section="riders" tooltip="Approve only after reviewing the rider details, uploaded documents, selected bike, weekly amount, and start date." label="Approval guide" compact />
              </div>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <div className="grid grid-2">
                  <div className="field"><label className="label">Allocate bike</label><select value={decisionForm.bike_id} onChange={(event) => chooseDecisionBike(event.target.value)}><option value="">— Select a bike —</option>{bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.registration || 'No reg'} · {fmt(bike.rental_weekly)}/week</option>)}</select></div>
                  <div className="field"><label className="label">Start date</label><input type="date" value={decisionForm.start_date} onChange={(event) => setDecisionForm((current) => ({ ...current, start_date: event.target.value }))} /></div>
                  <div className="field"><label className="label">Weekly amount</label><input type="number" min="1" value={decisionForm.weekly_amount} onChange={(event) => setDecisionForm((current) => ({ ...current, weekly_amount: event.target.value }))} /></div>
                  <div className="field"><label className="label">Total weeks</label><input type="number" min="1" value={decisionForm.total_weeks} onChange={(event) => setDecisionForm((current) => ({ ...current, total_weeks: event.target.value }))} /></div>
                </div>
                <div className="mt-2 muted text-sm">Contract value: {fmt((Number(decisionForm.weekly_amount || 0) * Number(decisionForm.total_weeks || 0)) || 0)}</div>
                <div className="field mt-3"><label className="label">Decline reason</label><textarea rows="3" value={decisionForm.reason} onChange={(event) => setDecisionForm((current) => ({ ...current, reason: event.target.value }))} placeholder="Explain why this application is being declined" /></div>
                <div className="row mt-3" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-danger" disabled={decisionBusy} onClick={submitRejection}>{decisionBusy ? 'Working…' : 'Decline application'}</button>
                  <button className="btn" disabled={decisionBusy} onClick={submitApproval}>{decisionBusy ? 'Working…' : 'Approve and allocate bike'}</button>
                </div>
              </div>
            </>
          ) : null}

          {mode === 'edit' && detail?.agreement ? (
            <div className="card mt-4 mb-3" style={{ background: 'var(--surface-2)' }}>
              <strong>Agreement created</strong>
              <div className="muted text-sm mt-1">{detail.agreement.agreement_no} · {detail.agreement.status} · starts {fmtDate(detail.agreement.start_date)}</div>
            </div>
          ) : null}

          {mode === 'edit' && detail?.application?.status === 'rejected' && detail?.application?.rejection_reason ? (
            <div className="card mt-4 mb-3" style={{ background: 'var(--surface-2)' }}>
              <strong>Decline reason</strong>
              <div className="muted text-sm mt-1">{detail.application.rejection_reason}</div>
            </div>
          ) : null}

          {mode === 'create' ? (
            <>
              <div className="fleet-help-meta mt-4 mb-3">
                <h3>Required uploads</h3>
                <FleetHelpTip section="riders" tooltip="ID, licence, selfie, and three payslips are required so the application can be reviewed properly and assessed against the auto-decision rules." label="Upload guide" compact />
              </div>
              <div className="grid grid-2">
                <UploadField label="ID document *" file={files.id_document} onChange={(file) => setFile('id_document', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" />
                <UploadField label="Driver's licence *" file={files.drivers_license} onChange={(file) => setFile('drivers_license', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" />
                <UploadField label="Selfie *" file={files.selfie} onChange={(file) => setFile('selfie', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" />
                <div className="card" style={{ background: 'var(--surface-2)' }}>
                  <strong>Auto-decision rule</strong>
                  <div className="muted text-sm mt-2">Three payslips are required so the platform can calculate average weekly earnings. Below R1000/week auto-declines. R1000/week or above pre-approves for review.</div>
                </div>
                <UploadField label="Payslip 1 *" file={files.payslip_1} onChange={(file) => setFile('payslip_1', file)} accept="application/pdf" />
                <UploadField label="Payslip 2 *" file={files.payslip_2} onChange={(file) => setFile('payslip_2', file)} accept="application/pdf" />
                <UploadField label="Payslip 3 *" file={files.payslip_3} onChange={(file) => setFile('payslip_3', file)} accept="application/pdf" />
              </div>
            </>
          ) : detail ? (
            <>
              <div className="fleet-help-meta mt-4 mb-3">
                <h3>Existing documents</h3>
                <FleetHelpTip section="riders" tooltip="Upload missing documents here when an application is incomplete or when newer compliance files need to replace earlier ones." label="Document help" compact />
              </div>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <div className="grid grid-3" style={{ alignItems: 'end' }}>
                  <div className="field"><label className="label">Document type</label><select value={uploadForm.doc_type} onChange={(event) => setUploadForm((current) => ({ ...current, doc_type: event.target.value, file: null }))}>{DOC_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
                  <div className="field"><label className="label">File</label><input type="file" accept={uploadForm.doc_type === 'payslip' ? 'application/pdf' : 'application/pdf,image/jpeg,image/jpg,image/png,image/webp'} onChange={(event) => setUploadForm((current) => ({ ...current, file: event.target.files?.[0] || null }))} /></div>
                  <div><button className="btn" onClick={uploadDocument} disabled={uploading || !uploadForm.file}>{uploading ? 'Uploading…' : 'Upload document'}</button></div>
                </div>
              </div>
              <table className="table">
                <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Amount</th><th></th></tr></thead>
                <tbody>
                  {(detail.documents || []).map((doc) => (
                    <tr key={doc.id}>
                      <td>{doc.doc_type.replace(/_/g, ' ')}</td>
                      <td>{doc.original_name}</td>
                      <td>{fmtDate(doc.uploaded_at)}</td>
                      <td>{doc.extracted_amount ? fmt(doc.extracted_amount) : '—'}</td>
                      <td><a className="btn btn-sm btn-secondary" href={doc.file_path} target="_blank" rel="noreferrer">Open</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!(detail.documents || []).length && <div className="muted text-sm">No documents uploaded yet.</div>}
            </>
          ) : null}

          <div className="row mt-4" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={resetEditor}>Cancel</button>
            <button className="btn" disabled={saving} onClick={mode === 'create' ? submitCreate : submitUpdate}>{saving ? 'Saving…' : mode === 'create' ? 'Create rider' : 'Save changes'}</button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="flex-between" style={{ padding: 16, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <strong>Rider applications</strong>
            <div className="mt-2"><FleetHelpTip section="common-questions" tooltip="Search by rider name, email, phone number, bike details, registration, application status, or earnings decision." label="Search tips" compact /></div>
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Search rider, email, bike, status" style={{ width: 320 }} />
        </div>
        <table className="table">
          <thead><tr><th>Rider</th><th>Bike</th><th>Status</th><th>Avg weekly</th><th>Docs</th><th>Submitted</th><th></th></tr></thead>
          <tbody>
            {pagination.items.map((item) => (
              <tr key={item.id}>
                <td>{item.full_name}<div className="text-xs muted">{item.email} · {item.phone || '—'}</div></td>
                <td>{item.make ? `${item.make} ${item.model}` : '—'}<div className="text-xs muted">{item.registration || 'No registration'}</div></td>
                <td><Badge status={item.status}>{item.auto_decision === 'pre_approved' ? 'pre-approved' : item.status}</Badge></td>
                <td>{item.average_weekly_earnings ? fmt(item.average_weekly_earnings) : 'Pending'}</td>
                <td>{item.document_count || 0}<div className="text-xs muted">Payslips: {item.payslip_count || 0}/3</div></td>
                <td>{fmtDate(item.submitted_at)}</td>
                <td>{canManage ? <button className="btn btn-sm btn-secondary" disabled={saving} onClick={() => openEdit(item.id)}>Manage</button> : <span className="muted text-sm">View only</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pagination.items.length && <EmptyState title="No riders yet" sub="Create a rider application from the fleet console or share the public rider link above." action={canManage ? <button className="btn" onClick={openCreate}>Add rider</button> : null} />}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="riders" />
    </>
  );
}

function UploadField({ label, file, onChange, accept }) {
  return (
    <label className="card" style={{ background: 'var(--surface-2)', cursor: 'pointer' }}>
      <strong>{label}</strong>
      <div className="muted text-sm mt-2">{file ? file.name : 'Choose file'}</div>
      <div className="mt-3"><span className="btn btn-secondary btn-sm">Select file</span></div>
      <input hidden type="file" accept={accept} onChange={(event) => onChange(event.target.files?.[0] || null)} />
    </label>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import Logo from '../components/Logo';
import southAfricanCities from '../constants/southAfricanCities';
import { fmt, normalizePhoneInput } from '../components/ui';

const PLATFORMS = ['Uber Eats', 'Mr D', 'Bolt Food', 'Takealot', 'Checkers Sixty60', 'Other'];
const PROVINCES = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape'];

function buildInitialForm() {
  return {
    full_name: '',
    email: '',
    phone: '',
    id_number: '',
    address: '',
    city: '',
    province: 'Gauteng',
    postal_code: '',
    date_of_birth: '',
    emergency_contact_name: '',
    emergency_contact_phone: '',
    preferred_bike_id: '',
    delivery_platforms: [],
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

export default function FleetRiderApply() {
  const { slug } = useParams();
  const nav = useNavigate();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [organization, setOrganization] = useState(null);
  const [bikes, setBikes] = useState([]);
  const [form, setForm] = useState(buildInitialForm());
  const [files, setFiles] = useState(buildInitialFiles());
  const [payslipAmounts, setPayslipAmounts] = useState({ payslip_1: '', payslip_2: '', payslip_3: '' });

  useEffect(() => {
    setLoading(true);
    api.get(`/fleet/public/${slug}/context`)
      .then((response) => {
        setOrganization(response.data.organization || null);
        setBikes(response.data.bikes || []);
      })
      .catch((error) => {
        toast.error(error.response?.data?.error || 'Could not open rider application link');
        nav('/');
      })
      .finally(() => setLoading(false));
  }, [slug]);

  const setText = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const setPhone = (field) => (event) => setForm((current) => ({ ...current, [field]: normalizePhoneInput(event.target.value) }));
  const togglePlatform = (platform) => setForm((current) => ({
    ...current,
    delivery_platforms: current.delivery_platforms.includes(platform)
      ? current.delivery_platforms.filter((item) => item !== platform)
      : [...current.delivery_platforms, platform]
  }));
  const setFile = (field, file) => setFiles((current) => ({ ...current, [field]: file || null }));

  const selectedBike = useMemo(() => bikes.find((bike) => String(bike.id) === String(form.preferred_bike_id)), [bikes, form.preferred_bike_id]);

  const validateStep = () => {
    if (step === 1) {
      if (!form.full_name || !form.email || !form.phone || !form.id_number) {
        toast.error('Please complete all required personal details');
        return false;
      }
      return true;
    }
    if (step === 2) {
      if (!form.address || !form.city || !form.province) {
        toast.error('Please complete your address details');
        return false;
      }
      return true;
    }
    if (step === 3) {
      if (!form.preferred_bike_id) {
        toast.error('Please choose your preferred bike');
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
        toast.error('Please provide your e-wallet number');
        return false;
      }
      return true;
    }
    const missing = Object.entries(files).filter(([, file]) => !file);
    if (missing.length) {
      toast.error('Please upload ID document, licence, selfie, and 3 payslips');
      return false;
    }
    for (const field of ['payslip_1', 'payslip_2', 'payslip_3']) {
      const file = files[field];
      if (file && file.type !== 'application/pdf' && !String(payslipAmounts[field] || '').trim()) {
        toast.error(`Enter the monthly Rand amount shown on ${field.replace('_', ' ')} (non-PDF file)`);
        return false;
      }
    }
    return true;
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!validateStep()) return;
    setBusy(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([key, value]) => {
        if (key === 'delivery_platforms') fd.append(key, JSON.stringify(value));
        else if (typeof value === 'boolean') fd.append(key, value ? '1' : '0');
        else fd.append(key, value ?? '');
      });
      fd.append('has_riding_experience', Number(form.years_riding || 0) > 0 ? '1' : '0');
      Object.entries(files).forEach(([key, value]) => { if (value) fd.append(key, value); });
      ['payslip_1', 'payslip_2', 'payslip_3'].forEach((field) => {
        if (payslipAmounts[field]) fd.append(`${field}_amount`, payslipAmounts[field]);
      });
      await api.post(`/fleet/public/${slug}/rider-application`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Application submitted successfully. The fleet owner will review your details.');
      setForm(buildInitialForm());
      setFiles(buildInitialFiles());
      setPayslipAmounts({ payslip_1: '', payslip_2: '', payslip_3: '' });
      setStep(1);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not submit application');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="center-flex"><div className="spinner" /></div>;

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size="lg" />
        <div>
          <div className="auth-tagline">Rider application for<br /><span>{organization?.name || 'OnFleet Africa'}</span></div>
          <p className="muted" style={{ maxWidth: 440 }}>Complete the same rider onboarding details and upload all documents now. No account password or sign-in is needed for this shared application link.</p>
        </div>
        <div className="muted text-sm">Step {step} of 4</div>
      </div>

      <div className="auth-form">
        <h1>Submit rider application</h1>
        <div className="sub">Fleet owner: {organization?.name || '—'}{organization?.city ? ` · ${organization.city}` : ''}</div>

        <form onSubmit={submit}>
          {step === 1 && (
            <>
              <div className="field"><label className="label">Full name *</label><input required value={form.full_name} onChange={setText('full_name')} placeholder="Thabo Mokoena" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">Email *</label><input type="email" required value={form.email} onChange={setText('email')} /></div>
                <div className="field"><label className="label">Phone (WhatsApp) *</label><input type="tel" required value={form.phone} onChange={setPhone('phone')} placeholder="+27 82 123 4567" /></div>
              </div>
              <div className="grid grid-2">
                <div className="field"><label className="label">ID number / Passport / Asylum number *</label><input required value={form.id_number} onChange={setText('id_number')} /></div>
                <div className="field"><label className="label">Date of birth</label><input type="date" value={form.date_of_birth} onChange={setText('date_of_birth')} /></div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="field"><label className="label">Street address *</label><input value={form.address} onChange={setText('address')} placeholder="123 Main Road" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">City *</label><select value={form.city} onChange={setText('city')}><option value="">Select city</option>{southAfricanCities.map((city) => <option key={city} value={city}>{city}</option>)}</select></div>
                <div className="field"><label className="label">Postal code</label><input value={form.postal_code} onChange={setText('postal_code')} /></div>
              </div>
              <div className="field"><label className="label">Province *</label><select value={form.province} onChange={setText('province')}>{PROVINCES.map((province) => <option key={province} value={province}>{province}</option>)}</select></div>
              <h3 className="mt-4 mb-2">Emergency contact</h3>
              <div className="grid grid-2">
                <div className="field"><label className="label">Name</label><input value={form.emergency_contact_name} onChange={setText('emergency_contact_name')} /></div>
                <div className="field"><label className="label">Phone</label><input type="tel" value={form.emergency_contact_phone} onChange={setPhone('emergency_contact_phone')} placeholder="+27 81 234 5678" /></div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-2">
                <div className="field"><label className="label">Preferred bike *</label><select value={form.preferred_bike_id} onChange={setText('preferred_bike_id')}><option value="">— Select a bike —</option>{bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.registration || 'No reg'} · {fmt(bike.rental_weekly)}/week</option>)}</select></div>
                <div className="card" style={{ background: 'var(--surface-2)', alignSelf: 'end' }}><strong>Bike availability</strong><div className="muted text-sm mt-1">Only bikes available for this fleet owner appear here.</div></div>
              </div>

              {selectedBike ? (
                <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                  <div className="flex-between"><span className="muted">Selected bike</span><strong>{selectedBike.make} {selectedBike.model}</strong></div>
                  <div className="flex-between"><span className="muted">Registration</span><strong>{selectedBike.registration || 'Pending registration'}</strong></div>
                  <div className="flex-between"><span className="muted">Weekly amount</span><strong>{fmt(selectedBike.rental_weekly)}</strong></div>
                </div>
              ) : null}

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

              <div className="field"><label className="label">Payout preference</label><select value={form.payout_preference} onChange={setText('payout_preference')}><option value="eft">EFT banking details</option><option value="ewallet">E-wallet number</option></select></div>

              {form.payout_preference === 'eft' ? (
                <div className="grid grid-2">
                  <div className="field"><label className="label">Bank name *</label><input value={form.bank_name} onChange={setText('bank_name')} /></div>
                  <div className="field"><label className="label">Account holder *</label><input value={form.account_holder} onChange={setText('account_holder')} /></div>
                  <div className="field"><label className="label">Account number *</label><input value={form.account_number} onChange={setText('account_number')} /></div>
                  <div className="field"><label className="label">Branch code *</label><input value={form.branch_code} onChange={setText('branch_code')} /></div>
                </div>
              ) : (
                <div className="field"><label className="label">E-wallet number *</label><input value={form.ewallet_number} onChange={setPhone('ewallet_number')} placeholder="Cellphone number for wallet payouts" /></div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>Required uploads</strong>
                <div className="muted text-sm mt-1">Upload ID document, driver's licence, selfie, and your latest 3 payslips. Payslips can be PDF, image, Word document, or any common format — if not a PDF, you'll be asked to type the monthly Rand amount shown on it.</div>
              </div>
              <div className="grid grid-2">
                <UploadField label="ID document *" file={files.id_document} onChange={(file) => setFile('id_document', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" />
                <UploadField label="Driver's licence *" file={files.drivers_license} onChange={(file) => setFile('drivers_license', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" />
                <UploadField label="Selfie *" file={files.selfie} onChange={(file) => setFile('selfie', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" />
                <div className="card" style={{ background: 'var(--surface-2)' }}>
                  <strong>Auto-decision rule</strong>
                  <div className="muted text-sm mt-2">Three payslips are required to calculate average weekly earnings. Below R1000/week auto-declines. R1000/week or above moves the application into review.</div>
                </div>
                <PayslipUploadField label="Payslip 1 *" file={files.payslip_1} amount={payslipAmounts.payslip_1} onFileChange={(file) => { setFile('payslip_1', file); setPayslipAmounts((current) => ({ ...current, payslip_1: '' })); }} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_1: value }))} />
                <PayslipUploadField label="Payslip 2 *" file={files.payslip_2} amount={payslipAmounts.payslip_2} onFileChange={(file) => { setFile('payslip_2', file); setPayslipAmounts((current) => ({ ...current, payslip_2: '' })); }} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_2: value }))} />
                <PayslipUploadField label="Payslip 3 *" file={files.payslip_3} amount={payslipAmounts.payslip_3} onFileChange={(file) => { setFile('payslip_3', file); setPayslipAmounts((current) => ({ ...current, payslip_3: '' })); }} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_3: value }))} />
              </div>
            </>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            {step > 1 && <button type="button" className="btn btn-secondary" onClick={() => setStep(step - 1)}>Back</button>}
            {step < 4 ? (
              <button type="button" className="btn btn-block" onClick={() => validateStep() && setStep(step + 1)}>Continue</button>
            ) : (
              <button className="btn btn-block" disabled={busy}>{busy ? 'Submitting…' : 'Submit rider application'}</button>
            )}
          </div>
        </form>

        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>
          Already have an OnFleet account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
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

function PayslipUploadField({ label, file, amount, onFileChange, onAmountChange }) {
  const needsAmount = file && file.type !== 'application/pdf';
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <label style={{ cursor: 'pointer' }}>
        <strong>{label}</strong>
        <div className="muted text-sm mt-2">{file ? file.name : 'Choose file'}</div>
        <div className="mt-3"><span className="btn btn-secondary btn-sm">Select file</span></div>
        <input hidden type="file" accept="application/pdf,image/*,.doc,.docx,.heic" onChange={(event) => onFileChange(event.target.files?.[0] || null)} />
      </label>
      {needsAmount && (
        <div className="field mt-3">
          <label className="label">Monthly amount on payslip (Rand) *</label>
          <input type="number" min="0" step="0.01" placeholder="e.g. 8500" value={amount} onChange={(event) => onAmountChange(event.target.value)} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

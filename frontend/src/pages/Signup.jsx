import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import api from '../api';
import toast from 'react-hot-toast';
import Logo from '../components/Logo';

const PLATFORMS = ['Uber Eats', 'Mr D', 'Bolt Food', 'Takealot', 'Checkers Sixty60', 'Other'];
const PROVINCES = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape'];

export default function Signup() {
  const [form, setForm] = useState({
    full_name: '', email: '', phone: '', id_number: '', password: '',
    address: '', city: '', province: 'Gauteng', postal_code: '',
    date_of_birth: '', emergency_contact_name: '', emergency_contact_phone: '',
    preferred_bike_id: '', monthly_income: '', delivery_platforms: [], years_riding: '1',
    has_drivers_license: true, payout_preference: 'eft',
    bank_name: '', account_holder: '', account_number: '', branch_code: '', ewallet_number: ''
  });
  const [files, setFiles] = useState({
    id_document: null,
    drivers_license: null,
    selfie: null,
    payslip_1: null,
    payslip_2: null,
    payslip_3: null
  });
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [bikes, setBikes] = useState([]);
  const { signup } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    api.get('/bikes/catalog').then((r) => setBikes(r.data.bikes || [])).catch(() => setBikes([]));
  }, []);

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const selectedBike = useMemo(() => bikes.find((bike) => String(bike.id) === String(form.preferred_bike_id)), [bikes, form.preferred_bike_id]);

  const togglePlatform = (platform) => setForm((current) => ({
    ...current,
    delivery_platforms: current.delivery_platforms.includes(platform)
      ? current.delivery_platforms.filter((item) => item !== platform)
      : [...current.delivery_platforms, platform]
  }));

  const setFile = (key, file) => setFiles((current) => ({ ...current, [key]: file || null }));

  const validateStep = () => {
    if (step === 1) {
      if (!form.full_name || !form.email || !form.phone || !form.id_number || !form.password) {
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
    if (step === 4) {
      const missing = Object.entries(files).filter(([, file]) => !file);
      if (missing.length) {
        toast.error('Please upload all required KYC documents and 3 payslips');
        return false;
      }
      return true;
    }
    return true;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validateStep()) return;
    setBusy(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([key, value]) => {
        if (key === 'delivery_platforms') fd.append(key, JSON.stringify(value));
        else if (typeof value === 'boolean') fd.append(key, value ? '1' : '0');
        else if (value !== null && value !== undefined) fd.append(key, value);
      });
      fd.append('has_riding_experience', Number(form.years_riding || 0) > 0 ? '1' : '0');
      Object.entries(files).forEach(([key, value]) => { if (value) fd.append(key, value); });
      await signup(fd);
      toast.success('Account created and full application submitted. We are reviewing your documents now.');
      nav('/dashboard');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Sign up failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size="lg" />
        <div>
          <div className="auth-tagline">Apply once,<br /><span>upload everything upfront.</span></div>
          <p className="muted" style={{ maxWidth: 440 }}>Create your account, answer the rider application questions, and upload all KYC documents including 3 payslips before you enter the platform.</p>
        </div>
        <div className="muted text-sm">Step {step} of 4</div>
      </div>

      <div className="auth-form">
        <h1>Create account & application</h1>
        <div className="sub">No proof of address required. Upload ID, licence, selfie, and 3 latest payslips.</div>

        <form onSubmit={submit}>
          {step === 1 && (
            <>
              <div className="field"><label className="label">Full name *</label><input required value={form.full_name} onChange={f('full_name')} placeholder="Thabo Mokoena" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">Email *</label><input type="email" required value={form.email} onChange={f('email')} /></div>
                <div className="field"><label className="label">Phone (WhatsApp) *</label><input required value={form.phone} onChange={f('phone')} placeholder="+27 82 123 4567" /></div>
              </div>
              <div className="grid grid-2">
                <div className="field"><label className="label">ID Number *</label><input required value={form.id_number} onChange={f('id_number')} maxLength={13} /></div>
                <div className="field"><label className="label">Date of birth</label><input type="date" value={form.date_of_birth} onChange={f('date_of_birth')} /></div>
              </div>
              <div className="field"><label className="label">Password *</label><input type="password" required minLength={6} value={form.password} onChange={f('password')} /></div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="field"><label className="label">Street address *</label><input value={form.address} onChange={f('address')} placeholder="123 Main Road" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">City *</label><input value={form.city} onChange={f('city')} placeholder="Johannesburg" /></div>
                <div className="field"><label className="label">Postal code</label><input value={form.postal_code} onChange={f('postal_code')} /></div>
              </div>
              <div className="field"><label className="label">Province *</label>
                <select value={form.province} onChange={f('province')}>
                  {PROVINCES.map((province) => <option key={province}>{province}</option>)}
                </select>
              </div>
              <h3 className="mt-4 mb-2">Emergency contact</h3>
              <div className="grid grid-2">
                <div className="field"><label className="label">Name</label><input value={form.emergency_contact_name} onChange={f('emergency_contact_name')} /></div>
                <div className="field"><label className="label">Phone</label><input value={form.emergency_contact_phone} onChange={f('emergency_contact_phone')} /></div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-2">
                <div className="field"><label className="label">Preferred bike *</label>
                  <select value={form.preferred_bike_id} onChange={f('preferred_bike_id')}>
                    <option value="">— Select a bike —</option>
                    {bikes.map((bike) => (
                      <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.engine_cc}cc · R{bike.rental_weekly}/week</option>
                    ))}
                  </select>
                </div>
                <div className="field"><label className="label">Monthly income (optional)</label><input type="number" value={form.monthly_income} onChange={f('monthly_income')} placeholder="12000" /></div>
              </div>

              {selectedBike && (
                <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                  <div className="flex-between"><span className="muted">Selected bike</span><strong>{selectedBike.make} {selectedBike.model}</strong></div>
                  <div className="flex-between"><span className="muted">Weekly amount</span><strong>R{selectedBike.rental_weekly}</strong></div>
                </div>
              )}

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
                <div className="field"><label className="label">Years of riding experience</label><input type="number" min="0" value={form.years_riding} onChange={f('years_riding')} /></div>
                <div className="field"><label className="label">Valid driver's licence</label>
                  <select value={form.has_drivers_license ? '1' : '0'} onChange={(e) => setForm({ ...form, has_drivers_license: e.target.value === '1' })}>
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                </div>
              </div>

              <div className="field"><label className="label">Payout preference</label>
                <select value={form.payout_preference} onChange={f('payout_preference')}>
                  <option value="eft">EFT banking details</option>
                  <option value="ewallet">E-wallet number</option>
                </select>
              </div>

              {form.payout_preference === 'eft' ? (
                <div className="grid grid-2">
                  <div className="field"><label className="label">Bank name *</label><input value={form.bank_name} onChange={f('bank_name')} /></div>
                  <div className="field"><label className="label">Account holder *</label><input value={form.account_holder} onChange={f('account_holder')} /></div>
                  <div className="field"><label className="label">Account number *</label><input value={form.account_number} onChange={f('account_number')} /></div>
                  <div className="field"><label className="label">Branch code *</label><input value={form.branch_code} onChange={f('branch_code')} /></div>
                </div>
              ) : (
                <div className="field"><label className="label">E-wallet number *</label><input value={form.ewallet_number} onChange={f('ewallet_number')} placeholder="Cellphone number for wallet payouts" /></div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>Required uploads</strong>
                <div className="muted text-sm mt-1">Upload all KYC documents now: ID document, driver's licence, selfie, and 3 latest payslips. Accepted formats: PDF, JPG, JPEG, PNG.</div>
              </div>
              <div className="grid grid-2">
                <UploadField label="ID document *" file={files.id_document} onChange={(file) => setFile('id_document', file)} />
                <UploadField label="Driver's licence *" file={files.drivers_license} onChange={(file) => setFile('drivers_license', file)} />
                <UploadField label="Selfie holding ID *" file={files.selfie} onChange={(file) => setFile('selfie', file)} />
                <div className="card" style={{ background: 'var(--surface-2)' }}>
                  <strong>Auto-decision rule</strong>
                  <div className="muted text-sm mt-2">OnFleet reads the 3 latest payslips, totals the paid amounts, and computes average weekly earnings. Below R1000/week = auto-decline with 2-week retry. R1000/week or more = auto-pre-approval.</div>
                </div>
                <UploadField label="Payslip 1 *" file={files.payslip_1} onChange={(file) => setFile('payslip_1', file)} />
                <UploadField label="Payslip 2 *" file={files.payslip_2} onChange={(file) => setFile('payslip_2', file)} />
                <UploadField label="Payslip 3 *" file={files.payslip_3} onChange={(file) => setFile('payslip_3', file)} />
              </div>
            </>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            {step > 1 && <button type="button" className="btn btn-secondary" onClick={() => setStep(step - 1)}>Back</button>}
            {step < 4 ? (
              <button type="button" className="btn btn-block" onClick={() => validateStep() && setStep(step + 1)}>Continue</button>
            ) : (
              <button className="btn btn-block" disabled={busy}>{busy ? 'Submitting…' : 'Create account & submit application'}</button>
            )}
          </div>
        </form>

        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}

function UploadField({ label, file, onChange }) {
  return (
    <label className="card" style={{ background: 'var(--surface-2)', cursor: 'pointer' }}>
      <strong>{label}</strong>
      <div className="muted text-sm mt-2">{file ? file.name : 'Choose file'}</div>
      <div className="mt-3"><span className="btn btn-secondary btn-sm">Select file</span></div>
      <input hidden type="file" accept="application/pdf,image/jpeg,image/jpg,image/png" onChange={(e) => onChange(e.target.files?.[0] || null)} />
    </label>
  );
}

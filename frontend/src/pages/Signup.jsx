import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import api from '../api';
import toast from 'react-hot-toast';
import Logo from '../components/Logo';
import southAfricanCities from '../constants/southAfricanCities';
import { fmt, normalizePhoneInput, Modal } from '../components/ui';

const PLATFORMS = ['Uber Eats', 'Mr D', 'Bolt Food', 'Takealot', 'Checkers Sixty60', 'Other'];
const PROVINCES = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape'];
const PAYSLIP_FIELDS = ['payslip_1', 'payslip_2', 'payslip_3'];

function isPayslipImage(file) {
  return ['image/jpeg', 'image/jpg'].includes(String(file?.type || '').toLowerCase());
}

export default function Signup() {
  const [form, setForm] = useState({
    full_name: '', email: '', phone: '', id_number: '', password: '',
    address: '', city: '', province: 'Gauteng', postal_code: '',
    date_of_birth: '', emergency_contact_name: '', emergency_contact_phone: '',
    preferred_bike_id: '', delivery_platforms: [], years_riding: '1',
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
  const [payslipAmounts, setPayslipAmounts] = useState({ payslip_1: '', payslip_2: '', payslip_3: '' });
  const [validationIssues, setValidationIssues] = useState([]);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [bikes, setBikes] = useState([]);
  const { signup } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    api.get('/bikes/catalog').then((r) => setBikes(r.data.bikes || [])).catch(() => setBikes([]));
  }, []);

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setPhoneField = (k) => (e) => setForm({ ...form, [k]: normalizePhoneInput(e.target.value) });
  const selectedBike = useMemo(() => bikes.find((bike) => String(bike.id) === String(form.preferred_bike_id)), [bikes, form.preferred_bike_id]);

  const togglePlatform = (platform) => setForm((current) => ({
    ...current,
    delivery_platforms: current.delivery_platforms.includes(platform)
      ? current.delivery_platforms.filter((item) => item !== platform)
      : [...current.delivery_platforms, platform]
  }));

  const setFile = (key, file) => setFiles((current) => ({ ...current, [key]: file || null }));
  const setPayslipFile = (key, file) => {
    setFile(key, file);
    if (!isPayslipImage(file)) {
      setPayslipAmounts((current) => ({ ...current, [key]: '' }));
    }
  };

  const buildStepIssues = () => {
    const issues = [];

    if (step === 1) {
      if (!form.full_name.trim()) issues.push('Enter your full name.');
      if (!form.email.trim()) issues.push('Enter your email address.');
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) issues.push('Enter a valid email address.');
      if (!form.phone.trim()) issues.push('Enter your phone or WhatsApp number.');
      if (!form.id_number.trim()) issues.push('Enter your ID number, passport number, or asylum number.');
      if (!form.password) issues.push('Create a password.');
      else if (form.password.length < 6) issues.push('Your password must be at least 6 characters long.');
    }

    if (step === 2) {
      if (!form.address.trim()) issues.push('Enter your street address.');
      if (!form.city.trim()) issues.push('Choose your city.');
      if (!form.province.trim()) issues.push('Choose your province.');
    }

    if (step === 3) {
      if (!form.preferred_bike_id) issues.push('Choose your preferred bike.');
      if (!form.delivery_platforms.length) issues.push('Select at least one delivery platform.');
      if (form.payout_preference === 'eft') {
        if (!form.bank_name.trim()) issues.push('Enter your bank name.');
        if (!form.account_holder.trim()) issues.push('Enter the bank account holder name.');
        if (!form.account_number.trim()) issues.push('Enter the bank account number.');
        if (!form.branch_code.trim()) issues.push('Enter the bank branch code.');
      }
      if (form.payout_preference === 'ewallet' && !form.ewallet_number.trim()) {
        issues.push('Enter your e-wallet cellphone number.');
      }
    }

    if (step === 4) {
      if (!files.id_document) issues.push('Upload your ID document.');
      if (!files.drivers_license) issues.push("Upload your driver's licence.");
      if (!files.selfie) issues.push('Upload your selfie holding your ID.');

      PAYSLIP_FIELDS.forEach((field, index) => {
        const file = files[field];
        if (!file) {
          issues.push(`Upload Payslip ${index + 1}.`);
          return;
        }
        if (isPayslipImage(file) && !String(payslipAmounts[field] || '').trim()) {
          issues.push(`Enter the Rand amount for Payslip ${index + 1} because JPEG payslips are captured manually.`);
        }
      });
    }

    return issues;
  };

  const openValidationPopup = (issues) => {
    setValidationIssues(issues);
    if (issues.length) toast.error('Please fix the highlighted requirements');
  };

  const validateStep = () => {
    const issues = buildStepIssues();
    if (issues.length) {
      openValidationPopup(issues);
      return false;
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
      PAYSLIP_FIELDS.forEach((field, index) => {
        if (payslipAmounts[field]) fd.append(`payslip_amount_${index + 1}`, payslipAmounts[field]);
      });
      await signup(fd);
      toast.success('Account created and full application submitted. We are reviewing your documents now.');
      nav('/dashboard');
    } catch (error) {
      const backendIssues = error.response?.data?.errors?.map((item) => item.msg)
        || (error.response?.data?.error ? [error.response.data.error] : ['Sign up failed']);
      openValidationPopup(backendIssues);
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
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>What you need for this step</strong>
                <div className="muted text-sm mt-1">Use your real name, a working email address, a WhatsApp number, your ID / passport / asylum number, and a password with at least 6 characters.</div>
              </div>
              <div className="field"><label className="label">Full name *</label><input required value={form.full_name} onChange={f('full_name')} placeholder="Thabo Mokoena" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">Email *</label><input type="email" required value={form.email} onChange={f('email')} /></div>
                <div className="field"><label className="label">Phone (WhatsApp) *</label><input type="tel" autoComplete="tel" inputMode="tel" required value={form.phone} onChange={setPhoneField('phone')} placeholder="+27 82 123 4567" /></div>
              </div>
              <div className="grid grid-2">
                <div className="field"><label className="label">ID number / Passport / Asylum number *</label><input required value={form.id_number} onChange={f('id_number')} placeholder="Enter your ID, passport, or asylum number" /></div>
                <div className="field"><label className="label">Date of birth</label><input type="date" value={form.date_of_birth} onChange={f('date_of_birth')} /></div>
              </div>
              <div className="field"><label className="label">Password *</label><input type="password" required minLength={6} value={form.password} onChange={f('password')} /></div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>Address help</strong>
                <div className="muted text-sm mt-1">Add the address where you stay most of the time so support, verification, and recovery teams can reach the right area.</div>
              </div>
              <div className="field"><label className="label">Street address *</label><input value={form.address} onChange={f('address')} placeholder="123 Main Road" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">City *</label>
                  <select value={form.city} onChange={f('city')}>
                    <option value="">Select city</option>
                    {southAfricanCities.map((city) => <option key={city} value={city}>{city}</option>)}
                  </select>
                </div>
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
                <div className="field"><label className="label">Phone</label><input type="tel" autoComplete="tel" inputMode="tel" value={form.emergency_contact_phone} onChange={setPhoneField('emergency_contact_phone')} placeholder="+27 81 234 5678" /></div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>Application help</strong>
                <div className="muted text-sm mt-1">Choose a bike, tell us which delivery platforms you use, and add payout details. If you choose EFT, all banking fields are required.</div>
              </div>
              <div className="grid grid-2">
                <div className="field"><label className="label">Preferred bike *</label>
                  <select value={form.preferred_bike_id} onChange={f('preferred_bike_id')}>
                    <option value="">— Select a bike —</option>
                    {bikes.map((bike) => (
                      <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.registration || 'No reg'} · {fmt(bike.rental_weekly)}/week</option>
                    ))}
                  </select>
                </div>
                <div className="card" style={{ background: 'var(--surface-2)', alignSelf: 'end' }}>
                  <strong>Weekly fee</strong>
                  <div className="muted text-sm mt-1">Ready-to-go bikes display their weekly rental amount and registration in the list.</div>
                </div>
              </div>

              {selectedBike && (
                <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                  <div className="flex-between"><span className="muted">Selected bike</span><strong>{selectedBike.make} {selectedBike.model}</strong></div>
                  <div className="flex-between"><span className="muted">Registration</span><strong>{selectedBike.registration || 'Pending registration'}</strong></div>
                  <div className="flex-between"><span className="muted">Weekly amount</span><strong>{fmt(selectedBike.rental_weekly)}</strong></div>
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
                <div className="field"><label className="label">E-wallet number *</label><input type="tel" autoComplete="tel" inputMode="tel" value={form.ewallet_number} onChange={setPhoneField('ewallet_number')} placeholder="Cellphone number for wallet payouts" /></div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>Required uploads</strong>
                <div className="muted text-sm mt-1">Upload all KYC documents now. ID document, driver's licence, and selfie may be PDF or image files. Payslips may be uploaded as PDF or JPG / JPEG. If you upload a JPG / JPEG payslip, you must type the Rand amount for that image manually.</div>
              </div>
              <div className="grid grid-2">
                <UploadField label="ID document *" file={files.id_document} onChange={(file) => setFile('id_document', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" helpText="PDF, JPG, PNG, or WEBP" />
                <UploadField label="Driver's licence *" file={files.drivers_license} onChange={(file) => setFile('drivers_license', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" helpText="PDF, JPG, PNG, or WEBP" />
                <UploadField label="Selfie holding ID *" file={files.selfie} onChange={(file) => setFile('selfie', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" helpText="PDF, JPG, PNG, or WEBP" />
                <div className="card" style={{ background: 'var(--surface-2)' }}>
                  <strong>Auto-decision rule</strong>
                  <div className="muted text-sm mt-2">OnFleet reads the 3 latest payslips, totals the paid amounts, and computes average weekly earnings. Below R1000/week = auto-decline with 2-week retry. R1000/week or more = auto-pre-approval.</div>
                </div>
                <PayslipUploadField label="Payslip 1 *" file={files.payslip_1} amount={payslipAmounts.payslip_1} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_1: value }))} onChange={(file) => setPayslipFile('payslip_1', file)} />
                <PayslipUploadField label="Payslip 2 *" file={files.payslip_2} amount={payslipAmounts.payslip_2} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_2: value }))} onChange={(file) => setPayslipFile('payslip_2', file)} />
                <PayslipUploadField label="Payslip 3 *" file={files.payslip_3} amount={payslipAmounts.payslip_3} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_3: value }))} onChange={(file) => setPayslipFile('payslip_3', file)} />
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

      {!!validationIssues.length && (
        <Modal title="Please fix these items" onClose={() => setValidationIssues([])}>
          <div className="muted text-sm mb-3">Your application cannot continue until the required information below is completed correctly.</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {validationIssues.map((issue, index) => <li key={`${issue}-${index}`} style={{ marginBottom: 8 }}>{issue}</li>)}
          </ul>
          <div className="row mt-4">
            <button type="button" className="btn" onClick={() => setValidationIssues([])}>Ok, I will fix it</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UploadField({ label, file, onChange, accept, helpText }) {
  return (
    <label className="card" style={{ background: 'var(--surface-2)', cursor: 'pointer' }}>
      <strong>{label}</strong>
      {helpText && <div className="muted text-sm mt-1">{helpText}</div>}
      <div className="muted text-sm mt-2">{file ? file.name : 'Choose file'}</div>
      <div className="mt-3"><span className="btn btn-secondary btn-sm">Select file</span></div>
      <input hidden type="file" accept={accept} onChange={(e) => onChange(e.target.files?.[0] || null)} />
    </label>
  );
}

function PayslipUploadField({ label, file, amount, onAmountChange, onChange }) {
  const imagePayslip = isPayslipImage(file);
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <strong>{label}</strong>
      <div className="muted text-sm mt-1">Upload PDF for automatic reading, or JPG / JPEG and type the Rand amount manually.</div>
      <div className="muted text-sm mt-2">{file ? file.name : 'Choose file'}</div>
      <div className="mt-3">
        <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
          Select file
          <input hidden type="file" accept="application/pdf,image/jpeg,image/jpg" onChange={(e) => onChange(e.target.files?.[0] || null)} />
        </label>
      </div>
      {imagePayslip && (
        <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
          <label className="label">Rand amount *</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => onAmountChange(e.target.value)} placeholder="Example: 3200" />
          <div className="muted text-sm mt-1">JPEG payslips are saved with the amount you type here.</div>
        </div>
      )}
    </div>
  );
}

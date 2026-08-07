import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { useAuth } from '../auth';
import api from '../api';
import toast from 'react-hot-toast';
import Logo from '../components/Logo';
import LanguageSwitcher from '../components/LanguageSwitcher';
import southAfricanCities from '../constants/southAfricanCities';
import { fmt, normalizePhoneInput, Modal } from '../components/ui';
import { trackAnalyticsEvent } from '../analytics';

const PLATFORMS = ['Uber Eats', 'Mr D', 'Bolt Food', 'Takealot', 'Checkers Sixty60', 'Other'];
const PROVINCES = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape'];
const PAYSLIP_FIELDS = ['payslip_1', 'payslip_2', 'payslip_3'];

function isPayslipImage(file) {
  return ['image/jpeg', 'image/jpg'].includes(String(file?.type || '').toLowerCase());
}

export default function Signup() {
  const { t } = useTranslation();
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
      if (!form.full_name.trim()) issues.push(t('validation.enterFullName'));
      if (!form.email.trim()) issues.push(t('validation.enterEmail'));
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) issues.push(t('validation.validEmail'));
      if (!form.phone.trim()) issues.push(t('validation.enterPhone'));
      if (!form.id_number.trim()) issues.push(t('validation.enterIdNumber'));
      if (!form.password) issues.push(t('validation.createPassword'));
      else if (form.password.length < 6) issues.push(t('validation.passwordLength'));
    }

    if (step === 2) {
      if (!form.address.trim()) issues.push(t('validation.enterAddress'));
      if (!form.city.trim()) issues.push(t('validation.chooseCity'));
      if (!form.province.trim()) issues.push(t('validation.chooseProvince'));
    }

    if (step === 3) {
      if (!form.preferred_bike_id) issues.push(t('validation.choosePreferredBike'));
      if (!form.delivery_platforms.length) issues.push(t('validation.selectPlatform'));
      if (form.payout_preference === 'eft') {
        if (!form.bank_name.trim()) issues.push(t('validation.enterBankName'));
        if (!form.account_holder.trim()) issues.push(t('validation.enterAccountHolder'));
        if (!form.account_number.trim()) issues.push(t('validation.enterAccountNumber'));
        if (!form.branch_code.trim()) issues.push(t('validation.enterBranchCode'));
      }
      if (form.payout_preference === 'ewallet' && !form.ewallet_number.trim()) {
        issues.push(t('validation.enterEwalletNumber'));
      }
    }

    if (step === 4) {
      if (!files.id_document) issues.push(t('validation.uploadIdDocument'));
      if (!files.drivers_license) issues.push(t('validation.uploadDriversLicense'));
      if (!files.selfie) issues.push(t('validation.uploadSelfie'));

      PAYSLIP_FIELDS.forEach((field, index) => {
        const file = files[field];
        if (!file) {
          issues.push(t('validation.uploadPayslip', { n: index + 1 }));
          return;
        }
        if (isPayslipImage(file) && !String(payslipAmounts[field] || '').trim()) {
          issues.push(t('validation.enterPayslipAmount', { n: index + 1 }));
        }
      });
    }

    return issues;
  };

  const openValidationPopup = (issues) => {
    setValidationIssues(issues);
    if (issues.length) {
      trackAnalyticsEvent('signup_validation_error', {
        signup_step: step,
        issue_count: issues.length
      });
      toast.error(t('signup.fixHighlighted'));
    }
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
      trackAnalyticsEvent('signup_submit_attempt', {
        signup_step: step,
        selected_bike: form.preferred_bike_id || undefined,
        payout_preference: form.payout_preference,
        jpeg_payslip_count: PAYSLIP_FIELDS.filter((field) => isPayslipImage(files[field])).length
      });
      await signup(fd);
      toast.success(t('signup.successToast'));
      nav('/dashboard');
    } catch (error) {
      const backendIssues = error.response?.data?.errors?.map((item) => item.msg)
        || (error.response?.data?.error ? [error.response.data.error] : [t('signup.signupFailed')]);
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
          <div className="auth-tagline">{t('signup.tagline1')}<br /><span>{t('signup.tagline2')}</span></div>
          <p className="muted" style={{ maxWidth: 440 }}>{t('signup.heroDesc')}</p>
        </div>
        <div className="muted text-sm">{t('signup.stepOf', { step })}</div>
      </div>

      <div className="auth-form">
        <div className="flex-between" style={{ alignItems: 'flex-start' }}>
          <h1>{t('signup.title')}</h1>
          <LanguageSwitcher style={{ marginTop: 4 }} />
        </div>
        <div className="sub">{t('signup.subtitle')}</div>

        <form onSubmit={submit}>
          {step === 1 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>{t('signup.step1HelpTitle')}</strong>
                <div className="muted text-sm mt-1">{t('signup.step1Help')}</div>
              </div>
              <div className="field"><label className="label">{t('fields.fullName')}</label><input required value={form.full_name} onChange={f('full_name')} placeholder={t('fields.fullNamePlaceholder')} /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.email')}</label><input type="email" required value={form.email} onChange={f('email')} /></div>
                <div className="field"><label className="label">{t('fields.phone')}</label><input type="tel" autoComplete="tel" inputMode="tel" required value={form.phone} onChange={setPhoneField('phone')} placeholder={t('fields.phonePlaceholder')} /></div>
              </div>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.idNumber')}</label><input required value={form.id_number} onChange={f('id_number')} placeholder={t('fields.idNumberPlaceholder')} /></div>
                <div className="field"><label className="label">{t('fields.dob')}</label><input type="date" value={form.date_of_birth} onChange={f('date_of_birth')} /></div>
              </div>
              <div className="field"><label className="label">{t('fields.password')}</label><input type="password" required minLength={6} value={form.password} onChange={f('password')} /></div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>{t('signup.step2HelpTitle')}</strong>
                <div className="muted text-sm mt-1">{t('signup.step2Help')}</div>
              </div>
              <div className="field"><label className="label">{t('fields.streetAddress')}</label><input value={form.address} onChange={f('address')} placeholder={t('fields.streetAddressPlaceholder')} /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.city')}</label>
                  <select value={form.city} onChange={f('city')}>
                    <option value="">{t('common.selectCity')}</option>
                    {southAfricanCities.map((city) => <option key={city} value={city}>{city}</option>)}
                  </select>
                </div>
                <div className="field"><label className="label">{t('fields.postalCode')}</label><input value={form.postal_code} onChange={f('postal_code')} /></div>
              </div>
              <div className="field"><label className="label">{t('fields.province')}</label>
                <select value={form.province} onChange={f('province')}>
                  {PROVINCES.map((province) => <option key={province}>{province}</option>)}
                </select>
              </div>
              <h3 className="mt-4 mb-2">{t('fields.emergencyContact')}</h3>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.emergencyName')}</label><input value={form.emergency_contact_name} onChange={f('emergency_contact_name')} /></div>
                <div className="field"><label className="label">{t('fields.emergencyPhone')}</label><input type="tel" autoComplete="tel" inputMode="tel" value={form.emergency_contact_phone} onChange={setPhoneField('emergency_contact_phone')} placeholder={t('fields.emergencyPhonePlaceholder')} /></div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>{t('signup.step3HelpTitle')}</strong>
                <div className="muted text-sm mt-1">{t('signup.step3Help')}</div>
              </div>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.preferredBike')}</label>
                  <select value={form.preferred_bike_id} onChange={f('preferred_bike_id')}>
                    <option value="">{t('common.selectBikePlaceholder')}</option>
                    {bikes.map((bike) => (
                      <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.registration || t('common.noReg')} · {fmt(bike.rental_weekly)}{t('common.perWeek')}</option>
                    ))}
                  </select>
                </div>
                <div className="card" style={{ background: 'var(--surface-2)', alignSelf: 'end' }}>
                  <strong>{t('signup.weeklyFeeTitle')}</strong>
                  <div className="muted text-sm mt-1">{t('signup.weeklyFeeDesc')}</div>
                </div>
              </div>

              {selectedBike && (
                <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                  <div className="flex-between"><span className="muted">{t('fields.selectedBike')}</span><strong>{selectedBike.make} {selectedBike.model}</strong></div>
                  <div className="flex-between"><span className="muted">{t('fields.registration')}</span><strong>{selectedBike.registration || t('fields.pendingRegistration')}</strong></div>
                  <div className="flex-between"><span className="muted">{t('fields.weeklyAmount')}</span><strong>{fmt(selectedBike.rental_weekly)}</strong></div>
                </div>
              )}

              <div className="field"><label className="label">{t('fields.deliveryPlatforms')}</label>
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
                <div className="field"><label className="label">{t('fields.yearsRiding')}</label><input type="number" min="0" value={form.years_riding} onChange={f('years_riding')} /></div>
                <div className="field"><label className="label">{t('fields.hasLicense')}</label>
                  <select value={form.has_drivers_license ? '1' : '0'} onChange={(e) => setForm({ ...form, has_drivers_license: e.target.value === '1' })}>
                    <option value="1">{t('common.yes')}</option>
                    <option value="0">{t('common.no')}</option>
                  </select>
                </div>
              </div>

              <div className="field"><label className="label">{t('fields.payoutPreference')}</label>
                <select value={form.payout_preference} onChange={f('payout_preference')}>
                  <option value="eft">{t('fields.eftOption')}</option>
                  <option value="ewallet">{t('fields.ewalletOption')}</option>
                </select>
              </div>

              {form.payout_preference === 'eft' ? (
                <div className="grid grid-2">
                  <div className="field"><label className="label">{t('fields.bankName')}</label><input value={form.bank_name} onChange={f('bank_name')} /></div>
                  <div className="field"><label className="label">{t('fields.accountHolder')}</label><input value={form.account_holder} onChange={f('account_holder')} /></div>
                  <div className="field"><label className="label">{t('fields.accountNumber')}</label><input value={form.account_number} onChange={f('account_number')} /></div>
                  <div className="field"><label className="label">{t('fields.branchCode')}</label><input value={form.branch_code} onChange={f('branch_code')} /></div>
                </div>
              ) : (
                <div className="field"><label className="label">{t('fields.ewalletNumber')}</label><input type="tel" autoComplete="tel" inputMode="tel" value={form.ewallet_number} onChange={setPhoneField('ewallet_number')} placeholder={t('fields.ewalletPlaceholder')} /></div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>{t('signup.step4HelpTitle')}</strong>
                <div className="muted text-sm mt-1">{t('signup.step4Help')}</div>
              </div>
              <div className="grid grid-2">
                <UploadField label={t('fields.idDocument')} file={files.id_document} onChange={(file) => setFile('id_document', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" helpText={t('fields.fileHelpText')} />
                <UploadField label={t('fields.driversLicense')} file={files.drivers_license} onChange={(file) => setFile('drivers_license', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" helpText={t('fields.fileHelpText')} />
                <UploadField label={t('fields.selfie')} file={files.selfie} onChange={(file) => setFile('selfie', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" helpText={t('fields.fileHelpText')} />
                <div className="card" style={{ background: 'var(--surface-2)' }}>
                  <strong>{t('signup.autoDecisionTitle')}</strong>
                  <div className="muted text-sm mt-2">{t('signup.autoDecisionDesc')}</div>
                </div>
                <PayslipUploadField label={t('signup.payslipLabel', { n: 1 })} helpText={t('signup.payslipHelp')} randLabel={t('fields.randAmount')} randPlaceholder={t('fields.randAmountPlaceholder')} randHelp={t('signup.randAmountHelp')} file={files.payslip_1} amount={payslipAmounts.payslip_1} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_1: value }))} onChange={(file) => setPayslipFile('payslip_1', file)} />
                <PayslipUploadField label={t('signup.payslipLabel', { n: 2 })} helpText={t('signup.payslipHelp')} randLabel={t('fields.randAmount')} randPlaceholder={t('fields.randAmountPlaceholder')} randHelp={t('signup.randAmountHelp')} file={files.payslip_2} amount={payslipAmounts.payslip_2} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_2: value }))} onChange={(file) => setPayslipFile('payslip_2', file)} />
                <PayslipUploadField label={t('signup.payslipLabel', { n: 3 })} helpText={t('signup.payslipHelp')} randLabel={t('fields.randAmount')} randPlaceholder={t('fields.randAmountPlaceholder')} randHelp={t('signup.randAmountHelp')} file={files.payslip_3} amount={payslipAmounts.payslip_3} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_3: value }))} onChange={(file) => setPayslipFile('payslip_3', file)} />
              </div>
            </>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            {step > 1 && <button type="button" className="btn btn-secondary" onClick={() => setStep(step - 1)}>{t('common.back')}</button>}
            {step < 4 ? (
              <button type="button" className="btn btn-block" onClick={() => validateStep() && setStep(step + 1)}>{t('common.continue')}</button>
            ) : (
              <button className="btn btn-block" disabled={busy}>{busy ? t('signup.submitting') : t('signup.submitButton')}</button>
            )}
          </div>
        </form>

        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>
          {t('signup.alreadyHaveAccount')} <Link to="/login">{t('common.signIn')}</Link>
        </div>
      </div>

      {!!validationIssues.length && (
        <Modal title={t('signup.modalTitle')} onClose={() => setValidationIssues([])}>
          <div className="muted text-sm mb-3">{t('signup.modalDesc')}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {validationIssues.map((issue, index) => <li key={`${issue}-${index}`} style={{ marginBottom: 8 }}>{issue}</li>)}
          </ul>
          <div className="row mt-4">
            <button type="button" className="btn" onClick={() => setValidationIssues([])}>{t('signup.okFixIt')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UploadField({ label, file, onChange, accept, helpText }) {
  const { t } = useTranslation();
  return (
    <label className="card" style={{ background: 'var(--surface-2)', cursor: 'pointer' }}>
      <strong>{label}</strong>
      {helpText && <div className="muted text-sm mt-1">{helpText}</div>}
      <div className="muted text-sm mt-2">{file ? file.name : t('common.chooseFile')}</div>
      <div className="mt-3"><span className="btn btn-secondary btn-sm">{t('common.selectFile')}</span></div>
      <input hidden type="file" accept={accept} onChange={(e) => onChange(e.target.files?.[0] || null)} />
    </label>
  );
}

function PayslipUploadField({ label, file, amount, onAmountChange, onChange, helpText, randLabel, randPlaceholder, randHelp }) {
  const { t } = useTranslation();
  const imagePayslip = isPayslipImage(file);
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <strong>{label}</strong>
      <div className="muted text-sm mt-1">{helpText}</div>
      <div className="muted text-sm mt-2">{file ? file.name : t('common.chooseFile')}</div>
      <div className="mt-3">
        <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
          {t('common.selectFile')}
          <input hidden type="file" accept="application/pdf,image/jpeg,image/jpg" onChange={(e) => onChange(e.target.files?.[0] || null)} />
        </label>
      </div>
      {imagePayslip && (
        <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
          <label className="label">{randLabel}</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => onAmountChange(e.target.value)} placeholder={randPlaceholder} />
          <div className="muted text-sm mt-1">{randHelp}</div>
        </div>
      )}
    </div>
  );
}

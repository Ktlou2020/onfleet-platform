import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';
import toast from 'react-hot-toast';
import api from '../api';
import Logo from '../components/Logo';
import LanguageSwitcher from '../components/LanguageSwitcher';
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
  const { t } = useTranslation();
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
        toast.error(error.response?.data?.error || t('fleetApply.errCouldNotOpen'));
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
        toast.error(t('fleetApply.errCompletePersonal'));
        return false;
      }
      return true;
    }
    if (step === 2) {
      if (!form.address || !form.city || !form.province) {
        toast.error(t('fleetApply.errCompleteAddress'));
        return false;
      }
      return true;
    }
    if (step === 3) {
      if (!form.preferred_bike_id) {
        toast.error(t('fleetApply.errChooseBike'));
        return false;
      }
      if (!form.delivery_platforms.length) {
        toast.error(t('fleetApply.errSelectPlatform'));
        return false;
      }
      if (form.payout_preference === 'eft' && (!form.bank_name || !form.account_holder || !form.account_number || !form.branch_code)) {
        toast.error(t('fleetApply.errEftDetails'));
        return false;
      }
      if (form.payout_preference === 'ewallet' && !form.ewallet_number) {
        toast.error(t('fleetApply.errEwallet'));
        return false;
      }
      return true;
    }
    const missing = Object.entries(files).filter(([, file]) => !file);
    if (missing.length) {
      toast.error(t('fleetApply.errUploadAll'));
      return false;
    }
    for (const field of ['payslip_1', 'payslip_2', 'payslip_3']) {
      const file = files[field];
      if (file && file.type !== 'application/pdf' && !String(payslipAmounts[field] || '').trim()) {
        const n = Number(field.slice(-1));
        toast.error(t('fleetApply.errPayslipAmount', { n }));
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
      toast.success(t('fleetApply.successToast'));
      setForm(buildInitialForm());
      setFiles(buildInitialFiles());
      setPayslipAmounts({ payslip_1: '', payslip_2: '', payslip_3: '' });
      setStep(1);
    } catch (error) {
      toast.error(error.response?.data?.error || t('fleetApply.errSubmitFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="center-flex"><div className="spinner" /></div>;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <Logo />
        <div>
          <div style={{ fontWeight: 700 }}>{organization?.name || 'OnFleet Africa'}</div>
          {organization?.city && <div className="text-xs muted">{organization.city}</div>}
        </div>
        <LanguageSwitcher style={{ marginLeft: 'auto' }} />
      </div>

      {bikes.length > 0 && (
        <div style={{ padding: '32px 24px', maxWidth: 1080, margin: '0 auto' }}>
          <h2 style={{ marginBottom: 4 }}>{t('fleetApply.availableBikes')}</h2>
          <p className="muted text-sm" style={{ marginBottom: 24 }}>{t('fleetApply.availableBikesDesc', { fleetName: organization?.name || 'this fleet' })}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {bikes.map((bike) => (
              <div key={bike.id} className="card" style={{ padding: 0, overflow: 'hidden', cursor: 'pointer', border: String(form.preferred_bike_id) === String(bike.id) ? '2px solid var(--primary)' : '1px solid var(--border)' }} onClick={() => { setForm((f) => ({ ...f, preferred_bike_id: String(bike.id) })); setStep(1); }}>
                {bike.image_url ? (
                  <img src={bike.image_url} alt={`${bike.make} ${bike.model}`} style={{ width: '100%', height: 160, objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: 120, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 40 }}>🏍️</span>
                  </div>
                )}
                <div style={{ padding: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{bike.make} {bike.model}</div>
                  {bike.year && <div className="text-xs muted">{bike.year}{bike.engine_cc ? ` · ${bike.engine_cc}cc` : ''}</div>}
                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700, color: 'var(--primary)', fontSize: 18 }}>{fmt(bike.rental_weekly)}<span className="muted text-xs">{t('common.perWeek')}</span></div>
                      {bike.total_weeks && <div className="text-xs muted">{t('fleetApply.ownInWeeks', { weeks: bike.total_weeks })}</div>}
                    </div>
                    {String(form.preferred_bike_id) === String(bike.id) && (
                      <span style={{ padding: '4px 10px', borderRadius: 100, fontSize: 11, fontWeight: 700, background: 'rgba(30,136,209,0.15)', color: 'var(--primary)' }}>{t('common.selected')}</span>
                    )}
                  </div>
                  {bike.registration && <div className="text-xs muted mt-1">{t('fields.registration')}: {bike.registration}</div>}
                  {bike.condition && <div className="text-xs muted">{bike.condition}</div>}
                </div>
              </div>
            ))}
          </div>
          <div className="muted text-sm" style={{ marginTop: 12 }}>{t('fleetApply.clickToSelect')}</div>
        </div>
      )}

      <div style={{ padding: '0 24px 48px', maxWidth: 540, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <h2>{t('fleetApply.title')}</h2>
          <div className="muted text-sm">{t('fleetApply.fleetLine', { fleetName: organization?.name || '—' })}{organization?.city ? ` · ${organization.city}` : ''} · {t('fleetApply.stepOf', { step })}</div>
        </div>

        <form onSubmit={submit} className="auth-form" style={{ maxWidth: '100%', padding: 0 }}>
          {step === 1 && (
            <>
              <div className="field"><label className="label">{t('fields.fullName')}</label><input required value={form.full_name} onChange={setText('full_name')} placeholder={t('fields.fullNamePlaceholder')} /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.email')}</label><input type="email" required value={form.email} onChange={setText('email')} /></div>
                <div className="field"><label className="label">{t('fields.phone')}</label><input type="tel" required value={form.phone} onChange={setPhone('phone')} placeholder={t('fields.phonePlaceholder')} /></div>
              </div>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.idNumber')}</label><input required value={form.id_number} onChange={setText('id_number')} /></div>
                <div className="field"><label className="label">{t('fields.dob')}</label><input type="date" value={form.date_of_birth} onChange={setText('date_of_birth')} /></div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="field"><label className="label">{t('fields.streetAddress')}</label><input value={form.address} onChange={setText('address')} placeholder={t('fields.streetAddressPlaceholder')} /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.city')}</label><select value={form.city} onChange={setText('city')}><option value="">{t('common.selectCity')}</option>{southAfricanCities.map((city) => <option key={city} value={city}>{city}</option>)}</select></div>
                <div className="field"><label className="label">{t('fields.postalCode')}</label><input value={form.postal_code} onChange={setText('postal_code')} /></div>
              </div>
              <div className="field"><label className="label">{t('fields.province')}</label><select value={form.province} onChange={setText('province')}>{PROVINCES.map((province) => <option key={province} value={province}>{province}</option>)}</select></div>
              <h3 className="mt-4 mb-2">{t('fields.emergencyContact')}</h3>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.emergencyName')}</label><input value={form.emergency_contact_name} onChange={setText('emergency_contact_name')} /></div>
                <div className="field"><label className="label">{t('fields.emergencyPhone')}</label><input type="tel" value={form.emergency_contact_phone} onChange={setPhone('emergency_contact_phone')} placeholder={t('fields.emergencyPhonePlaceholder')} /></div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-2">
                <div className="field"><label className="label">{t('fields.preferredBike')}</label><select value={form.preferred_bike_id} onChange={setText('preferred_bike_id')}><option value="">{t('common.selectBikePlaceholder')}</option>{bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {bike.registration || t('common.noReg')} · {fmt(bike.rental_weekly)}{t('common.perWeek')}</option>)}</select></div>
                <div className="card" style={{ background: 'var(--surface-2)', alignSelf: 'end' }}><strong>{t('fleetApply.bikeAvailabilityTitle')}</strong><div className="muted text-sm mt-1">{t('fleetApply.bikeAvailabilityDesc')}</div></div>
              </div>

              {selectedBike ? (
                <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                  <div className="flex-between"><span className="muted">{t('fields.selectedBike')}</span><strong>{selectedBike.make} {selectedBike.model}</strong></div>
                  <div className="flex-between"><span className="muted">{t('fields.registration')}</span><strong>{selectedBike.registration || t('fields.pendingRegistration')}</strong></div>
                  <div className="flex-between"><span className="muted">{t('fields.weeklyAmount')}</span><strong>{fmt(selectedBike.rental_weekly)}</strong></div>
                </div>
              ) : null}

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
                <div className="field"><label className="label">{t('fields.yearsRiding')}</label><input type="number" min="0" value={form.years_riding} onChange={setText('years_riding')} /></div>
                <div className="field"><label className="label">{t('fields.hasLicense')}</label><select value={form.has_drivers_license ? '1' : '0'} onChange={(event) => setForm((current) => ({ ...current, has_drivers_license: event.target.value === '1' }))}><option value="1">{t('common.yes')}</option><option value="0">{t('common.no')}</option></select></div>
              </div>

              <div className="field"><label className="label">{t('fields.payoutPreference')}</label><select value={form.payout_preference} onChange={setText('payout_preference')}><option value="eft">{t('fields.eftOption')}</option><option value="ewallet">{t('fields.ewalletOption')}</option></select></div>

              {form.payout_preference === 'eft' ? (
                <div className="grid grid-2">
                  <div className="field"><label className="label">{t('fields.bankName')}</label><input value={form.bank_name} onChange={setText('bank_name')} /></div>
                  <div className="field"><label className="label">{t('fields.accountHolder')}</label><input value={form.account_holder} onChange={setText('account_holder')} /></div>
                  <div className="field"><label className="label">{t('fields.accountNumber')}</label><input value={form.account_number} onChange={setText('account_number')} /></div>
                  <div className="field"><label className="label">{t('fields.branchCode')}</label><input value={form.branch_code} onChange={setText('branch_code')} /></div>
                </div>
              ) : (
                <div className="field"><label className="label">{t('fields.ewalletNumber')}</label><input value={form.ewallet_number} onChange={setPhone('ewallet_number')} placeholder={t('fields.ewalletPlaceholder')} /></div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
                <strong>{t('fleetApply.step4HelpTitle')}</strong>
                <div className="muted text-sm mt-1">{t('fleetApply.step4Help')}</div>
              </div>
              <div className="grid grid-2">
                <UploadField label={t('fields.idDocument')} file={files.id_document} onChange={(file) => setFile('id_document', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.heic,.heif" />
                <UploadField label={t('fields.driversLicense')} file={files.drivers_license} onChange={(file) => setFile('drivers_license', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.heic,.heif" />
                <UploadField label={t('fields.selfie')} file={files.selfie} onChange={(file) => setFile('selfie', file)} accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.heic,.heif" />
                <div className="card" style={{ background: 'var(--surface-2)' }}>
                  <strong>{t('fleetApply.autoDecisionTitle')}</strong>
                  <div className="muted text-sm mt-2">{t('fleetApply.autoDecisionDesc')}</div>
                </div>
                <PayslipUploadField label={t('fleetApply.payslipLabel', { n: 1 })} monthlyLabel={t('fleetApply.monthlyAmountLabel')} monthlyPlaceholder={t('fleetApply.monthlyAmountPlaceholder')} file={files.payslip_1} amount={payslipAmounts.payslip_1} onFileChange={(file) => { setFile('payslip_1', file); setPayslipAmounts((current) => ({ ...current, payslip_1: '' })); }} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_1: value }))} />
                <PayslipUploadField label={t('fleetApply.payslipLabel', { n: 2 })} monthlyLabel={t('fleetApply.monthlyAmountLabel')} monthlyPlaceholder={t('fleetApply.monthlyAmountPlaceholder')} file={files.payslip_2} amount={payslipAmounts.payslip_2} onFileChange={(file) => { setFile('payslip_2', file); setPayslipAmounts((current) => ({ ...current, payslip_2: '' })); }} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_2: value }))} />
                <PayslipUploadField label={t('fleetApply.payslipLabel', { n: 3 })} monthlyLabel={t('fleetApply.monthlyAmountLabel')} monthlyPlaceholder={t('fleetApply.monthlyAmountPlaceholder')} file={files.payslip_3} amount={payslipAmounts.payslip_3} onFileChange={(file) => { setFile('payslip_3', file); setPayslipAmounts((current) => ({ ...current, payslip_3: '' })); }} onAmountChange={(value) => setPayslipAmounts((current) => ({ ...current, payslip_3: value }))} />
              </div>
            </>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            {step > 1 && <button type="button" className="btn btn-secondary" onClick={() => setStep(step - 1)}>{t('common.back')}</button>}
            {step < 4 ? (
              <button type="button" className="btn btn-block" onClick={() => validateStep() && setStep(step + 1)}>{t('common.continue')}</button>
            ) : (
              <button className="btn btn-block" disabled={busy}>{busy ? t('fleetApply.submitting') : t('fleetApply.submitButton')}</button>
            )}
          </div>
        </form>

        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>
          {t('fleetApply.alreadyHaveAccount')} <Link to="/login">{t('common.signIn')}</Link>
        </div>
      </div>
    </div>
  );
}

function UploadField({ label, file, onChange, accept }) {
  const { t } = useTranslation();
  return (
    <label className="card" style={{ background: 'var(--surface-2)', cursor: 'pointer' }}>
      <strong>{label}</strong>
      <div className="muted text-sm mt-2">{file ? file.name : t('common.chooseFile')}</div>
      <div className="mt-3"><span className="btn btn-secondary btn-sm">{t('common.selectFile')}</span></div>
      <input hidden type="file" accept={accept} onChange={(event) => onChange(event.target.files?.[0] || null)} />
    </label>
  );
}

function PayslipUploadField({ label, file, amount, onFileChange, onAmountChange, monthlyLabel, monthlyPlaceholder }) {
  const { t } = useTranslation();
  const needsAmount = file && file.type !== 'application/pdf';
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <label style={{ cursor: 'pointer' }}>
        <strong>{label}</strong>
        <div className="muted text-sm mt-2">{file ? file.name : t('common.chooseFile')}</div>
        <div className="mt-3"><span className="btn btn-secondary btn-sm">{t('common.selectFile')}</span></div>
        <input hidden type="file" accept="application/pdf,image/*,.doc,.docx,.heic" onChange={(event) => onFileChange(event.target.files?.[0] || null)} />
      </label>
      {needsAmount && (
        <div className="field mt-3">
          <label className="label">{monthlyLabel}</label>
          <input type="number" min="0" step="0.01" placeholder={monthlyPlaceholder} value={amount} onChange={(event) => onAmountChange(event.target.value)} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

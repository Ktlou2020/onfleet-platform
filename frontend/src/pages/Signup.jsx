import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { useAuth } from '../auth';
import toast from 'react-hot-toast';
import Logo from '../components/Logo';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { normalizePhoneInput, Modal } from '../components/ui';
import { trackAnalyticsEvent } from '../analytics';

export default function Signup() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', id_number: '', date_of_birth: '', password: '' });
  const [validationIssues, setValidationIssues] = useState([]);
  const [busy, setBusy] = useState(false);
  const { signup } = useAuth();
  const nav = useNavigate();

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setPhoneField = (k) => (e) => setForm({ ...form, [k]: normalizePhoneInput(e.target.value) });

  const buildIssues = () => {
    const issues = [];
    if (!form.full_name.trim()) issues.push(t('validation.enterFullName'));
    if (!form.email.trim()) issues.push(t('validation.enterEmail'));
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) issues.push(t('validation.validEmail'));
    if (!form.phone.trim()) issues.push(t('validation.enterPhone'));
    if (!form.id_number.trim()) issues.push(t('validation.enterIdNumber'));
    if (!form.password) issues.push(t('validation.createPassword'));
    else if (form.password.length < 6) issues.push(t('validation.passwordLength'));
    return issues;
  };

  const openValidationPopup = (issues) => {
    setValidationIssues(issues);
    if (issues.length) {
      trackAnalyticsEvent('signup_validation_error', { issue_count: issues.length });
      toast.error(t('signup.fixHighlighted'));
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    const issues = buildIssues();
    if (issues.length) return openValidationPopup(issues);

    setBusy(true);
    try {
      trackAnalyticsEvent('signup_submit_attempt', {});
      await signup({ ...form, date_of_birth: form.date_of_birth || undefined });
      toast.success(t('signup.successToast'));
      nav('/application');
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
      </div>

      <div className="auth-form">
        <div className="flex-between" style={{ alignItems: 'flex-start' }}>
          <h1>{t('signup.title')}</h1>
          <LanguageSwitcher style={{ marginTop: 4 }} />
        </div>
        <div className="sub">{t('signup.subtitle')}</div>

        <form onSubmit={submit}>
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

          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn btn-block" disabled={busy}>{busy ? t('signup.submitting') : t('signup.submitButton')}</button>
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

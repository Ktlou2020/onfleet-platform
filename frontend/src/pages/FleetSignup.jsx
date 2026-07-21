import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CheckCircle2, Clock } from 'lucide-react';
import Logo from '../components/Logo';
import { useAuth } from '../auth';
import { trackAnalyticsEvent } from '../analytics';

const TRIAL_PERKS = [
  '14 days free — no card required to start',
  'Unlimited agreements and riders during trial',
  'Full access to all fleet management features',
  'Cancel any time, no lock-in',
];

export default function FleetSignup() {
  const { signupFleet } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({
    company_name: '',
    full_name: '',
    email: '',
    password: '',
    phone: '',
    city: '',
    fleet_size: '',
    plan_interest: 'trial',
    role: 'fleet_owner_admin'
  });
  const [busy, setBusy] = useState(false);

  const update = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      trackAnalyticsEvent('fleet_signup_submit_attempt', { fleet_size: Number(form.fleet_size || 0) || 0 });
      const user = await signupFleet({ ...form, fleet_size: Number(form.fleet_size || 0) || 0 });
      toast.success(`Welcome to OnFleet! Your 14-day trial has started.`);
      nav('/fleet/app');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create account — please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size="lg" />
        <div>
          <div className="auth-tagline">Start your free<br /><span>14-day trial.</span></div>
          <p className="muted" style={{ maxWidth: 400, marginBottom: 28 }}>
            Get your fleet set up in minutes. No card required — just create your account and start managing riders and bikes today.
          </p>
          <div style={{ display: 'grid', gap: 14 }}>
            {TRIAL_PERKS.map((perk) => (
              <div key={perk} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <CheckCircle2 size={16} style={{ color: '#10b981', flexShrink: 0, marginTop: 1 }} />
                <span className="text-sm">{perk}</span>
              </div>
            ))}
          </div>
          <div className="card mt-6" style={{ background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.3)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Clock size={15} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
            <div className="text-sm">After your 14-day trial, choose a plan starting from <strong>R200/month</strong> to keep your fleet running.</div>
          </div>
        </div>
        <div className="muted text-sm">© OnFleet Africa · Fleet Owner Portal</div>
      </div>

      <div className="auth-form">
        <h1>Create your fleet account</h1>
        <div className="sub">Your 14-day free trial starts immediately — no card required.</div>
        <form onSubmit={submit}>
          <div className="field">
            <label className="label">Company name</label>
            <input required value={form.company_name} onChange={update('company_name')} placeholder="FastMoto Couriers" />
          </div>
          <div className="field">
            <label className="label">Your full name</label>
            <input required value={form.full_name} onChange={update('full_name')} placeholder="Nomsa Moyo" />
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">Work email</label>
              <input type="email" required value={form.email} onChange={update('email')} placeholder="ops@company.com" />
            </div>
            <div className="field">
              <label className="label">Password</label>
              <input type="password" minLength={6} required value={form.password} onChange={update('password')} placeholder="At least 6 characters" />
            </div>
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">Phone</label>
              <input value={form.phone} onChange={update('phone')} placeholder="+27..." />
            </div>
            <div className="field">
              <label className="label">City</label>
              <input value={form.city} onChange={update('city')} placeholder="Johannesburg" />
            </div>
          </div>
          <div className="field">
            <label className="label">How many bikes in your fleet?</label>
            <input type="number" min="0" value={form.fleet_size} onChange={update('fleet_size')} placeholder="e.g. 12" />
          </div>
          <button className="btn btn-block" disabled={busy} style={{ marginTop: 8 }}>
            {busy ? 'Creating your account…' : 'Start free trial — no card needed'}
          </button>
        </form>
        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>
          Already have an account? <Link to="/fleet/login">Sign in</Link>
        </div>
        <div className="muted text-xs mt-4" style={{ textAlign: 'center' }}>
          By signing up you agree to OnFleet's <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy Policy</Link>.
        </div>
      </div>
    </div>
  );
}

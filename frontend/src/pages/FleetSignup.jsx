import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Briefcase, CreditCard, ShieldCheck, Users } from 'lucide-react';
import Logo from '../components/Logo';
import { useAuth } from '../auth';
import { trackAnalyticsEvent } from '../analytics';

const ROLE_OPTIONS = [
  { value: 'fleet_owner_admin', label: 'Company admin' },
  { value: 'fleet_owner_ops', label: 'Operations lead' },
  { value: 'fleet_owner_billing', label: 'Billing lead' },
  { value: 'fleet_owner_viewer', label: 'Viewer' }
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
    fleet_size: '10',
    plan_interest: 'trial',
    role: 'fleet_owner_admin'
  });
  const [busy, setBusy] = useState(false);

  const update = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      trackAnalyticsEvent('fleet_signup_submit_attempt', {
        requested_role: form.role,
        plan_interest: form.plan_interest,
        fleet_size: Number(form.fleet_size || 0) || 0
      });
      const user = await signupFleet({ ...form, fleet_size: Number(form.fleet_size || 0) || 0 });
      toast.success(`Company account created for ${user.organization_name || form.company_name}`);
      nav('/fleet/app');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create fleet-owner account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size="lg" />
        <div>
          <div className="auth-tagline">Create your company account.<br /><span>Launch your fleet workspace.</span></div>
          <p className="muted" style={{ maxWidth: 430 }}>Start a fleet-owner workspace for your company with company profile setup, role-based access for your team, and flexible plan onboarding.</p>
          <div className="feat-list">
            <div className="feat"><div className="ico"><Briefcase size={16} /></div><div><strong>Company account</strong><div className="muted text-sm">A dedicated workspace tied to your organization</div></div></div>
            <div className="feat"><div className="ico"><Users size={16} /></div><div><strong>Role-based team access</strong><div className="muted text-sm">Admins, ops, billing, and viewers can be added later</div></div></div>
            <div className="feat"><div className="ico"><CreditCard size={16} /></div><div><strong>Trial then billing</strong><div className="muted text-sm">Plan entitlement starts on trial and can move to paid later</div></div></div>
          </div>
        </div>
        <div className="muted text-sm">© OnFleet Africa · Fleet Owner Portal</div>
      </div>

      <div className="auth-form">
        <h1>Create fleet-owner account</h1>
        <div className="sub">This creates your company workspace and your first fleet-owner user.</div>
        <form onSubmit={submit}>
          <div className="field"><label className="label">Company name</label><input required value={form.company_name} onChange={update('company_name')} placeholder="FastMoto Couriers" /></div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Your full name</label><input required value={form.full_name} onChange={update('full_name')} placeholder="Nomsa Moyo" /></div>
            <div className="field"><label className="label">Role</label>
              <select value={form.role} onChange={update('role')}>
                {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Work email</label><input type="email" required value={form.email} onChange={update('email')} placeholder="ops@company.com" /></div>
            <div className="field"><label className="label">Password</label><input type="password" minLength={6} required value={form.password} onChange={update('password')} placeholder="At least 6 characters" /></div>
          </div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Phone</label><input value={form.phone} onChange={update('phone')} placeholder="+27..." /></div>
            <div className="field"><label className="label">City</label><input value={form.city} onChange={update('city')} placeholder="Johannesburg" /></div>
          </div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Current fleet size</label><input type="number" min="0" value={form.fleet_size} onChange={update('fleet_size')} /></div>
            <div className="field"><label className="label">Starting plan</label>
              <select value={form.plan_interest} onChange={update('plan_interest')}>
                <option value="trial">14-day trial</option>
                <option value="small">Small fleet</option>
                <option value="medium">Medium fleet</option>
                <option value="large">Large fleet</option>
                <option value="enterprise">Enterprise+</option>
              </select>
            </div>
          </div>
          <button className="btn btn-block" disabled={busy}>{busy ? 'Creating company account…' : 'Create fleet workspace'}</button>
        </form>
        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>Already have a company account? <Link to="/fleet/login">Sign in</Link></div>
        <div className="card mt-6" style={{ background: 'var(--surface-2)' }}>
          <div className="text-sm"><strong>Access control starts immediately.</strong> Your first user will be provisioned with the selected fleet-owner role.</div>
          <div className="muted text-sm mt-2">Most companies should start with <strong>Company admin</strong> for the first user.</div>
          <div className="mt-3"><Link to="/fleet" className="btn btn-secondary btn-sm"><ShieldCheck size={14} /> Back to fleet overview</Link></div>
        </div>
      </div>
    </div>
  );
}

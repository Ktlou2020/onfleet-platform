import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Briefcase, CreditCard, ShieldCheck, Users } from 'lucide-react';
import Logo from '../components/Logo';
import { useAuth } from '../auth';

export default function FleetLogin() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const user = await login(email, password);
      if (!String(user.role || '').startsWith('fleet_owner_')) {
        toast.error('This login is for fleet-owner accounts only');
        return;
      }
      toast.success(`Welcome back, ${user.full_name.split(' ')[0]}!`);
      nav('/fleet/app');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size="lg" />
        <div>
          <div className="auth-tagline">Operate your fleet.<br /><span>Control every contract.</span></div>
          <p className="muted" style={{ maxWidth: 430 }}>Fleet-owner accounts get a dedicated workspace for bikes, agreements, collections, billing, and company team access.</p>
          <div className="feat-list">
            <div className="feat"><div className="ico"><Briefcase size={16} /></div><div><strong>Company workspace</strong><div className="muted text-sm">One account for your fleet, branches, and operators</div></div></div>
            <div className="feat"><div className="ico"><Users size={16} /></div><div><strong>Role-based access</strong><div className="muted text-sm">Admin, operations, billing, and viewer access levels</div></div></div>
            <div className="feat"><div className="ico"><CreditCard size={16} /></div><div><strong>Trial and billing</strong><div className="muted text-sm">14-day trial with Paystack-ready billing status</div></div></div>
          </div>
        </div>
        <div className="muted text-sm">© OnFleet Africa · Fleet Owner Portal</div>
      </div>

      <div className="auth-form">
        <h1>Fleet-owner sign in</h1>
        <div className="sub">Use your company account to access the OnFleet fleet-owner workspace.</div>
        <form onSubmit={submit}>
          <div className="field"><label className="label">Work email</label><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@company.com" /></div>
          <div className="field"><label className="label">Password</label><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
          <button className="btn btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to fleet workspace'}</button>
        </form>
        <div className="mt-3 text-sm" style={{ textAlign: 'right' }}><Link to="/forgot-password">Forgot password?</Link></div>
        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>Need a company account? <Link to="/fleet/signup">Create one</Link></div>
        <div className="card mt-6" style={{ background: 'var(--surface-2)' }}>
          <div className="text-sm"><strong>Billing reminder.</strong> Fleet-owner access depends on your company trial or subscription status.</div>
          <div className="muted text-sm mt-2">If your plan is suspended, contact the organization admin or settle billing to restore access.</div>
          <div className="mt-3"><Link to="/fleet" className="btn btn-secondary btn-sm"><ShieldCheck size={14} /> View pilot plans</Link></div>
        </div>
      </div>
    </div>
  );
}

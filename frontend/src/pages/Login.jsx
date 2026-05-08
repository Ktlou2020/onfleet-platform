import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import toast from 'react-hot-toast';
import Logo from '../components/Logo';
import { Bike, ShieldCheck, MapPin } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const nav = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const user = await login(email, password);
      toast.success(`Welcome back, ${user.full_name.split(' ')[0]}!`);
      nav(['admin', 'superadmin'].includes(user.role) ? '/admin' : '/dashboard');
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
          <div className="auth-tagline">Ride. Earn.<br /><span>Own.</span></div>
          <p className="muted" style={{ maxWidth: 420 }}>Africa's smartest rent-to-own bike platform. Upload 3 payslips, get pre-approved automatically, sign your contract online, and track every payment to ownership.</p>
          <div className="feat-list">
            <div className="feat"><div className="ico"><Bike size={16} /></div><div><strong>Electronic contracts</strong><div className="muted text-sm">Sign online after bike allocation</div></div></div>
            <div className="feat"><div className="ico"><ShieldCheck size={16} /></div><div><strong>Document-driven approvals</strong><div className="muted text-sm">3 payslips, ID, and licence reviewed in one flow</div></div></div>
            <div className="feat"><div className="ico"><MapPin size={16} /></div><div><strong>Live bike tracking</strong><div className="muted text-sm">GPS on every bike</div></div></div>
          </div>
        </div>
        <div className="muted text-sm">© OnFleet Africa</div>
      </div>

      <div className="auth-form">
        <h1>Welcome back</h1>
        <div className="sub">Sign in to track your rent-to-own progress.</div>
        <form onSubmit={submit}>
          <div className="field"><label className="label">Email</label><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></div>
          <div className="field"><label className="label">Password</label><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
          <button className="btn btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>New to OnFleet? <Link to="/signup">Create an account</Link></div>
        <div className="card mt-6" style={{ background: 'var(--surface-2)' }}>
          <div className="text-xs muted mb-2">DEMO ACCOUNTS</div>
          <div className="text-sm"><strong>Super Admin:</strong> admin@onfleet.africa / OnfleetAdmin2026!</div>
          <div className="text-sm"><strong>Admin:</strong> ops@onfleet.africa / ops12345</div>
          <div className="text-sm"><strong>Rider:</strong> thabo@example.com / rider123</div>
        </div>
      </div>
    </div>
  );
}

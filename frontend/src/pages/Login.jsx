import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import toast from 'react-hot-toast';
import Logo from '../components/Logo';
import { Bike, ShieldCheck, MapPin, FileText, CreditCard } from 'lucide-react';
import brand, { brandFullName, brandName } from '../brand';

// The rider's door, and the half of it that talks.
//
// What stood here was OnFleet's own offer — Africa's smartest rent-to-own
// platform, three payslips, pre-approved automatically, every payment to
// ownership — shown to every rider on every deployment. None of it describes a
// rider whose operator merely runs their fleet on this platform: they did not
// apply to us, we did not approve them, and what they owe is their operator's
// arrangement, not ours. A rent-to-own pitch is also a promise, and it is not
// ours to make on another company's behalf.
//
// So OnFleet keeps its pitch, word for word, and every other brand gets a
// plain account of what is behind the login instead of a sales page.
const HERO = {
  onfleet: {
    tagline: <>Ride. Earn.<br /><span>Own.</span></>,
    blurb: "Africa's smartest rent-to-own bike platform. Upload 3 payslips, get pre-approved automatically, sign your contract online, and track every payment to ownership.",
    feats: [
      [Bike, 'Electronic contracts', 'Sign online after bike allocation'],
      [ShieldCheck, 'Document-driven approvals', '3 payslips, ID, and licence reviewed in one flow'],
      [MapPin, 'Live bike tracking', 'GPS on every bike'],
    ],
  },
  default: {
    tagline: <>Your bike.<br /><span>Your record.</span></>,
    blurb: 'Everything your fleet holds about you and the bike you ride, in one place.',
    feats: [
      [FileText, 'Your agreement', 'What you signed, and what it says'],
      [CreditCard, 'Your payments', 'What has been received, and what is due next'],
      [MapPin, 'Your bike', 'Where it is, and when it was last serviced'],
    ],
  },
};

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const nav = useNavigate();
  const hero = HERO[brand.key] || HERO.default;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const user = await login(email, password);
      toast.success(`Welcome back, ${user.full_name.split(' ')[0]}!`);
      nav('/');
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
          <div className="auth-tagline">{hero.tagline}</div>
          <p className="muted" style={{ maxWidth: 420 }}>{hero.blurb}</p>
          <div className="feat-list">
            {hero.feats.map(([Icon, title, sub]) => (
              <div className="feat" key={title}><div className="ico"><Icon size={16} /></div><div><strong>{title}</strong><div className="muted text-sm">{sub}</div></div></div>
            ))}
          </div>
        </div>
        <div className="muted text-sm">© {brandFullName}</div>
      </div>

      <div className="auth-form">
        <h1>Welcome back</h1>
        <div className="sub">Sign in to access your secure {brandName} workspace.</div>
        <form onSubmit={submit}>
          <div className="field"><label className="label">Email</label><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></div>
          <div className="field"><label className="label">Password</label><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
          <button className="btn btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="mt-3 text-sm" style={{ textAlign: 'right' }}><Link to="/forgot-password">Forgot password?</Link></div>
        {/* "Create an account" is OnFleet's rider application — three payslips,
            pre-approval, and a bike chosen from OnFleet's own catalogue. On any
            other brand that catalogue is empty and the approval is nobody's to
            give, so the rider funnel belongs to OnFleet alone. Fleet owners
            still sign themselves up; that door is on the front page. */}
        {brand.key === 'onfleet' && (
          <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>New to {brandName}? <Link to="/signup">Create an account</Link></div>
        )}
        <div className="card mt-6" style={{ background: 'var(--surface-2)' }}>
          {brand.key === 'onfleet' ? (
            <>
              <div className="text-sm"><strong>Secure access only.</strong> Rider and admin credentials are no longer displayed on the login screen.</div>
              <div className="muted text-sm mt-2">If you need admin access, contact the platform owner to provision your account.</div>
            </>
          ) : (
            <>
              <div className="text-sm"><strong>Your fleet creates your account.</strong> {brandName} is the system the company you ride for uses to run its bikes.</div>
              <div className="muted text-sm mt-2">If you cannot sign in, ask them to check the email address they hold for you.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

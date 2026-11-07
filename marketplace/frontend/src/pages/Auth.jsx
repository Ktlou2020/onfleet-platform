import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BRAND, api, useAuth, useMeta } from '../lib.jsx';

const HOME_FOR = { merchant: '/merchant', rider: '/rider', admin: '/admin', customer: '/' };

const DEMO = [
  ['Customer', 'customer@clicknpuff.africa'],
  ['Store', 'merchant1@clicknpuff.africa'],
  ['Rider', 'rider1@clicknpuff.africa'],
  ['Admin', 'admin@clicknpuff.africa'],
];

export default function Auth() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', phone: '', role: 'customer' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const meta = useMeta();

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const go = async (body, path) => {
    setBusy(true);
    setError('');
    try {
      const d = await api(path, { method: 'POST', body });
      signIn(d);
      const next = params.get('next');
      navigate(next && d.user.role === 'customer' ? next : HOME_FOR[d.user.role], { replace: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    go(mode === 'login' ? { email: form.email, password: form.password } : form, mode === 'login' ? '/auth/login' : '/auth/register');
  };

  return (
    <div className="page narrow">
      <div className="card auth">
        <h1>{mode === 'login' ? `Welcome back to ${BRAND.name}` : 'Create your account'}</h1>
        <div className="tabs">
          <button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Sign in</button>
          <button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>Sign up</button>
        </div>
        <form onSubmit={submit}>
          {mode === 'register' && (
            <>
              <div className="seg">
                {[['customer', 'I want to order'], ['merchant', 'I run a store'], ['rider', 'I want to ride']].map(([r, l]) => (
                  <button type="button" key={r} className={form.role === r ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, role: r }))}>{l}</button>
                ))}
              </div>
              <label className="field"><span>Full name</span><input value={form.name} onChange={set('name')} required autoComplete="name" /></label>
              <label className="field"><span>Mobile number</span><input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="082 123 4567" autoComplete="tel" /></label>
            </>
          )}
          <label className="field"><span>Email</span><input type="email" value={form.email} onChange={set('email')} required autoComplete="email" /></label>
          <label className="field"><span>Password</span><input type="password" value={form.password} onChange={set('password')} required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-lg full" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          {mode === 'login' && <p className="center-text small"><Link to="/forgot">Forgot your password?</Link></p>}
          {mode === 'register' && <p className="muted small">By signing up you confirm you are 18 or older. We verify this with your SA ID before your first order.</p>}
        </form>
      </div>
      {meta?.demo && (
        <div className="card">
          <p className="eyebrow">Demo accounts (password123)</p>
          <div className="chips">
            {DEMO.map(([label, email]) => <button key={email} className="chip" onClick={() => go({ email, password: 'password123' }, '/auth/login')}>{label}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { setDone((await api('/auth/forgot', { method: 'POST', body: { email } })).message); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="page narrow">
      <div className="card auth">
        <h1>Forgot your password?</h1>
        {done ? (
          <>
            <p>📬 {done}</p>
            <p className="muted small">The link works for one hour. Nothing arrived? Check spam, or try again in a few minutes.</p>
            <Link to="/login" className="btn btn-ghost full">Back to sign in</Link>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="muted">Enter the email you signed up with and we'll send you a link to choose a new password.</p>
            <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus /></label>
            {error && <p className="error">{error}</p>}
            <button className="btn btn-lg full" disabled={busy}>{busy ? 'Sending…' : 'Send me a link'}</button>
            <p className="center-text small"><Link to="/login">Back to sign in</Link></p>
          </form>
        )}
      </div>
    </div>
  );
}

// Opened from the email link: reset a forgotten password, or set one for
// the first time (invited store staff).
export function Reset() {
  const [params] = useSearchParams();
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const token = params.get('token');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api('/auth/reset', { method: 'POST', body: { token, password } });
      signIn(d);
      navigate(HOME_FOR[d.user.role], { replace: true });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="page narrow">
      <form className="card auth" onSubmit={submit}>
        <h1>Choose a password</h1>
        {!token ? <p className="error">This link is incomplete — open it straight from the email, or <Link to="/forgot">ask for a new one</Link>.</p> : (
          <>
            <label className="field"><span>New password (10+ characters)</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" autoFocus /></label>
            {error && <p className="error">{error}{/expired/.test(error) && <> <Link to="/forgot">Get a new link</Link></>}</p>}
            <button className="btn btn-lg full" disabled={busy}>{busy ? 'Saving…' : 'Save and sign in'}</button>
          </>
        )}
      </form>
    </div>
  );
}

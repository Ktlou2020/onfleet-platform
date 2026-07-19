import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { useAuth } from '../../auth';

const WORKSHOP_ROLES = ['technician', 'admin', 'superadmin'];

export default function WorkshopLogin() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await login(email.trim(), password);
      if (!WORKSHOP_ROLES.includes(user.role)) {
        setError('Your account does not have workshop access. Contact your administrator.');
        return;
      }
      nav('/workshop/app', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg)' }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 56, height: 56, borderRadius: 16, background: 'var(--accent)', marginBottom: 16 }}>
            <Wrench size={26} style={{ color: '#fff' }} />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Workshop Portal</h1>
          <p className="muted text-sm">Sign in to manage job cards and track repairs</p>
        </div>

        <div className="card" style={{ padding: 28 }}>
          <form onSubmit={submit}>
            <div className="field" style={{ marginBottom: 16 }}>
              <label className="label">Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="technician@example.com"
                required
                autoFocus
                autoComplete="email"
              />
            </div>
            <div className="field" style={{ marginBottom: 20 }}>
              <label className="label">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
            {error && (
              <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', fontSize: 13 }}>
                {error}
              </div>
            )}
            <button className="btn" type="submit" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="muted text-xs" style={{ textAlign: 'center', marginTop: 20 }}>
          Need an account? Contact your workshop administrator.
        </p>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import Logo from '../components/Logo';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post('/auth/forgot-password', { email });
      setSent(true);
      toast.success(data.message || 'If the email exists, a reset link has been sent.');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Unable to start password reset');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size="lg" />
        <div>
          <div className="auth-tagline">Reset your<br /><span>OnFleet password.</span></div>
          <p className="muted" style={{ maxWidth: 420 }}>Enter the email address linked to your account and we will send you a secure reset link.</p>
        </div>
        <div className="muted text-sm">Secure password recovery</div>
      </div>

      <div className="auth-form">
        <h1>Forgot password</h1>
        <div className="sub">We will email you a reset link if your account exists.</div>
        <form onSubmit={submit}>
          <div className="field">
            <label className="label">Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <button className="btn btn-block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
        {sent && (
          <div className="card mt-6" style={{ background: 'var(--surface-2)' }}>
            <div className="text-sm"><strong>Check your email.</strong> If the address exists in OnFleet, a reset link is on its way.</div>
          </div>
        )}
        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>
          Remembered it? <Link to="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}

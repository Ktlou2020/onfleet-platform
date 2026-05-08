import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import Logo from '../components/Logo';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => params.get('token') || '', [params]);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!token) {
      toast.error('Reset token is missing from this link');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post('/auth/reset-password', { token, new_password: newPassword });
      setDone(true);
      toast.success(data.message || 'Password reset successful');
      setTimeout(() => navigate('/login'), 1200);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Reset link is invalid or expired');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size="lg" />
        <div>
          <div className="auth-tagline">Choose a new<br /><span>secure password.</span></div>
          <p className="muted" style={{ maxWidth: 420 }}>This reset link lets you create a fresh password for your OnFleet account.</p>
        </div>
        <div className="muted text-sm">Password reset</div>
      </div>

      <div className="auth-form">
        <h1>Reset password</h1>
        <div className="sub">Enter your new password below.</div>
        {!token && (
          <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
            <div className="text-sm"><strong>Invalid link.</strong> This reset URL is missing its token.</div>
          </div>
        )}
        <form onSubmit={submit}>
          <div className="field">
            <label className="label">New password</label>
            <input type="password" required minLength={6} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <div className="field">
            <label className="label">Confirm password</label>
            <input type="password" required minLength={6} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <button className="btn btn-block" disabled={busy || done}>{done ? 'Password updated' : busy ? 'Updating…' : 'Update password'}</button>
        </form>
        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>
          <Link to="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}

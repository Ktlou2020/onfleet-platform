import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import toast from 'react-hot-toast';
import Logo from '../components/Logo';

export default function Signup() {
  const [form, setForm] = useState({
    full_name: '', email: '', phone: '', id_number: '', password: '',
    address: '', city: '', province: 'Gauteng', postal_code: '',
    date_of_birth: '', emergency_contact_name: '', emergency_contact_phone: ''
  });
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const { signup } = useAuth();
  const nav = useNavigate();

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await signup(form);
      toast.success('Welcome to OnFleet! Complete your application next.');
      nav('/dashboard');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Sign up failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <Logo size="lg" />
        <div>
          <div className="auth-tagline">Your bike,<br /><span>your future.</span></div>
          <p className="muted" style={{ maxWidth: 420 }}>Apply in minutes. Get approved in 48 hours. Ride off with your bike the same day.</p>
        </div>
        <div className="muted text-sm">Step {step} of 2</div>
      </div>

      <div className="auth-form">
        <h1>Create your account</h1>
        <div className="sub">Start your rent-to-own journey today.</div>

        <form onSubmit={submit}>
          {step === 1 && (
            <>
              <div className="field"><label className="label">Full name *</label>
                <input required value={form.full_name} onChange={f('full_name')} placeholder="Thabo Mokoena" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">Email *</label>
                  <input type="email" required value={form.email} onChange={f('email')} /></div>
                <div className="field"><label className="label">Phone (WhatsApp) *</label>
                  <input required value={form.phone} onChange={f('phone')} placeholder="+27 82 123 4567" /></div>
              </div>
              <div className="grid grid-2">
                <div className="field"><label className="label">ID Number *</label>
                  <input required value={form.id_number} onChange={f('id_number')} maxLength={13} /></div>
                <div className="field"><label className="label">Date of birth</label>
                  <input type="date" value={form.date_of_birth} onChange={f('date_of_birth')} /></div>
              </div>
              <div className="field"><label className="label">Password *</label>
                <input type="password" required minLength={6} value={form.password} onChange={f('password')} /></div>
              <button type="button" className="btn btn-block" onClick={() => {
                if (!form.full_name || !form.email || !form.phone || !form.id_number || !form.password) {
                  return toast.error('Please complete required fields');
                }
                setStep(2);
              }}>Continue</button>
            </>
          )}
          {step === 2 && (
            <>
              <div className="field"><label className="label">Street address</label>
                <input value={form.address} onChange={f('address')} placeholder="123 Main Road" /></div>
              <div className="grid grid-2">
                <div className="field"><label className="label">City</label>
                  <input value={form.city} onChange={f('city')} placeholder="Johannesburg" /></div>
                <div className="field"><label className="label">Postal code</label>
                  <input value={form.postal_code} onChange={f('postal_code')} /></div>
              </div>
              <div className="field"><label className="label">Province</label>
                <select value={form.province} onChange={f('province')}>
                  {['Gauteng','Western Cape','KwaZulu-Natal','Eastern Cape','Free State','Limpopo','Mpumalanga','North West','Northern Cape'].map(p =>
                    <option key={p}>{p}</option>)}
                </select></div>
              <h3 className="mt-4 mb-2">Emergency contact</h3>
              <div className="grid grid-2">
                <div className="field"><label className="label">Name</label>
                  <input value={form.emergency_contact_name} onChange={f('emergency_contact_name')} /></div>
                <div className="field"><label className="label">Phone</label>
                  <input value={form.emergency_contact_phone} onChange={f('emergency_contact_phone')} /></div>
              </div>
              <div className="row">
                <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>Back</button>
                <button className="btn btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
              </div>
            </>
          )}
        </form>
        <div className="mt-4 muted text-sm" style={{ textAlign: 'center' }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Spinner, api, useAuth, useLoc, useToast } from '../lib.jsx';
import { VerifyAge } from './Checkout.jsx';
import { AddressSheet } from './Address.jsx';
import { StoreCard } from './Home.jsx';

// The customer's own page: who they are, where they get deliveries,
// favourite stores, and account security.
export default function Account() {
  const { user, setUser, signOut } = useAuth();
  const { loc } = useLoc();
  const notify = useToast();
  const navigate = useNavigate();
  const [f, setF] = useState({ name: user.name, phone: user.phone || '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [addresses, setAddresses] = useState(null);
  const [favs, setFavs] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [stats, setStats] = useState(null);

  const loadAddresses = useCallback(() => api('/me/addresses').then((d) => setAddresses(d.addresses)), []);
  useEffect(() => {
    loadAddresses();
    const q = loc ? `?lat=${loc.lat}&lng=${loc.lng}` : '';
    api(`/me/favourites${q}`).then((d) => setFavs(d.stores));
    api('/orders').then((d) => {
      const done = d.orders.filter((o) => o.status === 'delivered');
      setStats({ orders: done.length, since: user.createdAt });
    }).catch(() => {});
  }, [loadAddresses, loc, user.createdAt]);

  const saveDetails = async (e) => {
    e.preventDefault();
    try { const d = await api('/me', { method: 'PATCH', body: f }); setUser(d.user); notify('Details saved', 'ok'); } catch (err) { notify(err.message, 'bad'); }
  };
  const savePassword = async (e) => {
    e.preventDefault();
    if (pw.newPassword !== pw.confirm) return notify("The new passwords don't match", 'bad');
    try {
      await api('/me/password', { method: 'POST', body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword } });
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      notify('Password changed', 'ok');
    } catch (err) { notify(err.message, 'bad'); }
  };
  const renameAddress = async (a) => {
    try { await api(`/me/addresses/${a.id}`, { method: 'PATCH', body: { label: editing.label, notes: editing.notes } }); setEditing(null); loadAddresses(); } catch (err) { notify(err.message, 'bad'); }
  };
  const removeAddress = async (a) => {
    if (!window.confirm(`Delete ${a.label}?`)) return;
    try { await api(`/me/addresses/${a.id}`, { method: 'DELETE' }); loadAddresses(); } catch (err) { notify(err.message, 'bad'); }
  };
  const since = user.createdAt ? new Date(user.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' }) : null;

  return (
    <div className="page narrow account">
      <section className="acct-head">
        <div className="acct-avatar">{user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</div>
        <div>
          <h1>{user.name}</h1>
          <p className="muted">{user.email}</p>
          <p className="small">
            {user.ageVerified ? <span className="tag">✓ ID verified · 18+</span> : <span className="tag tag-warn">ID not verified yet</span>}
            {stats && <span className="muted"> · {stats.orders} order{stats.orders === 1 ? '' : 's'}{since ? ` · with us since ${since}` : ''}</span>}
          </p>
        </div>
      </section>

      {!user.ageVerified && <VerifyAge />}

      <section className="card">
        <div className="row-between"><h3>Saved addresses</h3><button className="link" onClick={() => setAdding(true)}>+ Add</button></div>
        {!addresses ? <Spinner /> : addresses.length === 0 ? <p className="muted small">Save Home, Work or anywhere else to choose it with one tap at checkout.</p> : (
          <ul className="acct-list">
            {addresses.map((a) => (
              <li key={a.id}>
                {editing?.id === a.id ? (
                  <div className="acct-edit">
                    <input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} aria-label="Address name" />
                    <input value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="Gate code, complex, landmark" aria-label="Address notes" />
                    <div className="actions"><button className="btn btn-sm" onClick={() => renameAddress(a)}>Save</button><button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button></div>
                  </div>
                ) : (
                  <>
                    <span className="saved-icon">{/home/i.test(a.label) ? '🏠' : /work|office/i.test(a.label) ? '💼' : '📍'}</span>
                    <div className="grow"><strong>{a.label}</strong><p className="muted small">{a.address}{a.notes ? ` · ${a.notes}` : ''}</p></div>
                    <button className="link small" onClick={() => setEditing({ id: a.id, label: a.label, notes: a.notes })}>Edit</button>
                    <button className="link small danger" onClick={() => removeAddress(a)}>Delete</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="section-title">♥ Favourite stores</h3>
        {!favs ? <Spinner /> : favs.length === 0 ? <p className="muted small">Tap ♡ on any store to keep it here. <Link to="/" className="link">Browse stores</Link></p>
          : <div className="store-grid">{favs.map((s) => <StoreCard key={s.id} s={s} />)}</div>}
      </section>

      <form className="card" onSubmit={saveDetails}>
        <h3>Your details</h3>
        <label className="field"><span>Full name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" /></label>
        <label className="field"><span>Mobile number (your rider calls this if they can't find you)</span><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" autoComplete="tel" placeholder="082 123 4567" /></label>
        <button className="btn">Save details</button>
      </form>

      <form className="card" onSubmit={savePassword}>
        <h3>Password</h3>
        <label className="field"><span>Current password</span><input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required autoComplete="current-password" /></label>
        <label className="field"><span>New password (at least 10 characters)</span><input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required minLength={10} autoComplete="new-password" /></label>
        <label className="field"><span>Repeat new password</span><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required autoComplete="new-password" /></label>
        <button className="btn">Change password</button>
      </form>

      <section className="card">
        <h3>Help & safety</h3>
        <ul className="acct-help">
          <li>Problem with an order? Open it from <Link to="/orders" className="link">Orders</Link> and tap <b>Report a problem</b>.</li>
          <li>Every delivery needs your 4-digit code and a valid ID showing you're 18 or older.</li>
          <li>Please use responsibly. If you're worried about your use, talk to your doctor or contact SANCA (sanca.org.za), South Africa's national council on substance abuse.</li>
        </ul>
      </section>

      <button className="btn btn-ghost full" onClick={() => { signOut(); navigate('/'); }}>Sign out</button>

      {adding && <AddressSheet saveOnly onClose={() => setAdding(false)} onSaved={() => loadAddresses()} />}
    </div>
  );
}

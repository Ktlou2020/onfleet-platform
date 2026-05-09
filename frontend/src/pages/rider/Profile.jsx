import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading } from '../../components/ui';
import africanCountries from '../../constants/africanCountries';

export default function RiderProfile() {
  const [u, setU] = useState(null);
  const [pwd, setPwd] = useState({ current_password: '', new_password: '' });
  const [uploadingSelfie, setUploadingSelfie] = useState(false);

  useEffect(() => {
    api.get('/auth/me').then((r) => setU(r.data.user));
  }, []);

  if (!u) return <Loading />;

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.put('/auth/me', u);
      toast.success('Profile saved');
    } catch {
      toast.error('Save failed');
    }
  };

  const uploadSelfie = async (file) => {
    if (!file) return;
    setUploadingSelfie(true);
    try {
      const fd = new FormData();
      fd.append('selfie', file);
      const { data } = await api.post('/auth/me/selfie', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setU((prev) => ({ ...prev, avatar_url: data.avatar_url }));
      toast.success('Selfie updated');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Selfie upload failed');
    } finally {
      setUploadingSelfie(false);
    }
  };

  const changePwd = async (e) => {
    e.preventDefault();
    try {
      await api.post('/auth/change-password', pwd);
      toast.success('Password changed');
      setPwd({ current_password: '', new_password: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  return (
    <div className="profile-page">
      <h1 className="page-title">Profile</h1>
      <p className="page-sub">Update your personal details, selfie, and country of origin.</p>

      <div className="profile-summary card mb-4">
        <div className="profile-summary-main">
          <div className="avatar profile-avatar-large" style={{ backgroundImage: u.avatar_url ? `url(${u.avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }}>
            {u.avatar_url ? '' : u.full_name?.[0]}
          </div>
          <div className="profile-summary-copy">
            <div className="profile-summary-name">{u.full_name || 'Rider profile'}</div>
            <div className="muted text-sm">{u.email}</div>
            <div className="muted text-sm">{u.phone || 'Add a phone number for payment and support updates.'}</div>
          </div>
        </div>
        <div className="profile-summary-tip">
          Keep your contact details current so payment reminders, support updates, and password recovery reach you quickly.
        </div>
      </div>

      <div className="grid grid-2 profile-grid">
        <form className="card profile-form-card" onSubmit={save}>
          <div className="card-title profile-card-title">
            <div>
              <h3>Personal info</h3>
              <div className="muted text-sm mt-1">Make it easy for the team to contact and verify you.</div>
            </div>
          </div>

          <div className="field">
            <label className="label">Selfie</label>
            <div className="profile-selfie-row">
              <div className="avatar profile-avatar-large" style={{ backgroundImage: u.avatar_url ? `url(${u.avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }}>
                {u.avatar_url ? '' : u.full_name?.[0]}
              </div>
              <div className="profile-selfie-copy">
                <label htmlFor="profile-selfie-input" className="btn btn-secondary profile-file-trigger">
                  {uploadingSelfie ? 'Uploading…' : 'Upload new selfie'}
                </label>
                <input
                  id="profile-selfie-input"
                  className="visually-hidden"
                  type="file"
                  accept="image/*"
                  onChange={(e) => uploadSelfie(e.target.files?.[0])}
                  disabled={uploadingSelfie}
                />
                <div className="muted text-sm mt-2">PNG, JPG, or WEBP supported. A clear selfie helps with profile verification.</div>
              </div>
            </div>
          </div>

          <div className="field">
            <label className="label">Full name</label>
            <input autoComplete="name" value={u.full_name || ''} onChange={(e) => setU({ ...u, full_name: e.target.value })} />
          </div>

          <div className="grid grid-2 profile-field-grid">
            <div className="field">
              <label className="label">Email</label>
              <input type="email" autoComplete="email" value={u.email} disabled />
            </div>
            <div className="field">
              <label className="label">Phone</label>
              <input autoComplete="tel" inputMode="tel" value={u.phone || ''} onChange={(e) => setU({ ...u, phone: e.target.value })} />
            </div>
          </div>

          <div className="field">
            <label className="label">Country of origin</label>
            <select value={u.country_of_origin || ''} onChange={(e) => setU({ ...u, country_of_origin: e.target.value })}>
              <option value="">Select country</option>
              {africanCountries.map((country) => <option key={country} value={country}>{country}</option>)}
            </select>
          </div>

          <div className="field">
            <label className="label">Address</label>
            <input autoComplete="street-address" value={u.address || ''} onChange={(e) => setU({ ...u, address: e.target.value })} />
          </div>

          <div className="grid grid-2 profile-field-grid">
            <div className="field">
              <label className="label">City</label>
              <input autoComplete="address-level2" value={u.city || ''} onChange={(e) => setU({ ...u, city: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">Province</label>
              <input autoComplete="address-level1" value={u.province || ''} onChange={(e) => setU({ ...u, province: e.target.value })} />
            </div>
          </div>

          <div className="profile-actions">
            <button className="btn profile-action-btn">Save changes</button>
          </div>
        </form>

        <form className="card profile-password-card" onSubmit={changePwd}>
          <div className="card-title profile-card-title">
            <div>
              <h3>Change password</h3>
              <div className="muted text-sm mt-1">Use a strong password you do not reuse anywhere else.</div>
            </div>
          </div>

          <div className="field">
            <label className="label">Current password</label>
            <input type="password" required autoComplete="current-password" value={pwd.current_password} onChange={(e) => setPwd({ ...pwd, current_password: e.target.value })} />
          </div>

          <div className="field">
            <label className="label">New password</label>
            <input type="password" required minLength={6} autoComplete="new-password" value={pwd.new_password} onChange={(e) => setPwd({ ...pwd, new_password: e.target.value })} />
            <div className="muted text-sm mt-2">Minimum 6 characters. Longer is better.</div>
          </div>

          <div className="profile-actions">
            <button className="btn profile-action-btn">Update password</button>
          </div>
        </form>
      </div>
    </div>
  );
}

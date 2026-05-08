import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading } from '../../components/ui';
import africanCountries from '../../constants/africanCountries';

export default function RiderProfile() {
  const [u, setU] = useState(null);
  const [pwd, setPwd] = useState({ current_password: '', new_password: '' });
  const [uploadingSelfie, setUploadingSelfie] = useState(false);

  useEffect(() => { api.get('/auth/me').then(r => setU(r.data.user)); }, []);
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
    <>
      <h1 className="page-title">Profile</h1>
      <p className="page-sub">Update your personal details, selfie, and country of origin.</p>
      <div className="grid grid-2">
        <form className="card" onSubmit={save}>
          <h3 className="mb-3">Personal info</h3>
          <div className="field">
            <label className="label">Selfie</label>
            <div className="row" style={{ alignItems: 'center' }}>
              <div className="avatar" style={{ width: 64, height: 64, backgroundImage: u.avatar_url ? `url(${u.avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }}>{u.avatar_url ? '' : u.full_name?.[0]}</div>
              <input type="file" accept="image/*" onChange={(e) => uploadSelfie(e.target.files?.[0])} disabled={uploadingSelfie} />
            </div>
            <div className="muted text-sm">{uploadingSelfie ? 'Uploading selfie…' : 'PNG, JPG, or WEBP supported.'}</div>
          </div>
          <div className="field"><label className="label">Full name</label>
            <input value={u.full_name || ''} onChange={e => setU({ ...u, full_name: e.target.value })} /></div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Email</label><input value={u.email} disabled /></div>
            <div className="field"><label className="label">Phone</label>
              <input value={u.phone || ''} onChange={e => setU({ ...u, phone: e.target.value })} /></div>
          </div>
          <div className="field"><label className="label">Country of origin</label>
            <select value={u.country_of_origin || ''} onChange={e => setU({ ...u, country_of_origin: e.target.value })}>
              <option value="">Select country</option>
              {africanCountries.map((country) => <option key={country} value={country}>{country}</option>)}
            </select>
          </div>
          <div className="field"><label className="label">Address</label>
            <input value={u.address || ''} onChange={e => setU({ ...u, address: e.target.value })} /></div>
          <div className="grid grid-2">
            <div className="field"><label className="label">City</label>
              <input value={u.city || ''} onChange={e => setU({ ...u, city: e.target.value })} /></div>
            <div className="field"><label className="label">Province</label>
              <input value={u.province || ''} onChange={e => setU({ ...u, province: e.target.value })} /></div>
          </div>
          <button className="btn">Save changes</button>
        </form>

        <form className="card" onSubmit={changePwd}>
          <h3 className="mb-3">Change password</h3>
          <div className="field"><label className="label">Current password</label>
            <input type="password" required value={pwd.current_password} onChange={e => setPwd({ ...pwd, current_password: e.target.value })} /></div>
          <div className="field"><label className="label">New password</label>
            <input type="password" required minLength={6} value={pwd.new_password} onChange={e => setPwd({ ...pwd, new_password: e.target.value })} /></div>
          <button className="btn">Update password</button>
        </form>
      </div>
    </>
  );
}

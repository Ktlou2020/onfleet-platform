import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading } from '../../components/ui';

export default function RiderProfile() {
  const [u, setU] = useState(null);
  const [pwd, setPwd] = useState({ current_password: '', new_password: '' });

  useEffect(() => { api.get('/auth/me').then(r => setU(r.data.user)); }, []);
  if (!u) return <Loading />;

  const save = async (e) => {
    e.preventDefault();
    try { await api.put('/auth/me', u); toast.success('Profile saved'); }
    catch { toast.error('Save failed'); }
  };
  const changePwd = async (e) => {
    e.preventDefault();
    try { await api.post('/auth/change-password', pwd); toast.success('Password changed');
          setPwd({ current_password: '', new_password: '' }); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <>
      <h1 className="page-title">Profile</h1>
      <p className="page-sub">Update your personal details</p>
      <div className="grid grid-2">
        <form className="card" onSubmit={save}>
          <h3 className="mb-3">Personal info</h3>
          <div className="field"><label className="label">Full name</label>
            <input value={u.full_name||''} onChange={e=>setU({...u, full_name:e.target.value})} /></div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Email</label><input value={u.email} disabled /></div>
            <div className="field"><label className="label">Phone</label>
              <input value={u.phone||''} onChange={e=>setU({...u, phone:e.target.value})} /></div>
          </div>
          <div className="field"><label className="label">Address</label>
            <input value={u.address||''} onChange={e=>setU({...u, address:e.target.value})} /></div>
          <div className="grid grid-2">
            <div className="field"><label className="label">City</label>
              <input value={u.city||''} onChange={e=>setU({...u, city:e.target.value})} /></div>
            <div className="field"><label className="label">Province</label>
              <input value={u.province||''} onChange={e=>setU({...u, province:e.target.value})} /></div>
          </div>
          <button className="btn">Save changes</button>
        </form>

        <form className="card" onSubmit={changePwd}>
          <h3 className="mb-3">Change password</h3>
          <div className="field"><label className="label">Current password</label>
            <input type="password" required value={pwd.current_password} onChange={e=>setPwd({...pwd, current_password:e.target.value})}/></div>
          <div className="field"><label className="label">New password</label>
            <input type="password" required minLength={6} value={pwd.new_password} onChange={e=>setPwd({...pwd, new_password:e.target.value})}/></div>
          <button className="btn">Update password</button>
        </form>
      </div>
    </>
  );
}

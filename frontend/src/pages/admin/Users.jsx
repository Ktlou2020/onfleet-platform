import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { useAuth } from '../../auth';
import { Loading, Badge, fmtDate, Modal } from '../../components/ui';

export default function AdminUsers() {
  const { user } = useAuth();
  const [users, setUsers] = useState(null);
  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', password: '', role: 'rider' });
  const [roleEdits, setRoleEdits] = useState({});

  const load = () => api.get('/admin/users', { params: filter ? { role: filter } : {} }).then((response) => setUsers(response.data.users));
  useEffect(() => { load(); }, [filter]);

  useEffect(() => {
    if (!users) return;
    const next = {};
    users.forEach((account) => { next[account.id] = account.role; });
    setRoleEdits(next);
  }, [users]);

  const dirtyRoles = useMemo(() => Object.entries(roleEdits).filter(([id, role]) => {
    const account = users?.find((row) => row.id === Number(id));
    return account && account.role !== role;
  }).length, [roleEdits, users]);

  const toggle = async (account) => {
    const status = account.status === 'active' ? 'suspended' : 'active';
    if (!window.confirm(`${status === 'active' ? 'Activate' : 'Suspend'} ${account.full_name}?`)) return;
    await api.post(`/admin/users/${account.id}/status`, { status });
    toast.success('Updated');
    load();
  };

  const saveRole = async (account) => {
    const nextRole = roleEdits[account.id];
    if (!nextRole || nextRole === account.role) return;
    if (!window.confirm(`Change ${account.full_name} from ${account.role} to ${nextRole}?`)) return;
    try {
      await api.post(`/admin/users/${account.id}/role`, { role: nextRole });
      toast.success('Role updated');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update role');
    }
  };

  const createUser = async () => {
    try {
      await api.post('/admin/users', form);
      toast.success('User added');
      setShowCreate(false);
      setForm({ full_name: '', email: '', phone: '', password: '', role: 'rider' });
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create user');
    }
  };

  const removeUser = async (account) => {
    if (!window.confirm(`Remove ${account.full_name}? This hides the account from active users.`)) return;
    try {
      await api.delete(`/admin/users/${account.id}`);
      toast.success('User removed');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not remove user');
    }
  };

  if (!users) return <Loading />;
  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-sub">Manage riders and admins. Superadmins can create users, change roles, import legacy riders, and remove accounts.</p>
        </div>
        <div className="row">
          {user?.role === 'superadmin' && <button className="btn" onClick={() => setShowCreate(true)}>+ Add user</button>}
        </div>
      </div>
      <div className="row mb-4" style={{ flexWrap: 'wrap' }}>
        {[['', 'All'], ['rider', 'Riders'], ['admin', 'Admins'], ['superadmin', 'Superadmins']].map(([value, label]) => (
          <button key={value} onClick={() => setFilter(value)} className={`btn btn-sm ${filter === value ? '' : 'btn-secondary'}`}>{label}</button>
        ))}
        {user?.role === 'superadmin' && dirtyRoles > 0 && <span className="muted text-sm">Unsaved role changes are highlighted per user.</span>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>User</th><th>Phone</th><th>Country</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {users.map((account) => {
              const pendingRole = roleEdits[account.id] || account.role;
              const roleChanged = pendingRole !== account.role;
              return (
                <tr key={account.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div className="avatar" style={{ backgroundImage: account.avatar_url ? `url(${account.avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }}>{account.avatar_url ? '' : account.full_name?.[0]}</div>
                      <div>
                        <strong>{account.full_name}</strong>
                        <div className="text-xs muted">{account.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>{account.phone || '—'}</td>
                  <td>{account.country_of_origin || '—'}</td>
                  <td>
                    {user?.role === 'superadmin' && account.id !== user.id ? (
                      <div className="row" style={{ gap: 8 }}>
                        <select value={pendingRole} onChange={(e) => setRoleEdits((prev) => ({ ...prev, [account.id]: e.target.value }))} style={{ minWidth: 120, borderColor: roleChanged ? 'var(--primary)' : undefined }}>
                          <option value="rider">Rider</option>
                          <option value="admin">Admin</option>
                          <option value="superadmin">Superadmin</option>
                        </select>
                        <button className={`btn btn-sm ${roleChanged ? '' : 'btn-secondary'}`} disabled={!roleChanged} onClick={() => saveRole(account)}>Save role</button>
                      </div>
                    ) : (
                      <Badge>{account.role}</Badge>
                    )}
                  </td>
                  <td><Badge status={account.status} /></td>
                  <td>{fmtDate(account.created_at)}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => toggle(account)}>{account.status === 'active' ? 'Suspend' : 'Activate'}</button>
                      {user?.role === 'superadmin' && account.id !== user.id && <button className="btn btn-sm btn-danger" onClick={() => removeUser(account)}>Remove</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <Modal title="Add user" onClose={() => setShowCreate(false)}>
          <div className="grid grid-2">
            <div className="field"><label className="label">Full name</label><input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
            <div className="field"><label className="label">Email</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="field"><label className="label">Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div className="field"><label className="label">Password</label><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            <div className="field"><label className="label">Role</label><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="rider">Rider</option><option value="admin">Admin</option>{user?.role === 'superadmin' && <option value="superadmin">Superadmin</option>}</select></div>
          </div>
          <div className="row"><button className="btn" onClick={createUser}>Create</button><button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

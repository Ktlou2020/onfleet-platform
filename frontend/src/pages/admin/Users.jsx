import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, fmtDate } from '../../components/ui';

export default function AdminUsers() {
  const [users, setUsers] = useState(null);
  const [filter, setFilter] = useState('rider');

  const load = () => api.get('/admin/users', { params: filter ? { role: filter } : {} }).then(r => setUsers(r.data.users));
  useEffect(() => { load(); }, [filter]);

  const toggle = async (u) => {
    const status = u.status === 'active' ? 'suspended' : 'active';
    if (!confirm(`${status === 'active' ? 'Activate' : 'Suspend'} ${u.full_name}?`)) return;
    await api.post(`/admin/users/${u.id}/status`, { status });
    toast.success('Updated'); load();
  };
  if (!users) return <Loading />;
  return (
    <>
      <h1 className="page-title">Users</h1>
      <p className="page-sub">All platform users</p>
      <div className="row mb-4">
        {[['','All'],['rider','Riders'],['admin','Admins']].map(([v,l]) =>
          <button key={v} onClick={() => setFilter(v)}
            className={`btn btn-sm ${filter === v ? '' : 'btn-secondary'}`}>{l}</button>)}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td><strong>{u.full_name}</strong></td>
                <td>{u.email}</td>
                <td>{u.phone || '—'}</td>
                <td><Badge>{u.role}</Badge></td>
                <td><Badge status={u.status}/></td>
                <td>{fmtDate(u.created_at)}</td>
                <td><button className="btn btn-sm btn-secondary" onClick={() => toggle(u)}>
                  {u.status === 'active' ? 'Suspend' : 'Activate'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

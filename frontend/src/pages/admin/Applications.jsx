import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, fmt, fmtDate } from '../../components/ui';

export default function AdminApplications() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const [list, setList] = useState(null);
  const [riders, setRiders] = useState([]);
  const [bikes, setBikes] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ user_id: '', preferred_bike_id: '', payout_preference: 'eft' });

  const load = () => api.get('/applications', { params: status ? { status } : {} }).then((response) => setList(response.data.applications));
  useEffect(() => { load(); }, [status]);
  useEffect(() => {
    api.get('/admin/users', { params: { role: 'rider' } }).then((response) => setRiders(response.data.users));
    api.get('/bikes/catalog').then((response) => setBikes(response.data.bikes));
  }, []);

  const createApplication = async () => {
    try {
      await api.post('/applications/admin-create', { ...form, user_id: Number(form.user_id), preferred_bike_id: Number(form.preferred_bike_id) });
      toast.success('Application created');
      setShowCreate(false);
      setForm({ user_id: '', preferred_bike_id: '', payout_preference: 'eft' });
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create application');
    }
  };

  if (!list) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Applications</h1>
          <p className="page-sub">Review rider applications, payslips, and pre-approval decisions.</p>
        </div>
        <button className="btn" onClick={() => setShowCreate(true)}>+ Add application</button>
      </div>
      <div className="row mb-4">
        {['', 'submitted', 'under_review', 'approved', 'rejected'].map((value) => (
          <button key={value} onClick={() => setParams(value ? { status: value } : {})} className={`btn btn-sm ${status === value ? '' : 'btn-secondary'}`}>{value || 'All'}</button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Submitted</th><th>Rider</th><th>Bike</th><th>Avg weekly</th><th>Docs</th><th>Decision</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.map((application) => (
              <tr key={application.id}>
                <td>{fmtDate(application.submitted_at)}</td>
                <td><strong>{application.full_name}</strong><div className="text-xs muted">{application.email}</div></td>
                <td>{application.make ? `${application.make} ${application.model}` : '—'}</td>
                <td>{application.average_weekly_earnings ? fmt(application.average_weekly_earnings) : 'Pending payslips'}</td>
                <td>{application.document_count || 0} files</td>
                <td>{application.auto_decision ? <Badge status={application.auto_decision === 'auto_declined' ? 'rejected' : 'approved'}>{application.auto_decision.replace(/_/g, ' ')}</Badge> : '—'}</td>
                <td><Badge status={application.status} /></td>
                <td><Link to={`/admin/applications/${application.id}`} className="btn btn-sm btn-secondary">Review</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>No applications.</div>}
      </div>

      {showCreate && (
        <Modal title="Add application" onClose={() => setShowCreate(false)}>
          <div className="field"><label className="label">Rider</label>
            <select value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })}>
              <option value="">— Select rider —</option>
              {riders.map((rider) => <option key={rider.id} value={rider.id}>{rider.full_name} · {rider.email}</option>)}
            </select></div>
          <div className="field"><label className="label">Preferred bike</label>
            <select value={form.preferred_bike_id} onChange={(e) => setForm({ ...form, preferred_bike_id: e.target.value })}>
              <option value="">— Select bike —</option>
              {bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {fmt(bike.rental_weekly)}/week</option>)}
            </select></div>
          <div className="field"><label className="label">Payout preference</label>
            <select value={form.payout_preference} onChange={(e) => setForm({ ...form, payout_preference: e.target.value })}>
              <option value="eft">EFT</option>
              <option value="ewallet">E-wallet</option>
            </select></div>
          <div className="row">
            <button className="btn" onClick={createApplication}>Create</button>
            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

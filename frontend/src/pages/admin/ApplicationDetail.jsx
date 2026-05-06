import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, fmt, fmtDate } from '../../components/ui';

export default function AdminApplicationDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [bikes, setBikes] = useState([]);
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [approveForm, setApproveForm] = useState({ bike_id: '', weekly_amount: '', total_weeks: 78, start_date: new Date().toISOString().slice(0,10) });
  const [rejectReason, setRejectReason] = useState('');

  const load = () => api.get(`/applications/${id}`).then(r => setData(r.data));
  useEffect(() => {
    load();
    api.get('/bikes', { params: { status: 'available' } }).then(r => setBikes(r.data.bikes));
  }, [id]);

  if (!data) return <Loading />;
  const a = data.application;

  const approve = async () => {
    if (!approveForm.bike_id || !approveForm.weekly_amount) return toast.error('Bike & weekly amount required');
    try {
      const r = await api.post(`/applications/${id}/approve`, approveForm);
      toast.success(`Approved! Agreement ${r.data.agreement_no} created.`);
      nav(`/admin/agreements/${r.data.agreement_id}`);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const reject = async () => {
    try { await api.post(`/applications/${id}/reject`, { reason: rejectReason });
      toast.success('Rejected'); load(); setShowReject(false); }
    catch { toast.error('Failed'); }
  };

  return (
    <>
      <Link to="/admin/applications" className="muted text-sm">← Back</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">Application #{a.id}</h1>
          <div className="muted">Submitted {fmtDate(a.submitted_at)}</div>
        </div>
        <Badge status={a.status}/>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="mb-3">Rider details</h3>
          <Row k="Name" v={a.full_name} />
          <Row k="Email" v={a.email} />
          <Row k="Phone" v={a.phone} />
          <Row k="ID Number" v={a.id_number} />
          <Row k="Address" v={[a.address, a.city, a.province].filter(Boolean).join(', ')} />
        </div>
        <div className="card">
          <h3 className="mb-3">Application details</h3>
          <Row k="Employment" v={a.employment_status} />
          <Row k="Monthly income" v={fmt(a.monthly_income)} />
          <Row k="Delivery platforms" v={a.delivery_platforms} />
          <Row k="Riding experience" v={a.has_riding_experience ? `${a.years_riding || '?'} years` : 'None'} />
          <Row k="Drivers license" v={a.has_drivers_license ? 'Yes' : 'No'} />
        </div>
      </div>

      <div className="card mt-4">
        <h3 className="mb-3">KYC documents</h3>
        <div className="grid grid-3">
          {data.kyc_documents.map(d => (
            <div key={d.id} className="card" style={{ background: 'var(--surface-2)' }}>
              <div className="flex-between mb-2">
                <strong>{d.doc_type.replace(/_/g,' ')}</strong>
                <Badge status={d.status} />
              </div>
              <div className="text-xs muted">{d.original_name}</div>
            </div>
          ))}
        </div>
      </div>

      {a.status === 'submitted' && (
        <div className="row mt-4">
          <button className="btn btn-success" onClick={() => setShowApprove(true)}>✓ Approve & allocate bike</button>
          <button className="btn btn-danger" onClick={() => setShowReject(true)}>✗ Reject</button>
        </div>
      )}

      {showApprove && <Modal title="Approve & allocate" onClose={() => setShowApprove(false)}>
        <div className="field"><label className="label">Bike</label>
          <select value={approveForm.bike_id} onChange={e => {
            const b = bikes.find(x => x.id === +e.target.value);
            setApproveForm({ ...approveForm, bike_id: e.target.value, weekly_amount: b?.rental_weekly || '', total_weeks: b?.total_weeks || 78 });
          }}>
            <option value="">— Select available bike —</option>
            {bikes.map(b => <option key={b.id} value={b.id}>{b.make} {b.model} ({b.vin}) — {fmt(b.rental_weekly)}/wk</option>)}
          </select></div>
        <div className="grid grid-2">
          <div className="field"><label className="label">Weekly amount (R)</label>
            <input type="number" value={approveForm.weekly_amount} onChange={e => setApproveForm({...approveForm, weekly_amount: e.target.value})} /></div>
          <div className="field"><label className="label">Total weeks (78 = 18 months)</label>
            <input type="number" value={approveForm.total_weeks} onChange={e => setApproveForm({...approveForm, total_weeks: +e.target.value})} /></div>
        </div>
        <div className="field"><label className="label">Start date</label>
          <input type="date" value={approveForm.start_date} onChange={e => setApproveForm({...approveForm, start_date: e.target.value})} /></div>
        <div className="card mb-3" style={{ background: 'var(--surface-2)' }}>
          <strong>Total contract value: {fmt((approveForm.weekly_amount||0) * (approveForm.total_weeks||0))}</strong>
        </div>
        <div className="row">
          <button className="btn btn-success" onClick={approve}>Confirm approve</button>
          <button className="btn btn-secondary" onClick={() => setShowApprove(false)}>Cancel</button>
        </div>
      </Modal>}

      {showReject && <Modal title="Reject application" onClose={() => setShowReject(false)}>
        <div className="field"><label className="label">Reason</label>
          <textarea rows={4} value={rejectReason} onChange={e => setRejectReason(e.target.value)} /></div>
        <div className="row"><button className="btn btn-danger" onClick={reject}>Confirm reject</button>
        <button className="btn btn-secondary" onClick={() => setShowReject(false)}>Cancel</button></div>
      </Modal>}
    </>
  );
}

function Row({ k, v }) {
  return <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
    <span className="muted text-sm">{k}</span><span style={{ textAlign: 'right' }}>{v || '—'}</span>
  </div>;
}

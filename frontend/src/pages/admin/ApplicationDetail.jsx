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
  const [approveForm, setApproveForm] = useState({ bike_id: '', weekly_amount: '', total_weeks: 78, start_date: new Date().toISOString().slice(0, 10) });
  const [rejectReason, setRejectReason] = useState('');

  const load = () => api.get(`/applications/${id}`).then((response) => setData(response.data));
  useEffect(() => {
    load();
    api.get('/bikes', { params: { status: 'available' } }).then((response) => setBikes(response.data.bikes));
  }, [id]);

  if (!data) return <Loading />;
  const application = data.application;
  const documents = data.documents || [];
  const payslips = documents.filter((doc) => doc.doc_type === 'payslip');

  const approve = async () => {
    if (!approveForm.bike_id || !approveForm.weekly_amount) return toast.error('Bike and weekly amount are required');
    try {
      const response = await api.post(`/applications/${id}/approve`, approveForm);
      toast.success(`Agreement ${response.data.agreement_no} created`);
      nav(`/admin/agreements/${response.data.agreement_id}`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not approve application');
    }
  };

  const reject = async () => {
    try {
      await api.post(`/applications/${id}/reject`, { reason: rejectReason });
      toast.success('Application rejected');
      setShowReject(false);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reject application');
    }
  };

  return (
    <>
      <Link to="/admin/applications" className="muted text-sm">← Back</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">Application #{application.id}</h1>
          <div className="muted">Submitted {fmtDate(application.submitted_at)}</div>
        </div>
        <Badge status={application.status}>{application.auto_decision === 'pre_approved' ? 'pre-approved' : application.status}</Badge>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Payslips" value={`${payslips.length} / 3`} />
        <Stat label="Total paid" value={application.total_paid_last_3 ? fmt(application.total_paid_last_3) : 'Pending'} />
        <Stat label="Avg weekly earnings" value={application.average_weekly_earnings ? fmt(application.average_weekly_earnings) : 'Pending'} />
        <Stat label="Payout" value={application.payout_preference || '—'} />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="mb-3">Rider details</h3>
          <Row k="Name" v={application.full_name} />
          <Row k="Email" v={application.email} />
          <Row k="Phone" v={application.phone} />
          <Row k="ID Number" v={application.id_number} />
          <Row k="Address" v={[application.address, application.city, application.province].filter(Boolean).join(', ')} />
        </div>
        <div className="card">
          <h3 className="mb-3">Application details</h3>
          <Row k="Bike preference" v={application.make ? `${application.make} ${application.model}` : '—'} />
          <Row k="Delivery platforms" v={application.delivery_platforms || '—'} />
          <Row k="Riding experience" v={application.has_riding_experience ? `${application.years_riding || 0} years` : 'None'} />
          <Row k="Driver's licence" v={application.has_drivers_license ? 'Yes' : 'No'} />
          <Row k="Auto decision" v={application.auto_decision ? application.auto_decision.replace(/_/g, ' ') : 'Pending'} />
          <Row k="Retry after" v={application.retry_after_date ? fmtDate(application.retry_after_date) : '—'} />
        </div>
      </div>

      <div className="card mt-4">
        <h3 className="mb-3">Payout details</h3>
        {application.payout_preference === 'ewallet' ? (
          <Row k="E-wallet number" v={application.ewallet_number || '—'} />
        ) : (
          <>
            <Row k="Bank" v={application.bank_name || '—'} />
            <Row k="Account holder" v={application.account_holder || '—'} />
            <Row k="Account number" v={application.account_number || '—'} />
            <Row k="Branch code" v={application.branch_code || '—'} />
          </>
        )}
      </div>

      <div className="card mt-4">
        <div className="flex-between mb-3">
          <h3>Application documents</h3>
          {data.agreement?.contract_file_path && <a className="btn btn-sm btn-secondary" href={data.agreement.contract_file_path} target="_blank" rel="noreferrer">View contract</a>}
        </div>
        <table className="table">
          <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Extracted amount</th><th></th></tr></thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.doc_type.replace(/_/g, ' ')}</td>
                <td>{doc.original_name}</td>
                <td>{fmtDate(doc.uploaded_at)}</td>
                <td>{doc.extracted_amount ? fmt(doc.extracted_amount) : '—'}</td>
                <td><a href={doc.file_path} className="btn btn-sm btn-secondary" target="_blank" rel="noreferrer">Open</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!documents.length && <div className="muted text-sm">No documents uploaded yet.</div>}
        {data.agreement?.signed_contract_path && <div className="mt-3"><a href={data.agreement.signed_contract_path} target="_blank" rel="noreferrer">Signed contract</a></div>}
      </div>

      {['submitted', 'under_review'].includes(application.status) && (
        <div className="row mt-4">
          <button className="btn btn-success" onClick={() => setShowApprove(true)}>Approve & allocate bike</button>
          <button className="btn btn-danger" onClick={() => setShowReject(true)}>Reject</button>
        </div>
      )}

      {showApprove && (
        <Modal title="Approve & allocate bike" onClose={() => setShowApprove(false)}>
          <div className="field"><label className="label">Bike</label>
            <select value={approveForm.bike_id} onChange={(e) => {
              const bike = bikes.find((item) => item.id === Number(e.target.value));
              setApproveForm({ ...approveForm, bike_id: e.target.value, weekly_amount: bike?.rental_weekly || '', total_weeks: bike?.total_weeks || 78 });
            }}>
              <option value="">— Select available bike —</option>
              {bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.make} {bike.model} · {fmt(bike.rental_weekly)}/week</option>)}
            </select></div>
          <div className="grid grid-2">
            <div className="field"><label className="label">Weekly amount</label><input type="number" value={approveForm.weekly_amount} onChange={(e) => setApproveForm({ ...approveForm, weekly_amount: e.target.value })} /></div>
            <div className="field"><label className="label">Total weeks</label><input type="number" value={approveForm.total_weeks} onChange={(e) => setApproveForm({ ...approveForm, total_weeks: Number(e.target.value) })} /></div>
          </div>
          <div className="field"><label className="label">Start date</label><input type="date" value={approveForm.start_date} onChange={(e) => setApproveForm({ ...approveForm, start_date: e.target.value })} /></div>
          <div className="card mb-3" style={{ background: 'var(--surface-2)' }}><strong>Total contract value: {fmt((approveForm.weekly_amount || 0) * (approveForm.total_weeks || 0))}</strong></div>
          <div className="row"><button className="btn btn-success" onClick={approve}>Confirm approval</button><button className="btn btn-secondary" onClick={() => setShowApprove(false)}>Cancel</button></div>
        </Modal>
      )}

      {showReject && (
        <Modal title="Reject application" onClose={() => setShowReject(false)}>
          <div className="field"><label className="label">Reason</label><textarea rows={4} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} /></div>
          <div className="row"><button className="btn btn-danger" onClick={reject}>Confirm rejection</button><button className="btn btn-secondary" onClick={() => setShowReject(false)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

function Row({ k, v }) {
  return <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><span className="muted text-sm">{k}</span><span style={{ textAlign: 'right' }}>{v || '—'}</span></div>;
}

function Stat({ label, value }) {
  return <div className="stat"><div className="stat-label">{label}</div><div className="stat-value" style={{ fontSize: 22 }}>{value}</div></div>;
}

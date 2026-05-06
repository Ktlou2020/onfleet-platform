import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, fmtDate } from '../../components/ui';

export default function AdminKyc() {
  const [docs, setDocs] = useState(null);
  const [filter, setFilter] = useState('pending');
  const [reject, setReject] = useState(null);
  const [reason, setReason] = useState('');

  const load = () => api.get('/kyc/all', { params: { status: filter } }).then(r => setDocs(r.data.documents));
  useEffect(() => { load(); }, [filter]);

  const review = async (id, status, rejection_reason) => {
    await api.post(`/kyc/${id}/review`, { status, rejection_reason });
    toast.success(status === 'approved' ? 'Approved' : 'Rejected'); load(); setReject(null);
  };

  if (!docs) return <Loading />;
  return (
    <>
      <h1 className="page-title">KYC Review</h1>
      <p className="page-sub">Verify rider documents</p>
      <div className="row mb-4">
        {['pending','approved','rejected'].map(s =>
          <button key={s} onClick={() => setFilter(s)}
            className={`btn btn-sm ${filter === s ? '' : 'btn-secondary'}`}>{s}</button>)}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Uploaded</th><th>Rider</th><th>Type</th><th>File</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {docs.map(d => (
              <tr key={d.id}>
                <td>{fmtDate(d.uploaded_at)}</td>
                <td>{d.full_name}<div className="text-xs muted">{d.email}</div></td>
                <td>{d.doc_type.replace(/_/g,' ')}</td>
                <td className="text-sm muted">{d.original_name}</td>
                <td><Badge status={d.status}/></td>
                <td>{filter === 'pending' && <div className="row">
                  <button className="btn btn-sm btn-success" onClick={() => review(d.id, 'approved')}>Approve</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setReject(d)}>Reject</button>
                </div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!docs.length && <div className="muted" style={{padding:24,textAlign:'center'}}>No {filter} documents.</div>}
      </div>

      {reject && <Modal title="Reject KYC document" onClose={() => setReject(null)}>
        <p className="muted mb-3">{reject.full_name} · {reject.doc_type}</p>
        <div className="field"><label className="label">Reason</label>
          <textarea rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Document is blurry, expired, etc."/></div>
        <div className="row"><button className="btn btn-danger" onClick={() => review(reject.id, 'rejected', reason)}>Reject</button>
        <button className="btn btn-secondary" onClick={() => setReject(null)}>Cancel</button></div>
      </Modal>}
    </>
  );
}

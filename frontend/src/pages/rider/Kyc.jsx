import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, fmtDate } from '../../components/ui';
import { Upload } from 'lucide-react';

const TYPES = [
  { v: 'id_document', l: 'ID Document' },
  { v: 'proof_of_address', l: 'Proof of Address (≤ 3 months)' },
  { v: 'drivers_license', l: 'Driver\'s License' },
  { v: 'bank_statement', l: 'Bank Statement (≤ 3 months)' },
  { v: 'selfie', l: 'Selfie holding ID' }
];

export default function RiderKyc() {
  const [docs, setDocs] = useState(null);
  const load = () => api.get('/kyc/mine').then(r => setDocs(r.data.documents));
  useEffect(() => { load(); }, []);

  const upload = async (e, doc_type) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file); fd.append('doc_type', doc_type);
    try {
      await api.post('/kyc/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Uploaded. Pending review.');
      load();
    } catch { toast.error('Upload failed'); }
  };

  if (!docs) return <Loading />;
  return (
    <>
      <h1 className="page-title">KYC Documents</h1>
      <p className="page-sub">Upload required documents for verification</p>

      <div className="grid grid-2">
        {TYPES.map(t => {
          const mine = docs.filter(d => d.doc_type === t.v);
          return (
            <div className="card" key={t.v}>
              <div className="flex-between mb-3">
                <h3>{t.l}</h3>
                {mine[0] && <Badge status={mine[0].status} />}
              </div>
              {mine.length === 0 && <div className="muted text-sm mb-3">Not uploaded yet.</div>}
              {mine.map(d => (
                <div key={d.id} className="text-sm muted mb-2">
                  📄 {d.original_name} · {fmtDate(d.uploaded_at)}
                  {d.rejection_reason && <div className="text-xs" style={{ color: 'var(--danger)' }}>Reason: {d.rejection_reason}</div>}
                </div>
              ))}
              <label className="btn btn-secondary btn-block" style={{ cursor: 'pointer' }}>
                <Upload size={14} /> {mine.length ? 'Upload another' : 'Upload'}
                <input type="file" accept="image/*,application/pdf" hidden onChange={e => upload(e, t.v)} />
              </label>
            </div>
          );
        })}
      </div>
    </>
  );
}

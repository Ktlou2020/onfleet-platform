import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FileText, Upload, ExternalLink } from 'lucide-react';
import api from '../api';
import { Modal, Badge, fmtDateTime } from './ui';

// Mirrors the doc_type whitelist enforced by POST /kyc/upload — anything not on
// this list is rejected server-side, so the two must stay in step.
const DOC_TYPES = [
  { value: 'id_document',      label: 'ID document' },
  { value: 'drivers_license',  label: "Driver's licence" },
  { value: 'selfie',           label: 'Selfie holding ID' },
  { value: 'proof_of_address', label: 'Proof of address' },
  { value: 'bank_statement',   label: 'Bank statement' },
  { value: 'other',            label: 'Other' },
];

const ACCEPT = 'application/pdf,image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.heic,.heif';

/**
 * Lets an admin file a rider's paperwork for them — riders routinely hand
 * documents in at a hub or email them, and previously the only way onto their
 * record was to ask the rider to upload it themselves. Shows what's already on
 * file first, so the same document isn't filed twice.
 */
export default function RiderDocumentsModal({ rider, onClose }) {
  const [docs, setDocs] = useState(null);
  const [docType, setDocType] = useState('id_document');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/kyc/user/${rider.id}`);
      setDocs(data.documents);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load documents');
      setDocs([]);
    }
  }, [rider.id]);

  useEffect(() => { load(); }, [load]);

  const upload = async () => {
    if (!file) return toast.error('Choose a file first');
    const fd = new FormData();
    fd.append('doc_type', docType);
    fd.append('user_id', rider.id);
    fd.append('file', file);
    setUploading(true);
    try {
      await api.post('/kyc/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`Filed to ${rider.full_name}`);
      setFile(null);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not upload document');
    } finally {
      setUploading(false);
    }
  };

  return (
    // Only the max-width is raised: .modal already sets width:100%, so it still
    // shrinks to fit a narrow screen. Widened on the modal rather than by giving
    // the content a min-width, since a child wider than the modal's box makes
    // the whole dialog scroll sideways instead of the table scrolling in place.
    <Modal isOpen onClose={onClose} title={`Documents — ${rider.full_name}`} style={{ maxWidth: 760 }}>
      <div>
        <div className="muted text-sm mb-3">
          Uploaded here on the rider's behalf. The rider sees these in their own portal, and the
          audit log records that you filed them.
        </div>

        <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
          <div className="grid grid-2" style={{ alignItems: 'end', gap: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">Document type</label>
              <select value={docType} onChange={(e) => setDocType(e.target.value)}>
                {DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">File</label>
              <input type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </div>
          </div>
          <div className="muted text-xs mt-2">PDF, JPG, PNG, WEBP or HEIC (iPhone photos are converted automatically).</div>
          <div className="row mt-3">
            <button className="btn" onClick={upload} disabled={uploading || !file}>
              <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload for this rider'}
            </button>
          </div>
        </div>

        <div className="card-title"><h3 style={{ fontSize: 15 }}>Already on file</h3></div>
        {docs === null ? (
          <div className="muted text-sm">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="muted text-sm">No documents on file for this rider yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Type</th><th>File</th><th>Status</th><th>Uploaded</th><th /></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>{DOC_TYPES.find((t) => t.value === d.doc_type)?.label || d.doc_type}</td>
                    <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <FileText size={12} style={{ marginRight: 5, verticalAlign: -1 }} />{d.original_name}
                    </td>
                    <td><Badge status={d.status} /></td>
                    <td className="text-xs muted">{fmtDateTime(d.uploaded_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <a className="btn btn-sm btn-secondary" href={`/api/kyc/file/${d.id}`} target="_blank" rel="noreferrer">
                        <ExternalLink size={12} /> View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

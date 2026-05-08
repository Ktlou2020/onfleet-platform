import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Loading, fmt, fmtDate } from '../../components/ui';

export default function RiderKyc() {
  const [apps, setApps] = useState(null);
  useEffect(() => { api.get('/applications/mine').then((response) => setApps(response.data.applications)); }, []);
  if (!apps) return <Loading />;
  const latest = apps[0];

  return (
    <>
      <h1 className="page-title">Documents Centre</h1>
      <p className="page-sub">All KYC and application documents now live under your Application tab.</p>
      {!latest ? (
        <div className="card">
          <strong>No application yet</strong>
          <div className="muted text-sm mt-2">Create an application first, then upload your ID, driver's licence, and 3 latest payslips.</div>
          <div className="mt-3"><Link to="/application" className="btn">Start application</Link></div>
        </div>
      ) : (
        <div className="card">
          <div className="flex-between mb-3">
            <div>
              <strong>Latest application #{latest.id}</strong>
              <div className="muted text-sm">Average weekly earnings: {latest.average_weekly_earnings ? fmt(latest.average_weekly_earnings) : 'Pending'}</div>
            </div>
            <Link to="/application" className="btn btn-secondary">Manage documents</Link>
          </div>
          <table className="table">
            <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Extracted amount</th><th></th></tr></thead>
            <tbody>
              {(latest.documents || []).map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.doc_type.replace(/_/g, ' ')}</td>
                  <td>{doc.original_name}</td>
                  <td>{fmtDate(doc.uploaded_at)}</td>
                  <td>{doc.extracted_amount ? fmt(doc.extracted_amount) : '—'}</td>
                  <td><a className="btn btn-sm btn-secondary" href={doc.file_path} target="_blank" rel="noreferrer">View</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Loading, SearchInput, fmt, fmtDate, matchesSearch } from '../../components/ui';

export default function RiderKyc() {
  const [apps, setApps] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => { api.get('/applications/mine').then((response) => setApps(response.data.applications)); }, []);

  const appList = apps || [];
  const latest = appList[0];
  const filteredDocs = useMemo(() => (latest?.documents || []).filter((doc) => matchesSearch(
    search,
    doc.doc_type,
    doc.original_name,
    doc.uploaded_at,
    doc.extracted_amount
  )), [latest, search]);

  if (!apps) return <Loading />;

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
          <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <strong>Latest application #{latest.id}</strong>
              <div className="muted text-sm">Average weekly earnings: {latest.average_weekly_earnings ? fmt(latest.average_weekly_earnings) : 'Pending'}</div>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search document type or filename" style={{ width: 320 }} />
              <Link to="/application" className="btn btn-secondary">Manage documents</Link>
            </div>
          </div>
          <table className="table">
            <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Extracted amount</th><th></th></tr></thead>
            <tbody>
              {filteredDocs.map((doc) => (
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
          {!filteredDocs.length && <div className="muted text-sm" style={{ paddingTop: 16 }}>{search ? 'No documents match your search.' : 'No documents uploaded yet.'}</div>}
        </div>
      )}
    </>
  );
}

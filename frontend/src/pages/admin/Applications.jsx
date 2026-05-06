import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { Loading, Badge, fmt, fmtDate } from '../../components/ui';

export default function AdminApplications() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const [list, setList] = useState(null);
  useEffect(() => {
    api.get('/applications', { params: status ? { status } : {} }).then(r => setList(r.data.applications));
  }, [status]);
  if (!list) return <Loading />;
  return (
    <>
      <h1 className="page-title">Applications</h1>
      <p className="page-sub">Review rider applications</p>
      <div className="row mb-4">
        {['','submitted','approved','rejected'].map(s =>
          <button key={s} onClick={() => setParams(s ? { status: s } : {})}
            className={`btn btn-sm ${status === s ? '' : 'btn-secondary'}`}>{s || 'All'}</button>)}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Submitted</th><th>Rider</th><th>Bike</th><th>Income</th><th>Platforms</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.map(a => (
              <tr key={a.id}>
                <td>{fmtDate(a.submitted_at)}</td>
                <td><strong>{a.full_name}</strong><div className="text-xs muted">{a.email}</div></td>
                <td>{a.make ? `${a.make} ${a.model}` : '—'}</td>
                <td>{fmt(a.monthly_income)}</td>
                <td className="text-xs muted">{a.delivery_platforms}</td>
                <td><Badge status={a.status} /></td>
                <td><Link to={`/admin/applications/${a.id}`} className="btn btn-sm btn-secondary">Review</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>No applications.</div>}
      </div>
    </>
  );
}

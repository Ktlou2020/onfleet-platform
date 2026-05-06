import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { Loading, Badge, fmt, fmtDate } from '../../components/ui';

export default function AdminAgreements() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const [list, setList] = useState(null);
  useEffect(() => {
    api.get('/agreements', { params: status ? { status } : {} }).then(r => setList(r.data.agreements));
  }, [status]);
  if (!list) return <Loading />;
  return (
    <>
      <h1 className="page-title">Agreements</h1>
      <p className="page-sub">All rent-to-own agreements</p>
      <div className="row mb-4">
        {['','active','completed','defaulted','cancelled'].map(s =>
          <button key={s} onClick={() => setParams(s ? { status: s } : {})}
            className={`btn btn-sm ${status === s ? '' : 'btn-secondary'}`}>{s || 'All'}</button>)}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Agreement</th><th>Rider</th><th>Bike</th><th>Weekly</th><th>Total</th><th>Start</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.map(a => (
              <tr key={a.id}>
                <td><strong>{a.agreement_no}</strong></td>
                <td>{a.full_name}<div className="text-xs muted">{a.email}</div></td>
                <td>{a.make} {a.model}<div className="text-xs muted">{a.registration}</div></td>
                <td>{fmt(a.weekly_amount)}</td>
                <td>{fmt(a.total_amount)}</td>
                <td>{fmtDate(a.start_date)}</td>
                <td><Badge status={a.status}/></td>
                <td><Link to={`/admin/agreements/${a.id}`} className="btn btn-sm btn-secondary">View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="muted" style={{ padding: 24, textAlign:'center' }}>No agreements.</div>}
      </div>
    </>
  );
}

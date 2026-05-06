import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Loading, Badge, fmt, fmtDate, EmptyState } from '../../components/ui';

export default function RiderAgreements() {
  const [list, setList] = useState(null);
  useEffect(() => { api.get('/agreements/mine').then(r => setList(r.data.agreements)); }, []);
  if (!list) return <Loading />;
  return (
    <>
      <h1 className="page-title">My Agreements</h1>
      <p className="page-sub">All your rent-to-own contracts</p>
      {!list.length ? <EmptyState title="No agreements yet"
        sub="Once your application is approved, your agreement appears here."
        action={<Link to="/application" className="btn">Apply now</Link>} /> :
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Agreement</th><th>Bike</th><th>Weekly</th><th>Total</th><th>Start</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.map(a => (
              <tr key={a.id}>
                <td><strong>{a.agreement_no}</strong></td>
                <td>{a.make} {a.model}</td>
                <td>{fmt(a.weekly_amount)}</td>
                <td>{fmt(a.total_amount)}</td>
                <td>{fmtDate(a.start_date)}</td>
                <td><Badge status={a.status} /></td>
                <td><Link to={`/agreements/${a.id}`} className="btn btn-sm btn-secondary">Open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </>
  );
}

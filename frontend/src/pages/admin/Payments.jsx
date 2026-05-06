import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Loading, Badge, fmt, fmtDateTime } from '../../components/ui';

export default function AdminPayments() {
  const [list, setList] = useState(null);
  useEffect(() => { api.get('/payments/all').then(r => setList(r.data.payments)); }, []);
  if (!list) return <Loading />;
  const total = list.filter(p => p.status === 'success').reduce((s,p) => s + p.amount, 0);
  return (
    <>
      <h1 className="page-title">Payments</h1>
      <p className="page-sub">All recorded payments · Total received {fmt(total)}</p>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Date</th><th>Rider</th><th>Agreement</th><th>Method</th><th>Reference</th><th>Status</th><th>Amount</th></tr></thead>
          <tbody>
            {list.map(p => (
              <tr key={p.id}>
                <td>{fmtDateTime(p.paid_at || p.created_at)}</td>
                <td>{p.full_name}<div className="text-xs muted">{p.email}</div></td>
                <td><Link to={`/admin/agreements/${p.agreement_id}`}>{p.agreement_no}</Link></td>
                <td><Badge>{p.method}</Badge></td>
                <td className="text-xs muted">{p.reference}</td>
                <td><Badge status={p.status}/></td>
                <td><strong>{fmt(p.amount)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="muted" style={{padding:24,textAlign:'center'}}>No payments yet.</div>}
      </div>
    </>
  );
}

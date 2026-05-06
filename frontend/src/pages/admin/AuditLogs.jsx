import { useEffect, useState } from 'react';
import api from '../../api';
import { Loading, fmtDateTime } from '../../components/ui';

export default function AdminAuditLogs() {
  const [logs, setLogs] = useState(null);
  useEffect(() => { api.get('/admin/audit-logs').then(r => setLogs(r.data.logs)); }, []);
  if (!logs) return <Loading />;
  return (
    <>
      <h1 className="page-title">Audit Logs</h1>
      <p className="page-sub">Last 200 system events</p>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Metadata</th><th>IP</th></tr></thead>
          <tbody>
            {logs.map(l => (
              <tr key={l.id}>
                <td className="text-xs">{fmtDateTime(l.created_at)}</td>
                <td>{l.full_name || `#${l.actor_id}`}</td>
                <td><span className="badge badge-info">{l.action}</span></td>
                <td>{l.entity} #{l.entity_id}</td>
                <td className="text-xs muted" style={{ maxWidth: 300, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.metadata}</td>
                <td className="text-xs muted">{l.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Loading, SearchInput, Pagination, fmtDateTime, matchesSearch, paginateItems } from '../../components/ui';

export default function AdminAuditLogs() {
  const [logs, setLogs] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => { api.get('/admin/audit-logs').then((r) => setLogs(r.data.logs)); }, []);
  useEffect(() => { setPage(1); }, [search]);

  const filtered = useMemo(() => (logs || []).filter((log) => matchesSearch(
    search,
    log.full_name,
    log.actor_id,
    log.action,
    log.entity,
    log.entity_id,
    log.metadata,
    log.ip
  )), [logs, search]);

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  if (!logs) return <Loading />;
  return (
    <>
      <h1 className="page-title">Audit Logs</h1>
      <p className="page-sub">Last 200 system events</p>
      <div className="row mb-4" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search actor, action, entity, metadata, IP" style={{ flex: '1 1 320px', maxWidth: 480 }} />
        <div className="muted text-sm">Showing {filtered.length} matching audit events</div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Metadata</th><th>IP</th></tr></thead>
          <tbody>
            {pagination.items.map((log) => (
              <tr key={log.id}>
                <td className="text-xs">{fmtDateTime(log.created_at)}</td>
                <td>{log.full_name || `#${log.actor_id}`}</td>
                <td><span className="badge badge-info">{log.action}</span></td>
                <td>{log.entity} #{log.entity_id}</td>
                <td className="text-xs muted" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.metadata}</td>
                <td className="text-xs muted">{log.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pagination.items.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{search ? 'No audit logs match your search.' : 'No audit logs yet.'}</div>}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="audit events" />
    </>
  );
}

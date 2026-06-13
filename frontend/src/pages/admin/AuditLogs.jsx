import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Loading, SearchInput, Pagination, fmtDateTime, matchesSearch, paginateItems } from '../../components/ui';
import { sortNewestFirst } from '../../utils/sortNewestFirst';
import { Download } from 'lucide-react';

function inDateRange(dateStr, from, to) {
  if (!dateStr) return true;
  const d = dateStr.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function downloadCsv(logs) {
  const headers = ['Time', 'Actor', 'Action', 'Entity', 'Entity ID', 'Metadata', 'IP'];
  const rows = logs.map((log) => [
    fmtDateTime(log.created_at),
    log.full_name || `#${log.actor_id}`,
    log.action,
    log.entity,
    log.entity_id,
    log.metadata || '',
    log.ip || ''
  ]);
  const csv = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminAuditLogs() {
  const [logs, setLogs] = useState(null);
  const [availableActions, setAvailableActions] = useState([]);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    api.get('/admin/audit-logs', { params: { limit: 500 } }).then((r) => {
      setLogs(r.data.logs);
      setAvailableActions(r.data.actions || []);
    });
  }, []);
  useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, actionFilter]);

  const filtered = useMemo(() => sortNewestFirst((logs || []).filter((log) => {
    if (!inDateRange(log.created_at, dateFrom, dateTo)) return false;
    if (actionFilter && log.action !== actionFilter) return false;
    return matchesSearch(search, log.full_name, log.actor_id, log.action, log.entity, log.entity_id, log.metadata, log.ip);
  }), ['created_at', 'id']), [logs, search, dateFrom, dateTo, actionFilter]);

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  if (!logs) return <Loading />;
  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Audit Logs</h1>
          <p className="page-sub">Last 500 system events · {filtered.length} matching</p>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={() => downloadCsv(filtered)} disabled={!filtered.length}>
          <Download size={14} /> Export CSV
        </button>
      </div>
      <div className="row mb-4" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search actor, action, entity, metadata, IP" style={{ flex: '1 1 240px', maxWidth: 380 }} />
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label">Action</label>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">All actions</option>
            {availableActions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label">From</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ width: 150 }} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label">To</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ width: 150 }} />
        </div>
        {(dateFrom || dateTo || actionFilter) && (
          <button className="btn btn-sm btn-secondary" onClick={() => { setDateFrom(''); setDateTo(''); setActionFilter(''); }}>Clear filters</button>
        )}
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
                <td className="text-xs muted" style={{ maxWidth: 300 }}>
                  <span title={log.metadata} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: log.metadata ? 'help' : 'default' }}>
                    {log.metadata || '—'}
                  </span>
                </td>
                <td className="text-xs muted">{log.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pagination.items.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{search || dateFrom || dateTo || actionFilter ? 'No audit logs match your filters.' : 'No audit logs yet.'}</div>}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="audit events" />
    </>
  );
}

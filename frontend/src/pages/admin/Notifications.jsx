import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, EmptyState, Loading, Pagination, SearchInput, fmtDateTime, Stat, matchesSearch, paginateItems } from '../../components/ui';
import { sortNewestFirst } from '../../utils/sortNewestFirst';
import { Bell, Mail, MessageSquare, Smartphone, RefreshCw, RotateCcw } from 'lucide-react';

const channelIcon = {
  email: Mail,
  sms: Smartphone,
  whatsapp: MessageSquare
};

function inDateRange(dateStr, from, to) {
  if (!dateStr) return true;
  const d = dateStr.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function NotificationRow({ item, onResend }) {
  const ChannelIcon = channelIcon[item.channel] || Bell;
  return (
    <tr>
      <td>{fmtDateTime(item.sent_at || item.created_at)}</td>
      <td>
        <strong>{item.full_name || 'System / broadcast'}</strong>
        <div className="text-xs muted">{item.email || '—'}</div>
      </td>
      <td>{item.role || '—'}</td>
      <td>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ChannelIcon size={14} /> {item.channel || 'system'}
        </div>
      </td>
      <td>
        <div style={{ fontWeight: 600 }}>{item.title || 'Platform update'}</div>
        <div className="text-xs muted">{item.type || 'update'}</div>
      </td>
      <td style={{ maxWidth: 420 }}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{item.message}</div>
      </td>
      <td>
        <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
          <Badge status={item.status}>{String(item.status || 'pending').replace(/_/g, ' ')}</Badge>
          {item.status === 'failed' && (
            <button className="btn btn-sm btn-secondary" onClick={() => onResend(item)} title="Resend this notification">
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function AdminNotifications() {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = async () => {
    try {
      setBusy(true);
      const response = await api.get('/notifications');
      setList(response.data.notifications || []);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load notifications');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, channelFilter]);

  const resend = async (item) => {
    try {
      await api.post(`/notifications/${item.id}/resend`);
      toast.success('Notification resent');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not resend notification');
    }
  };

  const filtered = useMemo(() => sortNewestFirst((list || []).filter((item) => {
    if (!inDateRange(item.sent_at || item.created_at, dateFrom, dateTo)) return false;
    if (channelFilter && item.channel !== channelFilter) return false;
    return matchesSearch(search, item.full_name, item.email, item.role, item.channel, item.type, item.title, item.message, item.status);
  }), ['sent_at', 'created_at', 'id']), [list, search, dateFrom, dateTo, channelFilter]);

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  const stats = useMemo(() => {
    const notifications = list || [];
    return {
      total: notifications.length,
      sent: notifications.filter((item) => item.status === 'sent').length,
      read: notifications.filter((item) => item.status === 'read').length,
      failed: notifications.filter((item) => item.status === 'failed').length
    };
  }, [list]);

  if (!list) return <Loading />;

  return (
    <>
      <div className="flex-between mb-2" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-sub">Monitor the latest emails and platform updates sent to riders and admins.</p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={busy}><RefreshCw size={16} /> Refresh</button>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Total updates" value={stats.total} icon={<Bell size={16} />} />
        <Stat label="Sent" value={stats.sent} icon={<Mail size={16} />} accent="var(--success)" />
        <Stat label="Read" value={stats.read} icon={<MessageSquare size={16} />} accent="var(--primary-light)" />
        <Stat label="Failed" value={stats.failed} icon={<Smartphone size={16} />} accent="var(--danger)" />
      </div>

      <div className="row mb-4" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search recipient, channel, title, message" style={{ flex: '1 1 240px', maxWidth: 380 }} />
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label">Channel</label>
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} style={{ minWidth: 140 }}>
            <option value="">All channels</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="in_app">In-app</option>
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
        {(dateFrom || dateTo || channelFilter) && (
          <button className="btn btn-sm btn-secondary" onClick={() => { setDateFrom(''); setDateTo(''); setChannelFilter(''); }}>Clear filters</button>
        )}
        <div className="muted text-sm">Showing {filtered.length} notifications</div>
      </div>

      {pagination.items.length ? (
        <>
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Recipient</th>
                  <th>Role</th>
                  <th>Channel</th>
                  <th>Update</th>
                  <th>Message</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pagination.items.map((item) => <NotificationRow key={item.id} item={item} onResend={resend} />)}
              </tbody>
            </table>
          </div>
          <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="notifications" />
        </>
      ) : (
        <EmptyState title="No notifications found" sub={search || dateFrom || dateTo || channelFilter ? 'Try adjusting your filters.' : 'Emails, approval updates, rejections, and other platform messages will appear here.'} />
      )}
    </>
  );
}

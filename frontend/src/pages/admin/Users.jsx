import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { useAuth } from '../../auth';
import { Loading, Badge, SearchInput, fmtDate, Modal, Pagination, matchesSearch, CopyableContactValue, normalizePhoneInput } from '../../components/ui';

const SPECIAL_AUDIENCE_TAG = 'password-reset-batch-2026-05';

const bulkScopeOptions = [
  { value: 'selected', label: 'Selected users' },
  { value: 'filtered', label: 'Filtered results' },
  { value: 'special_tagged', label: 'Special tagged users' },
  { value: 'all_active', label: 'All active users' },
  { value: 'riders_active', label: 'Active riders only' },
  { value: 'admins_active', label: 'Active admins only' },
  { value: 'all', label: 'All users including suspended' }
];

function tagList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function AdminUsers() {
  const { user } = useAuth();
  const [users, setUsers] = useState(null);
  const [providerInfo, setProviderInfo] = useState(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [showCreate, setShowCreate] = useState(false);
  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [showBulkReset, setShowBulkReset] = useState(false);
  const [sendingBulkEmail, setSendingBulkEmail] = useState(false);
  const [sendingBulkReset, setSendingBulkReset] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', password: '', role: 'rider' });
  const [roleEdits, setRoleEdits] = useState({});
  const [bulkEmailForm, setBulkEmailForm] = useState({
    scope: 'filtered',
    subject: '',
    message: '',
    include_in_app: true
  });
  const [bulkResetForm, setBulkResetForm] = useState({
    scope: 'filtered',
    message: 'Please use the secure link below to set a new password for your OnFleet account.'
  });

  const load = async () => {
    const [usersRes, providerRes] = await Promise.all([
      api.get('/admin/users'),
      api.get('/admin/email-provider-status')
    ]);
    setUsers(usersRes.data.users || []);
    setProviderInfo(providerRes.data || null);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(1); }, [search, filter, tagFilter]);

  useEffect(() => {
    if (!users) return;
    const next = {};
    users.forEach((account) => { next[account.id] = account.role; });
    setRoleEdits(next);
  }, [users]);

  useEffect(() => {
    if (!users) return;
    setSelectedIds((prev) => prev.filter((id) => users.some((account) => account.id === id)));
  }, [users]);

  const filtered = useMemo(() => {
    const normalizedTag = tagFilter.trim().toLowerCase();
    return (users || []).filter((account) => {
      if (filter && account.role !== filter) return false;
      const tags = tagList(account.user_tags);
      if (normalizedTag && !tags.some((tag) => tag.toLowerCase().includes(normalizedTag))) return false;
      return matchesSearch(
        search,
        account.full_name,
        account.email,
        account.phone,
        account.country_of_origin,
        account.role,
        account.status,
        account.id,
        account.user_tags
      );
    });
  }, [users, filter, search, tagFilter]);

  const pagination = useMemo(() => {
    const safeItems = Array.isArray(filtered) ? filtered : [];
    const safePageSize = Math.max(1, Number(pageSize) || 10);
    const totalPages = Math.max(1, Math.ceil(safeItems.length / safePageSize));
    const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const startIndex = (currentPage - 1) * safePageSize;
    return {
      items: safeItems.slice(startIndex, startIndex + safePageSize),
      currentPage,
      pageSize: safePageSize,
      totalItems: safeItems.length
    };
  }, [filtered, page, pageSize]);

  const dirtyRoles = useMemo(() => Object.entries(roleEdits).filter(([id, role]) => {
    const account = users?.find((row) => row.id === Number(id));
    return account && account.role !== role;
  }).length, [roleEdits, users]);

  const selectedUsers = useMemo(() => (users || []).filter((account) => selectedIds.includes(account.id)), [users, selectedIds]);

  const providerLabel = useMemo(() => {
    if (!providerInfo) return 'Checking email provider…';
    if (providerInfo.provider === 'brevo') return `Brevo API · ${providerInfo.from_email}`;
    if (providerInfo.provider === 'smtp') return `SMTP fallback · ${providerInfo.from_email}`;
    return `Email logging only · ${providerInfo.from_email}`;
  }, [providerInfo]);

  const scopeTargets = (scope) => {
    const allUsers = users || [];
    switch (scope) {
      case 'selected':
        return selectedUsers;
      case 'special_tagged':
        return allUsers.filter((account) => tagList(account.user_tags).some((tag) => tag.toLowerCase() === SPECIAL_AUDIENCE_TAG.toLowerCase()));
      case 'all_active':
        return allUsers.filter((account) => account.status === 'active');
      case 'riders_active':
        return allUsers.filter((account) => account.role === 'rider' && account.status === 'active');
      case 'admins_active':
        return allUsers.filter((account) => ['admin', 'superadmin'].includes(account.role) && account.status === 'active');
      case 'all':
        return allUsers;
      case 'filtered':
      default:
        return filtered;
    }
  };

  const bulkEmailTargets = useMemo(() => scopeTargets(bulkEmailForm.scope), [users, selectedUsers, filtered, bulkEmailForm.scope]);
  const bulkResetTargets = useMemo(() => scopeTargets(bulkResetForm.scope), [users, selectedUsers, filtered, bulkResetForm.scope]);

  const toggle = async (account) => {
    const status = account.status === 'active' ? 'suspended' : 'active';
    if (!window.confirm(`${status === 'active' ? 'Activate' : 'Suspend'} ${account.full_name}?`)) return;
    await api.post(`/admin/users/${account.id}/status`, { status });
    toast.success('Updated');
    load();
  };

  const saveRole = async (account) => {
    const nextRole = roleEdits[account.id];
    if (!nextRole || nextRole === account.role) return;
    if (!window.confirm(`Change ${account.full_name} from ${account.role} to ${nextRole}?`)) return;
    try {
      await api.post(`/admin/users/${account.id}/role`, { role: nextRole });
      toast.success('Role updated');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update role');
    }
  };

  const createUser = async () => {
    try {
      await api.post('/admin/users', form);
      toast.success('User added');
      setShowCreate(false);
      setForm({ full_name: '', email: '', phone: '', password: '', role: 'rider' });
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create user');
    }
  };

  const removeUser = async (account) => {
    if (!window.confirm(`Remove ${account.full_name}? This hides the account from active users.`)) return;
    try {
      await api.delete(`/admin/users/${account.id}`);
      toast.success('User removed');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not remove user');
    }
  };

  const toggleSelected = (accountId) => {
    setSelectedIds((prev) => prev.includes(accountId)
      ? prev.filter((id) => id !== accountId)
      : [...prev, accountId]);
  };

  const toggleSelectPage = () => {
    const pageIds = pagination.items.map((account) => account.id);
    const allSelected = pageIds.every((id) => selectedIds.includes(id));
    setSelectedIds((prev) => allSelected
      ? prev.filter((id) => !pageIds.includes(id))
      : [...new Set([...prev, ...pageIds])]);
  };

  const selectFiltered = () => setSelectedIds(filtered.map((account) => account.id));
  const clearSelected = () => setSelectedIds([]);

  const sendBulkEmail = async () => {
    if (!bulkEmailTargets.length) {
      toast.error('No users match the selected scope');
      return;
    }
    if (!bulkEmailForm.subject.trim() || !bulkEmailForm.message.trim()) {
      toast.error('Subject and message are required');
      return;
    }
    setSendingBulkEmail(true);
    try {
      const response = await api.post('/admin/users/bulk-email', {
        user_ids: bulkEmailTargets.map((account) => account.id),
        subject: bulkEmailForm.subject,
        message: bulkEmailForm.message,
        include_in_app: bulkEmailForm.include_in_app
      });
      const data = response.data || {};
      toast.success(`Bulk email finished: ${data.email_sent || 0} sent${data.email_failed ? `, ${data.email_failed} failed` : ''}`);
      setShowBulkEmail(false);
      setBulkEmailForm({ scope: 'filtered', subject: '', message: '', include_in_app: true });
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Bulk email failed');
    } finally {
      setSendingBulkEmail(false);
    }
  };

  const sendBulkReset = async () => {
    const activeTargets = bulkResetTargets.filter((account) => account.status === 'active');
    if (!activeTargets.length) {
      toast.error('No active users match the selected scope');
      return;
    }
    if (!window.confirm(`Send password reset links to ${activeTargets.length} user(s)?`)) return;
    setSendingBulkReset(true);
    try {
      const response = await api.post('/admin/users/bulk-password-reset', {
        user_ids: activeTargets.map((account) => account.id),
        message: bulkResetForm.message
      });
      const data = response.data || {};
      toast.success(`Password reset email run complete: ${data.emailed || 0} sent${data.failed ? `, ${data.failed} failed` : ''}`);
      setShowBulkReset(false);
      setBulkResetForm({ scope: 'filtered', message: 'Please use the secure link below to set a new password for your OnFleet account.' });
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Bulk password reset failed');
    } finally {
      setSendingBulkReset(false);
    }
  };

  if (!users) return <Loading />;

  const pageAllSelected = pagination.items.length > 0 && pagination.items.every((account) => selectedIds.includes(account.id));
  const taggedUsers = users.filter((account) => tagList(account.user_tags).length > 0).length;
  const specialTaggedUsers = users.filter((account) => tagList(account.user_tags).some((tag) => tag.toLowerCase() === SPECIAL_AUDIENCE_TAG.toLowerCase())).length;

  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-sub">Manage riders and admins, send announcement emails, trigger secure password reset links, and filter audiences by user tag.</p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="badge badge-info">{providerLabel}</div>
          <button className="btn btn-secondary" onClick={() => setShowBulkEmail(true)}>Email users</button>
          <button className="btn btn-secondary" onClick={() => setShowBulkReset(true)}>Bulk password reset</button>
          {user?.role === 'superadmin' && <button className="btn" onClick={() => setShowCreate(true)}>+ Add user</button>}
        </div>
      </div>

      <div className="grid grid-4 mb-4">
        <div className="stat"><div className="stat-label">All users</div><div className="stat-value">{users.length}</div><div className="stat-delta muted">Loaded for bulk actions</div></div>
        <div className="stat"><div className="stat-label">Active riders</div><div className="stat-value">{users.filter((account) => account.role === 'rider' && account.status === 'active').length}</div><div className="stat-delta muted">Eligible for outreach</div></div>
        <div className="stat"><div className="stat-label">Tagged users</div><div className="stat-value">{taggedUsers}</div><div className="stat-delta muted">{specialTaggedUsers} on the special email tag</div></div>
        <div className="stat"><div className="stat-label">Selected</div><div className="stat-value">{selectedIds.length}</div><div className="stat-delta muted">Use selected scope for precise targeting</div></div>
      </div>

      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, email, phone, role, country or tag" style={{ flex: '1 1 320px', maxWidth: 460 }} />
        <SearchInput value={tagFilter} onChange={setTagFilter} placeholder="Filter by tag" style={{ flex: '0 1 240px', minWidth: 220 }} />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-secondary" onClick={selectFiltered}>Select filtered</button>
          <button className="btn btn-sm btn-secondary" onClick={clearSelected} disabled={!selectedIds.length}>Clear selected</button>
          <div className="muted text-sm">Showing {filtered.length} matching users</div>
        </div>
      </div>

      <div className="row mb-4" style={{ flexWrap: 'wrap' }}>
        {[['', 'All'], ['rider', 'Riders'], ['admin', 'Admins'], ['superadmin', 'Superadmins']].map(([value, label]) => (
          <button key={value} onClick={() => setFilter(value)} className={`btn btn-sm ${filter === value ? '' : 'btn-secondary'}`}>{label}</button>
        ))}
        {user?.role === 'superadmin' && dirtyRoles > 0 && <span className="muted text-sm">Unsaved role changes are highlighted per user.</span>}
        {!!tagFilter && <span className="badge badge-muted">Tag filter: {tagFilter}</span>}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 48 }}>
                <input type="checkbox" checked={pageAllSelected} onChange={toggleSelectPage} aria-label="Select page users" />
              </th>
              <th>User</th>
              <th>Phone</th>
              <th>Country</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((account) => {
              const pendingRole = roleEdits[account.id] || account.role;
              const roleChanged = pendingRole !== account.role;
              const tags = tagList(account.user_tags);
              return (
                <tr key={account.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(account.id)}
                      onChange={() => toggleSelected(account.id)}
                      aria-label={`Select ${account.full_name}`}
                    />
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div className="avatar" style={{ backgroundImage: account.avatar_url ? `url(${account.avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }}>{account.avatar_url ? '' : account.full_name?.[0]}</div>
                      <div>
                        <strong>{account.full_name}</strong>
                        <div className="text-xs muted">{account.email}</div>
                        {!!tags.length && (
                          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                            {tags.map((tag) => <span key={`${account.id}-${tag}`} className="badge badge-muted">{tag}</span>)}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td><CopyableContactValue value={account.phone} compact /></td>
                  <td>{account.country_of_origin || '—'}</td>
                  <td>
                    {user?.role === 'superadmin' && account.id !== user.id ? (
                      <div className="row" style={{ gap: 8 }}>
                        <select value={pendingRole} onChange={(e) => setRoleEdits((prev) => ({ ...prev, [account.id]: e.target.value }))} style={{ minWidth: 120, borderColor: roleChanged ? 'var(--primary)' : undefined }}>
                          <option value="rider">Rider</option>
                          <option value="admin">Admin</option>
                          <option value="superadmin">Superadmin</option>
                        </select>
                        <button className={`btn btn-sm ${roleChanged ? '' : 'btn-secondary'}`} disabled={!roleChanged} onClick={() => saveRole(account)}>Save role</button>
                      </div>
                    ) : (
                      <Badge>{account.role}</Badge>
                    )}
                  </td>
                  <td><Badge status={account.status} /></td>
                  <td>{fmtDate(account.created_at)}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => toggle(account)}>{account.status === 'active' ? 'Suspend' : 'Activate'}</button>
                      {user?.role === 'superadmin' && account.id !== user.id && <button className="btn btn-sm btn-danger" onClick={() => removeUser(account)}>Remove</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!pagination.items.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{search || filter || tagFilter ? 'No users match your filters.' : 'No users found.'}</div>}
      </div>
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="users" />

      {showCreate && (
        <Modal title="Add user" onClose={() => setShowCreate(false)}>
          <div className="grid grid-2">
            <div className="field"><label className="label">Full name</label><input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
            <div className="field"><label className="label">Email</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="field"><label className="label">Phone</label><input type="tel" autoComplete="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: normalizePhoneInput(e.target.value) })} /></div>
            <div className="field"><label className="label">Password</label><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            <div className="field"><label className="label">Role</label><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="rider">Rider</option><option value="admin">Admin</option>{user?.role === 'superadmin' && <option value="superadmin">Superadmin</option>}</select></div>
          </div>
          <div className="row"><button className="btn" onClick={createUser}>Create</button><button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button></div>
        </Modal>
      )}

      {showBulkEmail && (
        <Modal title="Email users" onClose={() => setShowBulkEmail(false)}>
          <div className="field">
            <label className="label">Scope</label>
            <select value={bulkEmailForm.scope} onChange={(e) => setBulkEmailForm((prev) => ({ ...prev, scope: e.target.value }))}>
              {bulkScopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <div className="text-xs muted" style={{ marginTop: 6 }}>{bulkEmailTargets.length} user(s) will receive this email. Choose “Special tagged users” to target only the {SPECIAL_AUDIENCE_TAG} audience, or use the tag filter above with “Filtered results” for any other tag.</div>
          </div>
          <div className="field">
            <label className="label">Subject</label>
            <input value={bulkEmailForm.subject} onChange={(e) => setBulkEmailForm((prev) => ({ ...prev, subject: e.target.value }))} placeholder="Important update from OnFleet" />
          </div>
          <div className="field">
            <label className="label">Message</label>
            <textarea rows="8" value={bulkEmailForm.message} onChange={(e) => setBulkEmailForm((prev) => ({ ...prev, message: e.target.value }))} placeholder="Write your message here" />
          </div>
          <label className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <input type="checkbox" checked={bulkEmailForm.include_in_app} onChange={(e) => setBulkEmailForm((prev) => ({ ...prev, include_in_app: e.target.checked }))} />
            <span>Also create in-app notifications for the same audience</span>
          </label>
          <div className="row">
            <button className="btn" disabled={sendingBulkEmail} onClick={sendBulkEmail}>{sendingBulkEmail ? 'Sending…' : 'Send email'}</button>
            <button className="btn btn-secondary" disabled={sendingBulkEmail} onClick={() => setShowBulkEmail(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {showBulkReset && (
        <Modal title="Bulk password reset" onClose={() => setShowBulkReset(false)}>
          <div className="field">
            <label className="label">Scope</label>
            <select value={bulkResetForm.scope} onChange={(e) => setBulkResetForm((prev) => ({ ...prev, scope: e.target.value }))}>
              {bulkScopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <div className="text-xs muted" style={{ marginTop: 6 }}>{bulkResetTargets.filter((account) => account.status === 'active').length} active user(s) will receive secure reset links. Choose “Special tagged users” to target only the {SPECIAL_AUDIENCE_TAG} audience, or use the tag filter above with “Filtered results” to limit the reset run to any other tag.</div>
          </div>
          <div className="field">
            <label className="label">Email intro</label>
            <textarea rows="6" value={bulkResetForm.message} onChange={(e) => setBulkResetForm((prev) => ({ ...prev, message: e.target.value }))} placeholder="Optional context for the recipients" />
          </div>
          <div className="card" style={{ marginBottom: 16, background: 'var(--surface-2)' }}>
            <strong>Recommended</strong>
            <div className="muted text-sm" style={{ marginTop: 6 }}>This sends one-time reset links rather than emailing passwords directly, which is safer and works with your existing reset page.</div>
          </div>
          <div className="row">
            <button className="btn" disabled={sendingBulkReset} onClick={sendBulkReset}>{sendingBulkReset ? 'Sending…' : 'Send reset links'}</button>
            <button className="btn btn-secondary" disabled={sendingBulkReset} onClick={() => setShowBulkReset(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

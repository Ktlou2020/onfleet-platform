import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, CopyableContactValue, EmptyState, Loading, Modal, Pagination, SearchInput, Stat, fmtDate, fmtDateTime, matchesSearch, paginateItems } from '../../components/ui';
import { getFleetRoleLabel } from '../fleet/access';
import { Building2, ShieldCheck, Users, Wallet, Settings } from 'lucide-react';

const PLAN_OPTIONS = [
  { key: 'trial',      label: 'Trial',       defaultStatus: 'trialing', maxBikes: 10,  maxAdmins: 2  },
  { key: 'small',      label: 'Small',       defaultStatus: 'active',   maxBikes: 20,  maxAdmins: 3  },
  { key: 'medium',     label: 'Medium',      defaultStatus: 'active',   maxBikes: 60,  maxAdmins: 5  },
  { key: 'large',      label: 'Large',       defaultStatus: 'active',   maxBikes: 100, maxAdmins: 10 },
  { key: 'enterprise', label: 'Enterprise',  defaultStatus: 'active',   maxBikes: 999, maxAdmins: 50 }
];
const ORG_STATUS_OPTIONS = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'];

function ChangePlanModal({ orgId, orgName, currentPlan, currentStatus, onClose, onSaved }) {
  const plan = PLAN_OPTIONS.find((p) => p.key === currentPlan) || PLAN_OPTIONS[0];
  const [selectedPlan, setSelectedPlan] = useState(plan.key);
  const [selectedStatus, setSelectedStatus] = useState(currentStatus || plan.defaultStatus);
  const [maxBikes, setMaxBikes] = useState(String(plan.maxBikes));
  const [maxAdmins, setMaxAdmins] = useState(String(plan.maxAdmins));
  const [busy, setBusy] = useState(false);

  const onPlanChange = (key) => {
    const p = PLAN_OPTIONS.find((o) => o.key === key);
    setSelectedPlan(key);
    setSelectedStatus(p.defaultStatus);
    setMaxBikes(String(p.maxBikes));
    setMaxAdmins(String(p.maxAdmins));
  };

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/organizations/${orgId}/plan`, {
        plan_key: selectedPlan,
        status: selectedStatus,
        max_bikes: Number(maxBikes),
        max_admin_users: Number(maxAdmins)
      });
      toast.success(`${orgName} plan updated to ${selectedPlan}`);
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not update plan');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Change plan" onClose={onClose}>
      <div className="muted text-sm mb-3">{orgName}</div>
      <div className="field">
        <label className="label">Plan</label>
        <select value={selectedPlan} onChange={(e) => onPlanChange(e.target.value)}>
          {PLAN_OPTIONS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label">Status</label>
        <select value={selectedStatus} onChange={(e) => setSelectedStatus(e.target.value)}>
          {ORG_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label className="label">Max bikes</label>
          <input type="number" min="1" value={maxBikes} onChange={(e) => setMaxBikes(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">Max admin users</label>
          <input type="number" min="1" value={maxAdmins} onChange={(e) => setMaxAdmins(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

const roleOptions = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];

export default function AdminFleetOwners() {
  const { user } = useAuth();
  const [urlParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [organizations, setOrganizations] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [search, setSearch] = useState(urlParams.get('search') || '');
  const [organizationFilter, setOrganizationFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busyKey, setBusyKey] = useState('');
  const [roleEdits, setRoleEdits] = useState({});
  const [planModal, setPlanModal] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/fleet-owners');
      setOrganizations(Array.isArray(data?.organizations) ? data.organizations : []);
      const nextUsers = Array.isArray(data?.users) ? data.users : [];
      setAccounts(nextUsers);
      setRoleEdits(Object.fromEntries(nextUsers.map((account) => [account.id, account.role])));
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load fleet owners');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'superadmin') load();
    else setLoading(false);
  }, [user?.role]);

  useEffect(() => { setPage(1); }, [search, organizationFilter, statusFilter, roleFilter]);

  const filtered = useMemo(() => accounts.filter((account) => {
    if (organizationFilter !== 'all' && String(account.organization_id) !== organizationFilter) return false;
    if (statusFilter !== 'all' && account.status !== statusFilter) return false;
    if (roleFilter !== 'all' && account.role !== roleFilter) return false;
    return matchesSearch(
      search,
      account.full_name,
      account.email,
      account.phone,
      account.city,
      account.role,
      account.status,
      account.organization_name,
      account.organization_status,
      account.plan_key,
      account.organization_payer_status
    );
  }), [accounts, organizationFilter, roleFilter, search, statusFilter]);

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  const stats = useMemo(() => ({
    organizations: organizations.length,
    accounts: accounts.length,
    active: accounts.filter((account) => account.status === 'active').length,
    nonPayers: organizations.filter((organization) => organization.payer_status === 'non_payer').length
  }), [accounts, organizations]);

  const saveRole = async (account) => {
    const nextRole = roleEdits[account.id];
    if (!nextRole || nextRole === account.role) return;
    setBusyKey(`role-${account.id}`);
    try {
      await api.post(`/admin/fleet-owners/${account.id}/role`, { role: nextRole });
      toast.success('Fleet owner role updated');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update fleet owner role');
    } finally {
      setBusyKey('');
    }
  };

  const toggleStatus = async (account) => {
    const nextStatus = account.status === 'active' ? 'suspended' : 'active';
    if (!window.confirm(`${nextStatus === 'active' ? 'Activate' : 'Suspend'} ${account.full_name}?`)) return;
    setBusyKey(`status-${account.id}`);
    try {
      await api.post(`/admin/fleet-owners/${account.id}/status`, { status: nextStatus });
      toast.success('Fleet owner status updated');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update fleet owner status');
    } finally {
      setBusyKey('');
    }
  };

  const sendPasswordReset = async (account) => {
    if (!window.confirm(`Send a password reset link to ${account.full_name}?`)) return;
    setBusyKey(`reset-${account.id}`);
    try {
      await api.post(`/admin/fleet-owners/${account.id}/send-password-reset`);
      toast.success('Password reset email sent');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not send password reset');
    } finally {
      setBusyKey('');
    }
  };

  if (loading) return <Loading />;

  if (user?.role !== 'superadmin') {
    return <EmptyState title="Superadmin access required" sub="Only superadmins can manage fleet-owner accounts, change roles, suspend access, or send password reset links." />;
  }

  return (
    <div>
      <div className="flex-between mb-2" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h1 className="page-title">Fleet owner management</h1>
          <p className="page-sub">Manage fleet-owner users across organizations, change their roles, suspend access, and send secure password reset links.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>Refresh</button>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Organizations" value={stats.organizations} icon={<Building2 size={16} />} />
        <Stat label="Fleet owner users" value={stats.accounts} icon={<Users size={16} />} />
        <Stat label="Active accounts" value={stats.active} icon={<ShieldCheck size={16} />} />
        <Stat label="Non-payer orgs" value={stats.nonPayers} icon={<Wallet size={16} />} />
      </div>

      <div className="card mb-4">
        <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search fleet owner, company, role, status or payer state" style={{ flex: '1 1 320px', maxWidth: 440 }} />
          <div style={{ minWidth: 200 }}>
            <label className="label">Organization</label>
            <select value={organizationFilter} onChange={(e) => setOrganizationFilter(e.target.value)}>
              <option value="all">All organizations</option>
              {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 180 }}>
            <label className="label">Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
          <div style={{ minWidth: 180 }}>
            <label className="label">Role</label>
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="all">All roles</option>
              {roleOptions.map((role) => <option key={role} value={role}>{getFleetRoleLabel(role)}</option>)}
            </select>
          </div>
        </div>
      </div>

      {planModal && (
        <ChangePlanModal
          orgId={planModal.orgId}
          orgName={planModal.orgName}
          currentPlan={planModal.currentPlan}
          currentStatus={planModal.currentStatus}
          onClose={() => setPlanModal(null)}
          onSaved={() => { setPlanModal(null); load(); }}
        />
      )}

      {!filtered.length ? (
        <EmptyState title="No fleet owners match this view" sub="Try a different organization, role, status, or search term." />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Fleet owner</th>
                <th>Organization</th>
                <th>Contact</th>
                <th>Role</th>
                <th>Status</th>
                <th>Billing</th>
                <th>Joined</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pagination.items.map((account) => {
                const nextRole = roleEdits[account.id] || account.role;
                const changedRole = nextRole !== account.role;
                return (
                  <tr key={account.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{account.full_name}</div>
                      <div className="text-xs muted">{account.email}</div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{account.organization_name}</div>
                      <div className="text-xs muted">{account.organization_bike_count} bikes · {account.organization_member_count} team members</div>
                    </td>
                    <td>
                      <CopyableContactValue value={account.phone} compact />
                      <div className="text-xs muted" style={{ marginTop: 6 }}>{account.city || '—'}</div>
                    </td>
                    <td style={{ minWidth: 210 }}>
                      <select value={nextRole} onChange={(e) => setRoleEdits((prev) => ({ ...prev, [account.id]: e.target.value }))}>
                        {roleOptions.map((role) => <option key={role} value={role}>{getFleetRoleLabel(role)}</option>)}
                      </select>
                      {changedRole && <div className="text-xs muted" style={{ marginTop: 6 }}>Unsaved role change</div>}
                    </td>
                    <td><Badge status={account.status}>{account.status}</Badge></td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Badge status={account.organization_status}>{String(account.organization_status || 'trialing').replace(/_/g, ' ')}</Badge>
                        <button
                          className="btn btn-sm btn-secondary"
                          style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => setPlanModal({ orgId: account.organization_id, orgName: account.organization_name, currentPlan: account.plan_key, currentStatus: account.organization_status })}
                          title="Change plan / status"
                        >
                          <Settings size={11} /> Change
                        </button>
                      </div>
                      <div className="text-xs muted" style={{ marginTop: 6 }}>
                        {String(account.plan_key || 'trial').replace(/_/g, ' ')} · {account.organization_payer_status === 'payer' ? 'payer' : 'non-payer'}
                      </div>
                      <div className="text-xs muted">Last payment {fmtDate(account.organization_last_payment_at)}</div>
                    </td>
                    <td>{fmtDateTime(account.created_at)}</td>
                    <td>
                      <div className="row" style={{ flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                        <button className={`btn btn-sm ${changedRole ? '' : 'btn-secondary'}`} disabled={!changedRole || busyKey === `role-${account.id}`} onClick={() => saveRole(account)}>
                          {busyKey === `role-${account.id}` ? 'Saving…' : 'Save role'}
                        </button>
                        <button className="btn btn-sm btn-secondary" disabled={account.status !== 'active' || busyKey === `reset-${account.id}`} onClick={() => sendPasswordReset(account)}>
                          {busyKey === `reset-${account.id}` ? 'Sending…' : 'Send password'}
                        </button>
                        <button className={`btn btn-sm ${account.status === 'active' ? 'btn-danger' : 'btn-secondary'}`} disabled={busyKey === `status-${account.id}`} onClick={() => toggleStatus(account)}>
                          {busyKey === `status-${account.id}` ? 'Saving…' : account.status === 'active' ? 'Suspend' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="fleet owner users" />
        </div>
      )}
    </div>
  );
}

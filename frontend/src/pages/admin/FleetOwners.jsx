import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, ConfirmModal, CopyableContactValue, EmptyState, Loading, Modal, Pagination, SearchInput, Stat, fmt, fmtDate, matchesSearch, paginateItems } from '../../components/ui';
import { getFleetRoleLabel } from '../fleet/access';
import { Building2, ShieldCheck, Users, Wallet, Settings, ChevronDown, ChevronRight, Mail, MapPin, Bike, CreditCard, KeyRound } from 'lucide-react';

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
          {ORG_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
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
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busyKey, setBusyKey] = useState('');
  const [roleEdits, setRoleEdits] = useState({});
  const [planModal, setPlanModal] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [confirmModal, setConfirmModal] = useState(null);
  const orgParamApplied = useRef(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/fleet-owners');
      const orgs = Array.isArray(data?.organizations) ? data.organizations : [];
      setOrganizations(orgs);
      const nextUsers = Array.isArray(data?.users) ? data.users : [];
      setAccounts(nextUsers);
      setRoleEdits(Object.fromEntries(nextUsers.map((a) => [a.id, a.role])));

      // On first load: if ?org=<id> in URL, pre-fill search + expand that org
      const orgId = urlParams.get('org');
      if (orgId && !orgParamApplied.current) {
        orgParamApplied.current = true;
        const target = orgs.find((o) => String(o.id) === orgId);
        if (target) {
          setSearch(target.name);
          setExpanded(new Set([target.id]));
        }
      }
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

  useEffect(() => { setPage(1); }, [search, statusFilter]);

  // Group accounts by organization
  const byOrg = useMemo(() => {
    const map = {};
    for (const a of accounts) {
      if (!map[a.organization_id]) map[a.organization_id] = [];
      map[a.organization_id].push(a);
    }
    return map;
  }, [accounts]);

  const filteredOrgs = useMemo(() => organizations.filter((org) => {
    if (statusFilter !== 'all' && org.status !== statusFilter) return false;
    const members = byOrg[org.id] || [];
    const memberTerms = members.flatMap((m) => [m.full_name, m.email, m.phone, m.city]);
    return matchesSearch(search, org.name, org.contact_email, org.contact_phone, org.city, org.plan_key, org.status, org.payer_status, ...memberTerms);
  }), [organizations, byOrg, statusFilter, search]);

  const pagination = useMemo(() => paginateItems(filteredOrgs, page, pageSize), [filteredOrgs, page, pageSize]);

  const stats = useMemo(() => ({
    organizations: organizations.length,
    accounts: accounts.length,
    active: organizations.filter((o) => o.status === 'active').length,
    nonPayers: organizations.filter((o) => o.payer_status === 'non_payer').length
  }), [accounts, organizations]);

  const toggleExpanded = (orgId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(orgId) ? next.delete(orgId) : next.add(orgId);
      return next;
    });
  };

  const saveRole = async (account) => {
    const nextRole = roleEdits[account.id];
    if (!nextRole || nextRole === account.role) return;
    setBusyKey(`role-${account.id}`);
    try {
      await api.post(`/admin/fleet-owners/${account.id}/role`, { role: nextRole });
      toast.success('Role updated');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update role');
    } finally {
      setBusyKey('');
    }
  };

  const toggleStatus = (account) => {
    const nextStatus = account.status === 'active' ? 'suspended' : 'active';
    setConfirmModal({
      title: nextStatus === 'active' ? 'Activate account' : 'Suspend account',
      body: nextStatus === 'active'
        ? `Activate ${account.full_name}? They will regain access to the fleet portal.`
        : `Suspend ${account.full_name}? They will immediately lose access to the fleet portal.`,
      confirmLabel: nextStatus === 'active' ? 'Activate' : 'Suspend',
      danger: nextStatus === 'suspended',
      key: `status-${account.id}`,
      onConfirm: async () => {
        setBusyKey(`status-${account.id}`);
        try {
          await api.post(`/admin/fleet-owners/${account.id}/status`, { status: nextStatus });
          toast.success('Account status updated');
          await load();
        } catch (error) {
          toast.error(error.response?.data?.error || 'Could not update status');
        } finally {
          setBusyKey('');
          setConfirmModal(null);
        }
      }
    });
  };

  const sendPasswordReset = (account) => {
    setConfirmModal({
      title: 'Send password reset',
      body: `Send a secure password reset link to ${account.full_name} at ${account.email}? The link expires after 60 minutes.`,
      confirmLabel: 'Send link',
      danger: false,
      key: `reset-${account.id}`,
      onConfirm: async () => {
        setBusyKey(`reset-${account.id}`);
        try {
          await api.post(`/admin/fleet-owners/${account.id}/send-password-reset`);
          toast.success('Password reset email sent');
          setConfirmModal(null);
        } catch (error) {
          toast.error(error.response?.data?.error || 'Could not send password reset');
        } finally {
          setBusyKey('');
        }
      }
    });
  };

  if (loading) return <Loading />;

  if (user?.role !== 'superadmin') {
    return <EmptyState title="Superadmin access required" sub="Only superadmins can manage fleet-owner accounts, change plans, adjust roles, and send password reset links." />;
  }

  return (
    <div>
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          body={confirmModal.body}
          confirmLabel={confirmModal.confirmLabel}
          danger={confirmModal.danger}
          busy={busyKey === confirmModal.key}
          onConfirm={confirmModal.onConfirm}
          onClose={() => setConfirmModal(null)}
        />
      )}

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

      <div className="flex-between mb-2" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h1 className="page-title">Fleet owner management</h1>
          <p className="page-sub">Manage fleet-owner organizations — change plans, adjust team roles, and control account access.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>Refresh</button>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Organizations" value={stats.organizations} icon={<Building2 size={16} />} />
        <Stat label="Fleet owner users" value={stats.accounts} icon={<Users size={16} />} />
        <Stat label="Active subscriptions" value={stats.active} icon={<ShieldCheck size={16} />} />
        <Stat label="Non-payer orgs" value={stats.nonPayers} icon={<Wallet size={16} />} />
      </div>

      <div className="card mb-4">
        <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search company, contact, email, city, plan or billing status"
            style={{ flex: '1 1 280px', maxWidth: 440 }}
          />
          <div style={{ minWidth: 200 }}>
            <label className="label">Billing status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All billing states</option>
              {ORG_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="muted text-sm" style={{ alignSelf: 'center', paddingTop: 4 }}>
            {filteredOrgs.length} of {organizations.length} organizations
          </div>
        </div>
      </div>

      {!filteredOrgs.length ? (
        <EmptyState title="No organizations match this view" sub="Try a different billing status or search term." />
      ) : (
        <>
          {pagination.items.map((org) => {
            const members = byOrg[org.id] || [];
            const isExpanded = expanded.has(org.id);
            const estMonthly = (org.bike_count || 0) * 750;

            return (
              <div key={org.id} className="card mb-3" style={{ padding: 0, overflow: 'hidden' }}>
                {/* Org summary row */}
                <div style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: 15 }}>{org.name}</span>
                        <Badge status="active">{String(org.plan_key || 'trial').replace(/_/g, ' ')}</Badge>
                        <Badge status={org.status}>{String(org.status || 'trialing').replace(/_/g, ' ')}</Badge>
                        <Badge status={org.payer_status === 'payer' ? 'success' : 'overdue'}>
                          {org.payer_status === 'payer' ? 'Payer' : 'Non-payer'}
                        </Badge>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 20px', color: 'var(--muted)', fontSize: 12 }}>
                        {org.contact_email && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Mail size={11} /> {org.contact_email}
                          </span>
                        )}
                        {org.city && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <MapPin size={11} /> {org.city}
                          </span>
                        )}
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Bike size={11} /> {org.active_bikes}/{org.bike_count} bikes active
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Users size={11} /> {org.active_member_count}/{org.member_count} members
                        </span>
                        {estMonthly > 0 && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <CreditCard size={11} /> {fmt(estMonthly)}/mo est.
                          </span>
                        )}
                        {org.revenue_30d > 0 && <span>Rev 30d: {fmt(org.revenue_30d)}</span>}
                        <span>Last payment: {fmtDate(org.last_payment_at)}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => setPlanModal({ orgId: org.id, orgName: org.name, currentPlan: org.plan_key, currentStatus: org.status })}
                      >
                        <Settings size={13} /> Change plan
                      </button>
                      <button
                        className={`btn btn-sm ${isExpanded ? '' : 'btn-secondary'}`}
                        onClick={() => toggleExpanded(org.id)}
                      >
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Team ({members.length})
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded: team member table */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--border)' }}>
                    {members.length === 0 ? (
                      <div className="muted text-sm" style={{ padding: '12px 20px' }}>No team members in this organization.</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Member</th>
                              <th>Contact</th>
                              <th>Role</th>
                              <th>Status</th>
                              <th>Joined</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {members.map((account) => {
                              const nextRole = roleEdits[account.id] || account.role;
                              const changedRole = nextRole !== account.role;
                              return (
                                <tr key={account.id}>
                                  <td>
                                    <div style={{ fontWeight: 600 }}>{account.full_name}</div>
                                    <div className="text-xs muted">{account.email}</div>
                                  </td>
                                  <td>
                                    <CopyableContactValue value={account.phone} compact />
                                    {account.city && <div className="text-xs muted" style={{ marginTop: 4 }}>{account.city}</div>}
                                  </td>
                                  <td style={{ minWidth: 190 }}>
                                    <select
                                      value={nextRole}
                                      onChange={(e) => setRoleEdits((prev) => ({ ...prev, [account.id]: e.target.value }))}
                                    >
                                      {roleOptions.map((r) => <option key={r} value={r}>{getFleetRoleLabel(r)}</option>)}
                                    </select>
                                    {changedRole && <div className="text-xs muted" style={{ marginTop: 4 }}>Unsaved change</div>}
                                  </td>
                                  <td><Badge status={account.status}>{account.status}</Badge></td>
                                  <td className="text-xs muted">{fmtDate(account.created_at)}</td>
                                  <td>
                                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                      {changedRole && (
                                        <button
                                          className="btn btn-sm"
                                          disabled={busyKey === `role-${account.id}`}
                                          onClick={() => saveRole(account)}
                                        >
                                          {busyKey === `role-${account.id}` ? 'Saving…' : 'Save role'}
                                        </button>
                                      )}
                                      <button
                                        className="btn btn-sm btn-secondary"
                                        disabled={account.status !== 'active' || busyKey === `reset-${account.id}`}
                                        onClick={() => sendPasswordReset(account)}
                                        title="Send password reset link"
                                      >
                                        <KeyRound size={12} /> Reset password
                                      </button>
                                      <button
                                        className={`btn btn-sm ${account.status === 'active' ? 'btn-danger' : 'btn-secondary'}`}
                                        disabled={busyKey === `status-${account.id}`}
                                        onClick={() => toggleStatus(account)}
                                      >
                                        {account.status === 'active' ? 'Suspend' : 'Activate'}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <Pagination
            page={pagination.currentPage}
            pageSize={pagination.pageSize}
            totalItems={pagination.totalItems}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            label="organizations"
          />
        </>
      )}
    </div>
  );
}

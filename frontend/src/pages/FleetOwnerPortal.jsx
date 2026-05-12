import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, BarChart3, Bike, Briefcase, CheckCircle2, Clock3, CreditCard, FileText, LogOut, ShieldCheck, Users, Wrench } from 'lucide-react';
import Logo from '../components/Logo';
import api from '../api';
import { useAuth } from '../auth';
import { Badge, SearchInput, fmt, fmtDate, matchesSearch } from '../components/ui';

const ROLE_LABELS = {
  fleet_owner_admin: 'Company admin',
  fleet_owner_ops: 'Operations lead',
  fleet_owner_billing: 'Billing lead',
  fleet_owner_viewer: 'Viewer'
};

const ROLE_TABS = {
  fleet_owner_admin: ['overview', 'fleet', 'agreements', 'collections', 'billing', 'team'],
  fleet_owner_ops: ['overview', 'fleet', 'agreements', 'collections'],
  fleet_owner_billing: ['overview', 'agreements', 'billing'],
  fleet_owner_viewer: ['overview']
};

const tabOptions = [
  { key: 'overview', label: 'Overview' },
  { key: 'fleet', label: 'Fleet' },
  { key: 'agreements', label: 'Agreements' },
  { key: 'collections', label: 'Collections' },
  { key: 'billing', label: 'Billing' },
  { key: 'team', label: 'Team' }
];

const fleetRows = [
  { id: 1, registration: 'JHB 452 GP', bike: 'TVS HLX 150', rider: 'Sipho Dlamini', status: 'active', branch: 'Johannesburg CBD', next_service: '2026-05-18', weekly_rental: 850 },
  { id: 2, registration: 'JHB 519 GP', bike: 'Bajaj Boxer', rider: 'Ayanda Mokoena', status: 'repairs', branch: 'Braamfontein', next_service: '2026-05-14', weekly_rental: 820 },
  { id: 3, registration: 'PTA 117 GP', bike: 'TVS HLX 150', rider: 'Thabo Ndlovu', status: 'active', branch: 'Pretoria West', next_service: '2026-05-20', weekly_rental: 850 },
  { id: 4, registration: 'JHB 778 GP', bike: 'Honda Ace', rider: 'Lebo Molefe', status: 'stolen', branch: 'Soweto', next_service: '—', weekly_rental: 890 },
  { id: 5, registration: 'JHB 884 GP', bike: 'Bajaj Boxer', rider: 'Kagiso Mthembu', status: 'ready_to_go', branch: 'Midrand', next_service: '2026-05-28', weekly_rental: 820 },
  { id: 6, registration: 'PTA 623 GP', bike: 'TVS HLX 150', rider: 'Neo Maseko', status: 'active', branch: 'Pretoria CBD', next_service: '2026-05-22', weekly_rental: 850 }
];

const agreementRows = [
  { id: 1, agreement_no: 'OF-FLEET-001', rider: 'Sipho Dlamini', bike_registration: 'JHB 452 GP', bike_status: 'active', status: 'active', weekly_amount: 850, overdue_balance: 0, remaining_balance: 22100 },
  { id: 2, agreement_no: 'OF-FLEET-002', rider: 'Ayanda Mokoena', bike_registration: 'JHB 519 GP', bike_status: 'repairs', status: 'paused', weekly_amount: 820, overdue_balance: 0, remaining_balance: 19440 },
  { id: 3, agreement_no: 'OF-FLEET-003', rider: 'Thabo Ndlovu', bike_registration: 'PTA 117 GP', bike_status: 'active', status: 'defaulted', weekly_amount: 850, overdue_balance: 1700, remaining_balance: 24650 },
  { id: 4, agreement_no: 'OF-FLEET-004', rider: 'Lebo Molefe', bike_registration: 'JHB 778 GP', bike_status: 'stolen', status: 'discontinued', weekly_amount: 890, overdue_balance: 0, remaining_balance: 17800 },
  { id: 5, agreement_no: 'OF-FLEET-005', rider: 'Neo Maseko', bike_registration: 'PTA 623 GP', bike_status: 'active', status: 'active', weekly_amount: 850, overdue_balance: 850, remaining_balance: 21250 }
];

const collectionsQueue = [
  { rider: 'Thabo Ndlovu', agreement_no: 'OF-FLEET-003', stage: 'Default action', amount: 1700, note: 'Bike is active, collections team should contact rider and inspect route performance.' },
  { rider: 'Neo Maseko', agreement_no: 'OF-FLEET-005', stage: 'Overdue this week', amount: 850, note: 'Send reminder today and confirm wallet funding before cutoff.' },
  { rider: 'Lebo Molefe', agreement_no: 'OF-FLEET-004', stage: 'Stolen-bike workflow', amount: 0, note: 'Agreement discontinued automatically. Future unpaid rows waived until recovery.' }
];

const defaultMemberForm = {
  full_name: '',
  email: '',
  password: '',
  phone: '',
  city: '',
  role: 'fleet_owner_viewer'
};

export default function FleetOwnerPortal() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [fleetStatus, setFleetStatus] = useState('all');
  const [agreementStatus, setAgreementStatus] = useState('all');
  const [account, setAccount] = useState({ organization: null, members: [] });
  const [loading, setLoading] = useState(true);
  const [memberForm, setMemberForm] = useState(defaultMemberForm);
  const [savingMember, setSavingMember] = useState(false);
  const [savingMemberId, setSavingMemberId] = useState(null);

  const allowedTabs = ROLE_TABS[user?.role] || ['overview'];

  const loadAccount = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/fleet/account');
      setAccount({ organization: data.organization || null, members: data.members || [] });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load fleet account');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAccount(); }, []);
  useEffect(() => {
    if (!allowedTabs.includes(tab)) setTab(allowedTabs[0] || 'overview');
  }, [user?.role]);

  const activeBikeCount = fleetRows.filter((row) => row.status === 'active').length;
  const readyBikeCount = fleetRows.filter((row) => row.status === 'ready_to_go').length;
  const defaultedCount = agreementRows.filter((row) => row.status === 'defaulted' && row.bike_status !== 'stolen').length;
  const overdueAmount = agreementRows.reduce((sum, row) => sum + Number(row.overdue_balance || 0), 0);
  const adminSeatUsage = account.members.filter((member) => ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'].includes(member.role)).length;

  const visibleFleet = useMemo(() => fleetRows.filter((row) => {
    if (fleetStatus !== 'all' && row.status !== fleetStatus) return false;
    return matchesSearch(search, row.registration, row.bike, row.rider, row.branch, row.status);
  }), [search, fleetStatus]);

  const visibleAgreements = useMemo(() => agreementRows.filter((row) => {
    if (agreementStatus !== 'all' && row.status !== agreementStatus) return false;
    return matchesSearch(search, row.agreement_no, row.rider, row.bike_registration, row.status, row.bike_status);
  }), [search, agreementStatus]);

  const createMember = async (event) => {
    event.preventDefault();
    setSavingMember(true);
    try {
      const { data } = await api.post('/fleet/team-members', memberForm);
      setAccount((prev) => ({ ...prev, members: [...prev.members, data.member] }));
      setMemberForm(defaultMemberForm);
      toast.success('Team member added');
      loadAccount();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not add team member');
    } finally {
      setSavingMember(false);
    }
  };

  const updateMember = async (memberId, patch) => {
    setSavingMemberId(memberId);
    try {
      const { data } = await api.patch(`/fleet/team-members/${memberId}`, patch);
      setAccount((prev) => ({ ...prev, members: prev.members.map((member) => member.id === memberId ? data.member : member) }));
      toast.success('Team member updated');
      loadAccount();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update team member');
    } finally {
      setSavingMemberId(null);
    }
  };

  if (loading) {
    return <div className="center-flex"><div className="spinner" /></div>;
  }

  return (
    <div className="fleet-portal-page">
      <header className="fleet-portal-header">
        <div className="fleet-portal-brand"><Logo /><Badge status="active">Fleet portal</Badge></div>
        <div className="fleet-portal-header-actions">
          <div className="muted text-sm">{account.organization?.name || user?.organization_name || 'Company workspace'} · {ROLE_LABELS[user?.role] || user?.role}</div>
          <Link to="/fleet/workspace" className="btn btn-secondary btn-sm">View workspace preview</Link>
          <button className="btn btn-secondary btn-sm" onClick={() => { logout(); nav('/fleet/login'); }}><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      <div className="fleet-portal-shell">
        <aside className="fleet-portal-sidebar card">
          <div className="fleet-portal-company-card">
            <div className="badge badge-info">{account.organization?.plan_key || user?.organization_plan_key || 'trial'}</div>
            <h3 className="mt-3">{account.organization?.name || user?.organization_name}</h3>
            <div className="muted text-sm mt-2">{account.organization?.city || 'South Africa'} · Status {account.organization?.status || user?.organization_status || 'trialing'}</div>
            <div className="fleet-portal-callout mt-4">
              Trial ends {account.organization?.trial_ends_at ? fmtDate(account.organization.trial_ends_at) : '—'}
            </div>
          </div>
          <div className="fleet-portal-nav mt-4">
            {tabOptions.map((option) => {
              const enabled = allowedTabs.includes(option.key);
              return (
                <button
                  key={option.key}
                  type="button"
                  className={`fleet-portal-nav-btn ${tab === option.key ? 'active' : ''}`}
                  disabled={!enabled}
                  onClick={() => enabled && setTab(option.key)}
                >
                  <span>{option.label}</span>
                  {!enabled ? <span className="muted text-xs">Locked</span> : null}
                </button>
              );
            })}
          </div>
          <div className="fleet-portal-callout mt-4">
            <strong>Role access:</strong> {ROLE_LABELS[user?.role] || user?.role}. Tabs and team actions are limited according to this role.
          </div>
        </aside>

        <main className="fleet-portal-main">
          <div className="grid grid-4 mb-4">
            <div className="stat"><div className="stat-label">Active bikes</div><div className="stat-value">{activeBikeCount}</div><div className="stat-delta muted">{readyBikeCount} ready to deploy</div></div>
            <div className="stat"><div className="stat-label">Collections risk</div><div className="stat-value">{defaultedCount}</div><div className="stat-delta muted">Defaulted on active bikes</div></div>
            <div className="stat"><div className="stat-label">Overdue amount</div><div className="stat-value">{fmt(overdueAmount)}</div><div className="stat-delta muted">From sample live agreements</div></div>
            <div className="stat"><div className="stat-label">Admin seats</div><div className="stat-value">{adminSeatUsage}/{account.organization?.max_admin_users || 0}</div><div className="stat-delta muted">Current plan capacity</div></div>
          </div>

          {tab === 'overview' ? (
            <div className="fleet-demo-layout">
              <div className="card">
                <div className="card-title"><h3>Organization account</h3><Badge status={account.organization?.status === 'trialing' ? 'pending' : 'active'}>{account.organization?.status || 'trialing'}</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><Briefcase size={16} /> Company slug: {account.organization?.slug || '—'}</div>
                  <div className="fleet-demo-list-item"><Users size={16} /> Team members: {account.members.length}</div>
                  <div className="fleet-demo-list-item"><CreditCard size={16} /> Plan: {(account.organization?.plan_key || 'trial').replace(/_/g, ' ')}</div>
                  <div className="fleet-demo-list-item"><Clock3 size={16} /> Trial ends: {account.organization?.trial_ends_at ? fmtDate(account.organization.trial_ends_at) : '—'}</div>
                </div>
              </div>
              <div className="card">
                <div className="card-title"><h3>Action queue</h3><Badge status="defaulted">Needs attention</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><AlertTriangle size={16} /> {defaultedCount} defaulted agreement{defaultedCount === 1 ? '' : 's'} on active bikes</div>
                  <div className="fleet-demo-list-item"><Wrench size={16} /> 1 bike in repairs awaiting ops decision</div>
                  <div className="fleet-demo-list-item"><ShieldCheck size={16} /> Stolen bikes are excluded once contracts are discontinued</div>
                </div>
              </div>
              <div className="card">
                <div className="card-title"><h3>Role-based access</h3><Badge status="success">Enabled</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Company admin: full workspace + team management</div>
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Operations lead: fleet, agreements, collections</div>
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Billing lead: billing and agreement finance visibility</div>
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Viewer: overview only</div>
                </div>
              </div>
            </div>
          ) : null}

          {(tab === 'fleet' || tab === 'agreements') ? (
            <div className="fleet-demo-filters card mb-4">
              <div style={{ flex: 1, minWidth: 240 }}>
                <label className="label">Search</label>
                <SearchInput value={search} onChange={setSearch} placeholder="Search rider, bike, branch, agreement" style={{ width: '100%' }} />
              </div>
              {tab === 'fleet' ? (
                <div style={{ minWidth: 180 }}>
                  <label className="label">Bike status</label>
                  <select value={fleetStatus} onChange={(e) => setFleetStatus(e.target.value)}>
                    <option value="all">All bike statuses</option>
                    <option value="active">Active</option>
                    <option value="ready_to_go">Ready to go</option>
                    <option value="repairs">Repairs</option>
                    <option value="stolen">Stolen</option>
                  </select>
                </div>
              ) : (
                <div style={{ minWidth: 180 }}>
                  <label className="label">Agreement status</label>
                  <select value={agreementStatus} onChange={(e) => setAgreementStatus(e.target.value)}>
                    <option value="all">All agreement statuses</option>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="defaulted">Defaulted</option>
                    <option value="discontinued">Discontinued</option>
                  </select>
                </div>
              )}
            </div>
          ) : null}

          {tab === 'fleet' ? (
            <div className="card" style={{ overflowX: 'auto' }}>
              <div className="card-title"><h3>Fleet visibility</h3><Badge status="active">{visibleFleet.length} bikes shown</Badge></div>
              <table className="table">
                <thead><tr><th>Registration</th><th>Bike</th><th>Rider</th><th>Status</th><th>Branch</th><th>Next service</th><th>Weekly rental</th></tr></thead>
                <tbody>{visibleFleet.map((row) => <tr key={row.id}><td>{row.registration}</td><td>{row.bike}</td><td>{row.rider}</td><td><Badge status={row.status}>{String(row.status).replace(/_/g, ' ')}</Badge></td><td>{row.branch}</td><td>{row.next_service === '—' ? '—' : fmtDate(row.next_service)}</td><td>{fmt(row.weekly_rental)}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}

          {tab === 'agreements' ? (
            <div className="card" style={{ overflowX: 'auto' }}>
              <div className="card-title"><h3>Agreement control</h3><Badge status="active">{visibleAgreements.length} agreements shown</Badge></div>
              <table className="table">
                <thead><tr><th>Agreement</th><th>Rider</th><th>Bike</th><th>Bike status</th><th>Agreement status</th><th>Weekly amount</th><th>Overdue</th><th>Remaining</th></tr></thead>
                <tbody>{visibleAgreements.map((row) => <tr key={row.id}><td>{row.agreement_no}</td><td>{row.rider}</td><td>{row.bike_registration}</td><td><Badge status={row.bike_status}>{String(row.bike_status).replace(/_/g, ' ')}</Badge></td><td><Badge status={row.status}>{String(row.status).replace(/_/g, ' ')}</Badge></td><td>{fmt(row.weekly_amount)}</td><td>{fmt(row.overdue_balance)}</td><td>{fmt(row.remaining_balance)}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}

          {tab === 'collections' ? (
            <div className="fleet-demo-layout">
              <div className="card">
                <div className="card-title"><h3>Collections queue</h3><Badge status="overdue">{fmt(overdueAmount)}</Badge></div>
                <div className="fleet-demo-list">
                  {collectionsQueue.map((item) => (
                    <div key={item.agreement_no} className="fleet-demo-queue-item">
                      <div className="flex-between gap-3" style={{ alignItems: 'flex-start' }}>
                        <div><strong>{item.rider}</strong><div className="muted text-sm">{item.agreement_no} · {item.stage}</div></div>
                        <div style={{ fontWeight: 700 }}>{fmt(item.amount)}</div>
                      </div>
                      <div className="muted text-sm mt-2">{item.note}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card">
                <div className="card-title"><h3>Workflow rules</h3><Badge status="success">Configured</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Default-action queue excludes bikes marked stolen, written off, or sold.</div>
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Agreements can be bulk discontinued on the admin agreements screen.</div>
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> A bike marked stolen automatically moves its contract to discontinued.</div>
                </div>
              </div>
              <div className="card">
                <div className="card-title"><h3>Collections visibility</h3><Badge status="active">Ops access</Badge></div>
                <div className="fleet-demo-callout">This tab is limited to roles that need operational follow-up. Billing-only and viewer roles cannot access it.</div>
              </div>
            </div>
          ) : null}

          {tab === 'billing' ? (
            <div className="fleet-demo-layout">
              <div className="card">
                <div className="card-title"><h3>Billing policy</h3><Badge status="active">{account.organization?.status || 'trialing'}</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><CreditCard size={16} /> Trial or active status: full company access.</div>
                  <div className="fleet-demo-list-item"><Clock3 size={16} /> Past due: follow-up and billing recovery window.</div>
                  <div className="fleet-demo-list-item"><AlertTriangle size={16} /> Suspended: access blocked until payment is restored.</div>
                  <div className="fleet-demo-list-item"><ShieldCheck size={16} /> Cancelled: workspace access removed.</div>
                </div>
              </div>
              <div className="card">
                <div className="card-title"><h3>Company plan</h3><Badge status="info">{account.organization?.plan_key || 'trial'}</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><BarChart3 size={16} /> Max bikes: {account.organization?.max_bikes || 10}</div>
                  <div className="fleet-demo-list-item"><Users size={16} /> Admin seats: {account.organization?.max_admin_users || 2}</div>
                  <div className="fleet-demo-list-item"><Clock3 size={16} /> Trial ends: {account.organization?.trial_ends_at ? fmtDate(account.organization.trial_ends_at) : '—'}</div>
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'team' ? (
            <div className="fleet-demo-layout">
              <div className="card">
                <div className="card-title"><h3>Invite team members</h3><Badge status="success">Admin only</Badge></div>
                <form onSubmit={createMember} className="grid grid-2">
                  <div className="field"><label className="label">Full name</label><input value={memberForm.full_name} onChange={(e) => setMemberForm((prev) => ({ ...prev, full_name: e.target.value }))} required /></div>
                  <div className="field"><label className="label">Email</label><input type="email" value={memberForm.email} onChange={(e) => setMemberForm((prev) => ({ ...prev, email: e.target.value }))} required /></div>
                  <div className="field"><label className="label">Temporary password</label><input type="password" minLength={6} value={memberForm.password} onChange={(e) => setMemberForm((prev) => ({ ...prev, password: e.target.value }))} required /></div>
                  <div className="field"><label className="label">Role</label><select value={memberForm.role} onChange={(e) => setMemberForm((prev) => ({ ...prev, role: e.target.value }))}><option value="fleet_owner_admin">Company admin</option><option value="fleet_owner_ops">Operations lead</option><option value="fleet_owner_billing">Billing lead</option><option value="fleet_owner_viewer">Viewer</option></select></div>
                  <div className="field"><label className="label">Phone</label><input value={memberForm.phone} onChange={(e) => setMemberForm((prev) => ({ ...prev, phone: e.target.value }))} /></div>
                  <div className="field"><label className="label">City</label><input value={memberForm.city} onChange={(e) => setMemberForm((prev) => ({ ...prev, city: e.target.value }))} /></div>
                  <div style={{ gridColumn: '1 / -1' }}><button className="btn btn-block" disabled={savingMember}>{savingMember ? 'Adding member…' : 'Add team member'}</button></div>
                </form>
              </div>
              <div className="card" style={{ gridColumn: 'span 2' }}>
                <div className="card-title"><h3>Current team</h3><Badge status="active">{account.members.length} members</Badge></div>
                <table className="table">
                  <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
                  <tbody>
                    {account.members.map((member) => (
                      <tr key={member.id}>
                        <td>{member.full_name}</td>
                        <td>{member.email}</td>
                        <td><Badge status="active">{ROLE_LABELS[member.role] || member.role}</Badge></td>
                        <td><Badge status={member.status}>{member.status}</Badge></td>
                        <td>{fmtDate(member.created_at)}</td>
                        <td>
                          <div className="row" style={{ flexWrap: 'wrap' }}>
                            <button className="btn btn-secondary btn-sm" disabled={savingMemberId === member.id} onClick={() => updateMember(member.id, { role: member.role === 'fleet_owner_viewer' ? 'fleet_owner_ops' : 'fleet_owner_viewer' })}>Toggle role</button>
                            <button className="btn btn-secondary btn-sm" disabled={savingMemberId === member.id} onClick={() => updateMember(member.id, { status: member.status === 'active' ? 'suspended' : 'active' })}>{member.status === 'active' ? 'Suspend' : 'Activate'}</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

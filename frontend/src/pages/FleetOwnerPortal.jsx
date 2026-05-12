import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, Bike, Briefcase, CheckCircle2, Clock3, CreditCard, LogOut, ShieldCheck, Users, Wrench } from 'lucide-react';
import Logo from '../components/Logo';
import api from '../api';
import { useAuth } from '../auth';
import { Badge, EmptyState, Loading, Modal, SearchInput, Stat, fmt, fmtDate, fmtDateTime, matchesSearch } from '../components/ui';

const ROLE_LABELS = {
  fleet_owner_admin: 'Company admin',
  fleet_owner_ops: 'Operations lead',
  fleet_owner_billing: 'Billing lead',
  fleet_owner_viewer: 'Viewer'
};

const ROLE_TABS = {
  fleet_owner_admin: ['overview', 'fleet', 'agreements', 'maintenance', 'collections', 'billing', 'team'],
  fleet_owner_ops: ['overview', 'fleet', 'agreements', 'maintenance', 'collections'],
  fleet_owner_billing: ['overview', 'agreements', 'billing'],
  fleet_owner_viewer: ['overview']
};

const tabOptions = [
  { key: 'overview', label: 'Overview' },
  { key: 'fleet', label: 'Fleet' },
  { key: 'agreements', label: 'Agreements' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'collections', label: 'Collections' },
  { key: 'billing', label: 'Billing' },
  { key: 'team', label: 'Team' }
];

const defaultMemberForm = {
  full_name: '',
  email: '',
  password: '',
  phone: '',
  city: '',
  role: 'fleet_owner_viewer'
};

const emptyPortal = {
  organization: null,
  members: [],
  bikes: [],
  agreements: [],
  collections_queue: [],
  rider_options: [],
  upcoming_services: [],
  recent_services: [],
  summary: {},
  live_updated_at: null
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function bikeLabel(row) {
  return [row?.make, row?.model].filter(Boolean).join(' ');
}

function normalizeRoleLabel(role) {
  return ROLE_LABELS[role] || String(role || '').replace(/_/g, ' ');
}

export default function FleetOwnerPortal() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [fleetStatus, setFleetStatus] = useState('all');
  const [agreementStatus, setAgreementStatus] = useState('all');
  const [portal, setPortal] = useState(emptyPortal);
  const [loading, setLoading] = useState(true);
  const [memberForm, setMemberForm] = useState(defaultMemberForm);
  const [savingMember, setSavingMember] = useState(false);
  const [savingMemberId, setSavingMemberId] = useState(null);
  const [actionBusy, setActionBusy] = useState('');
  const [allocationForm, setAllocationForm] = useState({ bike_id: '', rider_id: '', start_date: todayIso(), weekly_amount: '', total_weeks: '', notes: '' });
  const [reassignmentForm, setReassignmentForm] = useState({ agreement_id: '', target_bike_id: '', note: '' });
  const [scheduleForm, setScheduleForm] = useState({ bike_id: '', next_service_date: '', next_service_km: '', odometer_km: '', notes: '' });
  const [serviceLogForm, setServiceLogForm] = useState({ bike_id: '', service_date: todayIso(), service_type: 'Scheduled service', description: '', cost: '', odometer_km: '', next_service_date: '', next_service_km: '', performed_by: '', bike_status_after_service: '' });
  const [activeModal, setActiveModal] = useState(null);

  const allowedTabs = ROLE_TABS[user?.role] || ['overview'];
  const canManageOps = ['fleet_owner_admin', 'fleet_owner_ops'].includes(user?.role);
  const canManageTeam = user?.role === 'fleet_owner_admin';

  const loadPortal = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/fleet/portal-data');
      setPortal({ ...emptyPortal, ...data });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load fleet portal');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { loadPortal(); }, []);
  useEffect(() => {
    if (!allowedTabs.includes(tab)) setTab(allowedTabs[0] || 'overview');
  }, [tab, user?.role]);

  const visibleFleet = useMemo(() => portal.bikes.filter((row) => {
    if (fleetStatus !== 'all' && row.status !== fleetStatus) return false;
    return matchesSearch(search, row.registration, row.make, row.model, row.rider_name, row.fleet, row.status);
  }), [portal.bikes, search, fleetStatus]);

  const visibleAgreements = useMemo(() => portal.agreements.filter((row) => {
    if (agreementStatus !== 'all' && row.status !== agreementStatus) return false;
    return matchesSearch(search, row.agreement_no, row.rider_name, row.bike_registration, row.make, row.model, row.status, row.bike_status);
  }), [portal.agreements, search, agreementStatus]);

  const readyBikeOptions = useMemo(() => portal.bikes.filter((bike) => bike.status === 'ready_to_go'), [portal.bikes]);
  const riderOptions = useMemo(() => portal.rider_options.filter((rider) => !Number(rider.has_open_agreement)), [portal.rider_options]);
  const organization = portal.organization || {};
  const summary = portal.summary || {};

  const refreshPortal = async () => {
    await loadPortal({ silent: true });
    toast.success('Fleet portal refreshed');
  };

  const createMember = async (event) => {
    event.preventDefault();
    setSavingMember(true);
    try {
      await api.post('/fleet/team-members', memberForm);
      setMemberForm(defaultMemberForm);
      toast.success('Team member added');
      await loadPortal({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not add team member');
    } finally {
      setSavingMember(false);
    }
  };

  const updateMember = async (memberId, patch) => {
    setSavingMemberId(memberId);
    try {
      await api.patch(`/fleet/team-members/${memberId}`, patch);
      toast.success('Team member updated');
      await loadPortal({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update team member');
    } finally {
      setSavingMemberId(null);
    }
  };

  const openAllocation = (bike) => {
    setAllocationForm({
      bike_id: String(bike.id),
      rider_id: '',
      start_date: todayIso(),
      weekly_amount: String(bike.rental_weekly || ''),
      total_weeks: String(bike.total_weeks || ''),
      notes: ''
    });
    setActiveModal('allocation');
  };

  const openReassignment = (agreement) => {
    setReassignmentForm({
      agreement_id: String(agreement.id || agreement.agreement_id),
      target_bike_id: '',
      note: ''
    });
    setActiveModal('reassignment');
  };

  const openSchedule = (bike = null) => {
    setScheduleForm({
      bike_id: bike?.id ? String(bike.id) : '',
      next_service_date: bike?.next_service_date || '',
      next_service_km: bike?.next_service_km ? String(bike.next_service_km) : '',
      odometer_km: bike?.odometer_km ? String(bike.odometer_km) : '',
      notes: ''
    });
    setActiveModal('schedule');
  };

  const openServiceLog = (bike = null) => {
    setServiceLogForm({
      bike_id: bike?.id ? String(bike.id) : '',
      service_date: todayIso(),
      service_type: 'Scheduled service',
      description: '',
      cost: '',
      odometer_km: bike?.odometer_km ? String(bike.odometer_km) : '',
      next_service_date: bike?.next_service_date || '',
      next_service_km: bike?.next_service_km ? String(bike.next_service_km) : '',
      performed_by: '',
      bike_status_after_service: bike?.status === 'repairs' ? 'ready_to_go' : ''
    });
    setActiveModal('service-log');
  };

  const submitAllocation = async (event) => {
    event.preventDefault();
    setActionBusy('allocation');
    try {
      await api.post('/fleet/allocations', {
        bike_id: Number(allocationForm.bike_id),
        rider_id: Number(allocationForm.rider_id),
        start_date: allocationForm.start_date,
        weekly_amount: allocationForm.weekly_amount ? Number(allocationForm.weekly_amount) : undefined,
        total_weeks: allocationForm.total_weeks ? Number(allocationForm.total_weeks) : undefined,
        notes: allocationForm.notes || undefined
      });
      toast.success('Rider allocated to bike');
      setActiveModal(null);
      await loadPortal({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not allocate rider');
    } finally {
      setActionBusy('');
    }
  };

  const submitReassignment = async (event) => {
    event.preventDefault();
    setActionBusy('reassignment');
    try {
      await api.post('/fleet/reassignments', {
        agreement_id: Number(reassignmentForm.agreement_id),
        target_bike_id: Number(reassignmentForm.target_bike_id),
        note: reassignmentForm.note || undefined
      });
      toast.success('Bike reassigned');
      setActiveModal(null);
      await loadPortal({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reassign bike');
    } finally {
      setActionBusy('');
    }
  };

  const submitSchedule = async (event) => {
    event.preventDefault();
    setActionBusy('schedule');
    try {
      await api.post('/fleet/maintenance/schedule', {
        bike_id: Number(scheduleForm.bike_id),
        next_service_date: scheduleForm.next_service_date || undefined,
        next_service_km: scheduleForm.next_service_km || undefined,
        odometer_km: scheduleForm.odometer_km || undefined,
        notes: scheduleForm.notes || undefined
      });
      toast.success('Maintenance schedule updated');
      setActiveModal(null);
      await loadPortal({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update maintenance schedule');
    } finally {
      setActionBusy('');
    }
  };

  const submitServiceLog = async (event) => {
    event.preventDefault();
    setActionBusy('service-log');
    try {
      await api.post('/fleet/maintenance/log', {
        bike_id: Number(serviceLogForm.bike_id),
        service_date: serviceLogForm.service_date,
        service_type: serviceLogForm.service_type,
        description: serviceLogForm.description || undefined,
        cost: serviceLogForm.cost || undefined,
        odometer_km: serviceLogForm.odometer_km || undefined,
        next_service_date: serviceLogForm.next_service_date || undefined,
        next_service_km: serviceLogForm.next_service_km || undefined,
        performed_by: serviceLogForm.performed_by || undefined,
        bike_status_after_service: serviceLogForm.bike_status_after_service || undefined
      });
      toast.success('Maintenance log saved');
      setActiveModal(null);
      await loadPortal({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not log maintenance');
    } finally {
      setActionBusy('');
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="fleet-portal-page">
      <header className="fleet-portal-header">
        <div className="fleet-portal-brand"><Logo /><Badge status="active">Fleet portal</Badge></div>
        <div className="fleet-portal-header-actions">
          <div className="muted text-sm">{organization.name || user?.organization_name || 'Company workspace'} · {normalizeRoleLabel(user?.role)}</div>
          <button className="btn btn-secondary btn-sm" onClick={refreshPortal}>Refresh</button>
          <button className="btn btn-secondary btn-sm" onClick={() => { logout(); nav('/fleet/login'); }}><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      <div className="fleet-portal-shell">
        <aside className="fleet-portal-sidebar card">
          <div className="fleet-portal-company-card">
            <div className="badge badge-info">{organization.plan_key || user?.organization_plan_key || 'trial'}</div>
            <h3 className="mt-3">{organization.name || user?.organization_name || 'Company workspace'}</h3>
            <div className="muted text-sm mt-2">{organization.city || 'South Africa'} · Status {organization.status || user?.organization_status || 'trialing'}</div>
            <div className="fleet-portal-callout mt-4">
              Trial ends {organization.trial_ends_at ? fmtDate(organization.trial_ends_at) : '—'}
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
            <strong>Live sync:</strong> {portal.live_updated_at ? fmtDateTime(portal.live_updated_at) : '—'}
          </div>
          <div className="fleet-portal-callout mt-4">
            <strong>Role access:</strong> {normalizeRoleLabel(user?.role)}. Operations controls are limited to company admin and operations lead accounts.
          </div>
        </aside>

        <main className="fleet-portal-main">
          <div className="grid grid-4 mb-4">
            <Stat label="Active bikes" value={summary.active_bikes || 0} delta={`${summary.ready_bikes || 0} ready to deploy`} icon={<Bike size={16} />} />
            <Stat label="Collections risk" value={summary.defaulted_agreements || 0} delta="Defaulted agreements" icon={<AlertTriangle size={16} />} accent="var(--danger)" />
            <Stat label="Overdue amount" value={fmt(summary.overdue_amount || 0)} delta={`${summary.open_agreements || 0} open agreements`} icon={<CreditCard size={16} />} />
            <Stat label="Upcoming services" value={summary.upcoming_services || 0} delta={`${summary.due_this_week || 0} due this week`} icon={<Wrench size={16} />} accent="var(--warning)" />
          </div>

          {tab === 'overview' && (
            <div className="fleet-demo-layout">
              <div className="card">
                <div className="card-title"><h3>Organization account</h3><Badge status={organization.status === 'trialing' ? 'pending' : 'active'}>{organization.status || 'trialing'}</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><Briefcase size={16} /> Company slug: {organization.slug || '—'}</div>
                  <div className="fleet-demo-list-item"><Users size={16} /> Team members: {portal.members.length}</div>
                  <div className="fleet-demo-list-item"><CreditCard size={16} /> Plan: {String(organization.plan_key || 'trial').replace(/_/g, ' ')}</div>
                  <div className="fleet-demo-list-item"><Clock3 size={16} /> Trial ends: {organization.trial_ends_at ? fmtDate(organization.trial_ends_at) : '—'}</div>
                </div>
              </div>

              <div className="card">
                <div className="card-title"><h3>Action queue</h3><Badge status={(summary.defaulted_agreements || 0) > 0 ? 'defaulted' : 'success'}>{(summary.defaulted_agreements || 0) > 0 ? 'Needs attention' : 'Stable'}</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><AlertTriangle size={16} /> {summary.defaulted_agreements || 0} defaulted agreement{summary.defaulted_agreements === 1 ? '' : 's'} to follow up</div>
                  <div className="fleet-demo-list-item"><Wrench size={16} /> {summary.bikes_in_repairs || 0} bike{summary.bikes_in_repairs === 1 ? '' : 's'} currently in repairs</div>
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> {summary.ready_bikes || 0} bike{summary.ready_bikes === 1 ? '' : 's'} available for rider allocation</div>
                </div>
              </div>

              <div className="card">
                <div className="card-title"><h3>Maintenance workload</h3><Badge status={(summary.due_this_week || 0) > 0 ? 'pending' : 'success'}>{summary.due_this_week || 0} this week</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><Wrench size={16} /> {summary.upcoming_services || 0} bikes with a scheduled service date</div>
                  <div className="fleet-demo-list-item"><Clock3 size={16} /> {summary.recent_service_logs || 0} recent maintenance logs on file</div>
                  <div className="fleet-demo-list-item"><ShieldCheck size={16} /> Team access respects company roles and permissions</div>
                </div>
              </div>
            </div>
          )}

          {(tab === 'fleet' || tab === 'agreements') && (
            <div className="fleet-demo-filters card mb-4">
              <div style={{ flex: 1, minWidth: 240 }}>
                <label className="label">Search</label>
                <SearchInput value={search} onChange={setSearch} placeholder="Search rider, bike, registration, fleet tag" style={{ width: '100%' }} />
              </div>
              {tab === 'fleet' ? (
                <div style={{ minWidth: 180 }}>
                  <label className="label">Bike status</label>
                  <select value={fleetStatus} onChange={(e) => setFleetStatus(e.target.value)}>
                    <option value="all">All bike statuses</option>
                    <option value="active">Active</option>
                    <option value="ready_to_go">Ready to go</option>
                    <option value="repairs">Repairs</option>
                    <option value="not_available">Not available</option>
                    <option value="stationary">Stationary</option>
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
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {tab === 'fleet' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <div className="card-title"><h3>Live fleet data</h3><Badge status="active">{visibleFleet.length} bikes</Badge></div>
              {visibleFleet.length ? (
                <table className="table">
                  <thead><tr><th>Registration</th><th>Bike</th><th>Rider</th><th>Status</th><th>Fleet tag</th><th>Next service</th><th>Weekly rental</th>{canManageOps ? <th>Actions</th> : null}</tr></thead>
                  <tbody>
                    {visibleFleet.map((row) => (
                      <tr key={row.id}>
                        <td>{row.registration || '—'}</td>
                        <td>{bikeLabel(row)}</td>
                        <td>{row.rider_name || 'Unassigned'}</td>
                        <td><Badge status={row.status}>{String(row.status).replace(/_/g, ' ')}</Badge></td>
                        <td>{row.fleet || '—'}</td>
                        <td>{row.next_service_date ? fmtDate(row.next_service_date) : '—'}</td>
                        <td>{fmt(row.rental_weekly)}</td>
                        {canManageOps ? (
                          <td>
                            <div className="row" style={{ flexWrap: 'wrap' }}>
                              {row.status === 'ready_to_go' ? <button className="btn btn-sm" onClick={() => openAllocation(row)}>Allocate rider</button> : null}
                              {row.agreement_id && ['active', 'paused', 'defaulted'].includes(row.agreement_status) ? <button className="btn btn-sm btn-secondary" onClick={() => openReassignment(row)}>Reassign bike</button> : null}
                              <button className="btn btn-sm btn-secondary" onClick={() => openSchedule(row)}>Schedule service</button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState title="No bikes match this filter" sub="Adjust the status filter or search terms to see more fleet records." />
              )}
            </div>
          )}

          {tab === 'agreements' && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <div className="card-title"><h3>Agreement control</h3><Badge status="active">{visibleAgreements.length} agreements</Badge></div>
              {visibleAgreements.length ? (
                <table className="table">
                  <thead><tr><th>Agreement</th><th>Rider</th><th>Bike</th><th>Bike status</th><th>Agreement status</th><th>Weekly amount</th><th>Overdue</th><th>Remaining</th>{canManageOps ? <th>Action</th> : null}</tr></thead>
                  <tbody>
                    {visibleAgreements.map((row) => (
                      <tr key={row.id}>
                        <td>{row.agreement_no}</td>
                        <td>{row.rider_name}</td>
                        <td>{row.bike_registration || '—'}</td>
                        <td><Badge status={row.bike_status}>{String(row.bike_status).replace(/_/g, ' ')}</Badge></td>
                        <td><Badge status={row.status}>{String(row.status).replace(/_/g, ' ')}</Badge></td>
                        <td>{fmt(row.weekly_amount)}</td>
                        <td>{fmt(row.overdue_balance)}</td>
                        <td>{fmt(row.remaining_balance)}</td>
                        {canManageOps ? (
                          <td>
                            {['active', 'paused', 'defaulted'].includes(row.status)
                              ? <button className="btn btn-sm btn-secondary" onClick={() => openReassignment(row)}>Reassign bike</button>
                              : <span className="muted text-sm">No action</span>}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState title="No agreements match this filter" sub="Change the agreement status filter or search terms to see active contracts." />
              )}
            </div>
          )}

          {tab === 'maintenance' && (
            <div className="fleet-demo-layout">
              <div className="card">
                <div className="card-title"><h3>Upcoming services</h3><Badge status="pending">{portal.upcoming_services.length} scheduled</Badge></div>
                {portal.upcoming_services.length ? (
                  <div className="fleet-demo-list">
                    {portal.upcoming_services.map((item) => (
                      <div key={`${item.bike_id}-${item.next_service_date || 'none'}`} className="fleet-demo-queue-item">
                        <div className="flex-between gap-3" style={{ alignItems: 'flex-start' }}>
                          <div>
                            <strong>{item.registration || item.bike_label}</strong>
                            <div className="muted text-sm">{item.bike_label} · {item.rider_name || 'Unassigned'}</div>
                          </div>
                          <Badge status={item.status}>{String(item.status).replace(/_/g, ' ')}</Badge>
                        </div>
                        <div className="muted text-sm mt-2">Service due {item.next_service_date ? fmtDate(item.next_service_date) : '—'}{item.next_service_km ? ` · ${Number(item.next_service_km).toLocaleString('en-ZA')} km` : ''}</div>
                        {canManageOps ? <div className="mt-3"><button className="btn btn-sm btn-secondary" onClick={() => openServiceLog({ id: item.bike_id, odometer_km: item.odometer_km, next_service_date: item.next_service_date, next_service_km: item.next_service_km, status: item.status })}>Log service</button></div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No service bookings yet" sub="Schedule the next service date to build your maintenance queue." />
                )}
              </div>

              <div className="card">
                <div className="card-title"><h3>Recent maintenance logs</h3><Badge status="active">{portal.recent_services.length} records</Badge></div>
                {portal.recent_services.length ? (
                  <div className="fleet-demo-list">
                    {portal.recent_services.map((item) => (
                      <div key={item.id} className="fleet-demo-queue-item">
                        <div className="flex-between gap-3" style={{ alignItems: 'flex-start' }}>
                          <div>
                            <strong>{item.registration || 'Bike record'}</strong>
                            <div className="muted text-sm">{bikeLabel(item)} · {item.service_type}</div>
                          </div>
                          <div style={{ fontWeight: 700 }}>{fmt(item.cost || 0)}</div>
                        </div>
                        <div className="muted text-sm mt-2">Completed {fmtDate(item.service_date)}{item.next_service_date ? ` · next ${fmtDate(item.next_service_date)}` : ''}</div>
                        {item.description ? <div className="muted text-sm mt-2">{item.description}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No maintenance logs yet" sub="Use the log service action to keep a service history for each bike." />
                )}
              </div>

              {canManageOps ? (
                <div className="card" style={{ gridColumn: '1 / -1' }}>
                  <div className="card-title"><h3>Maintenance controls</h3><Badge status="success">Operations access</Badge></div>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <button className="btn" onClick={() => openSchedule()}>Schedule next service</button>
                    <button className="btn btn-secondary" onClick={() => openServiceLog()}>Log completed service</button>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {tab === 'collections' && (
            <div className="fleet-demo-layout">
              <div className="card">
                <div className="card-title"><h3>Collections queue</h3><Badge status="overdue">{fmt(summary.overdue_amount || 0)}</Badge></div>
                {portal.collections_queue.length ? (
                  <div className="fleet-demo-list">
                    {portal.collections_queue.map((item) => (
                      <div key={item.agreement_no} className="fleet-demo-queue-item">
                        <div className="flex-between gap-3" style={{ alignItems: 'flex-start' }}>
                          <div>
                            <strong>{item.rider_name}</strong>
                            <div className="muted text-sm">{item.agreement_no} · {item.bike_registration || 'Bike not set'} · {item.stage}</div>
                          </div>
                          <div style={{ fontWeight: 700 }}>{fmt(item.amount)}</div>
                        </div>
                        <div className="muted text-sm mt-2">{item.note}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No collections items right now" sub="When agreements go overdue or default, they will appear in this queue." />
                )}
              </div>

              <div className="card">
                <div className="card-title"><h3>Workflow rules</h3><Badge status="success">Configured</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Reassignments only move open agreements onto bikes that are ready to go.</div>
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Maintenance schedules stay visible directly from the fleet workspace.</div>
                  <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Team actions are restricted by the logged-in fleet role.</div>
                </div>
              </div>

              <div className="card">
                <div className="card-title"><h3>Collections visibility</h3><Badge status="active">Operational roles</Badge></div>
                <div className="fleet-demo-callout">This tab is available only to company admin and operations users so follow-up stays focused on the team handling rider performance and payment recovery.</div>
              </div>
            </div>
          )}

          {tab === 'billing' && (
            <div className="fleet-demo-layout">
              <div className="card">
                <div className="card-title"><h3>Billing policy</h3><Badge status="active">{organization.status || 'trialing'}</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><CreditCard size={16} /> Trial or active status: full company access.</div>
                  <div className="fleet-demo-list-item"><Clock3 size={16} /> Past due: follow-up and recovery window for the subscription.</div>
                  <div className="fleet-demo-list-item"><AlertTriangle size={16} /> Suspended: operational access stays blocked until billing is restored.</div>
                  <div className="fleet-demo-list-item"><ShieldCheck size={16} /> Cancelled: workspace access is removed.</div>
                </div>
              </div>

              <div className="card">
                <div className="card-title"><h3>Company plan</h3><Badge status="info">{organization.plan_key || 'trial'}</Badge></div>
                <div className="fleet-demo-list">
                  <div className="fleet-demo-list-item"><Bike size={16} /> Max bikes: {organization.max_bikes || 10}</div>
                  <div className="fleet-demo-list-item"><Users size={16} /> Admin seats: {organization.max_admin_users || 2}</div>
                  <div className="fleet-demo-list-item"><Clock3 size={16} /> Trial ends: {organization.trial_ends_at ? fmtDate(organization.trial_ends_at) : '—'}</div>
                </div>
              </div>
            </div>
          )}

          {tab === 'team' && (
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
                <div className="card-title"><h3>Current team</h3><Badge status="active">{portal.members.length} members</Badge></div>
                {portal.members.length ? (
                  <table className="table">
                    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
                    <tbody>
                      {portal.members.map((member) => (
                        <tr key={member.id}>
                          <td>{member.full_name}</td>
                          <td>{member.email}</td>
                          <td><Badge status="active">{normalizeRoleLabel(member.role)}</Badge></td>
                          <td><Badge status={member.status}>{member.status}</Badge></td>
                          <td>{fmtDate(member.created_at)}</td>
                          <td>
                            {canManageTeam ? (
                              <div className="row" style={{ flexWrap: 'wrap' }}>
                                <button className="btn btn-secondary btn-sm" disabled={savingMemberId === member.id} onClick={() => updateMember(member.id, { role: member.role === 'fleet_owner_viewer' ? 'fleet_owner_ops' : 'fleet_owner_viewer' })}>{member.role === 'fleet_owner_viewer' ? 'Make ops lead' : 'Make viewer'}</button>
                                <button className="btn btn-secondary btn-sm" disabled={savingMemberId === member.id} onClick={() => updateMember(member.id, { status: member.status === 'active' ? 'suspended' : 'active' })}>{member.status === 'active' ? 'Suspend' : 'Activate'}</button>
                              </div>
                            ) : (
                              <span className="muted text-sm">No action</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="No team members yet" sub="Invite teammates to give operations, billing, or viewer access to this fleet workspace." />
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {activeModal === 'allocation' && (
        <Modal title="Allocate rider to bike" onClose={() => setActiveModal(null)}>
          <form onSubmit={submitAllocation} className="grid grid-2">
            <div className="field"><label className="label">Bike</label><select value={allocationForm.bike_id} onChange={(e) => setAllocationForm((prev) => ({ ...prev, bike_id: e.target.value }))} required>{readyBikeOptions.map((bike) => <option key={bike.id} value={bike.id}>{bike.registration || `Bike #${bike.id}`} · {bikeLabel(bike)}</option>)}</select></div>
            <div className="field"><label className="label">Rider</label><select value={allocationForm.rider_id} onChange={(e) => setAllocationForm((prev) => ({ ...prev, rider_id: e.target.value }))} required><option value="">Select rider</option>{riderOptions.map((rider) => <option key={rider.id} value={rider.id}>{rider.full_name} · {rider.email}</option>)}</select></div>
            <div className="field"><label className="label">Start date</label><input type="date" value={allocationForm.start_date} onChange={(e) => setAllocationForm((prev) => ({ ...prev, start_date: e.target.value }))} required /></div>
            <div className="field"><label className="label">Weekly amount</label><input type="number" min="1" step="0.01" value={allocationForm.weekly_amount} onChange={(e) => setAllocationForm((prev) => ({ ...prev, weekly_amount: e.target.value }))} required /></div>
            <div className="field"><label className="label">Total weeks</label><input type="number" min="1" step="1" value={allocationForm.total_weeks} onChange={(e) => setAllocationForm((prev) => ({ ...prev, total_weeks: e.target.value }))} required /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Notes</label><textarea rows="3" value={allocationForm.notes} onChange={(e) => setAllocationForm((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Optional allocation note" /></div>
            <div className="row" style={{ gridColumn: '1 / -1', justifyContent: 'flex-end' }}><button type="button" className="btn btn-secondary" onClick={() => setActiveModal(null)}>Cancel</button><button className="btn" disabled={actionBusy === 'allocation' || !riderOptions.length}>{actionBusy === 'allocation' ? 'Allocating…' : 'Allocate rider'}</button></div>
          </form>
          {!riderOptions.length ? <div className="muted text-sm mt-3">No available riders are currently linked to this fleet. Add riders through your approval flow first.</div> : null}
        </Modal>
      )}

      {activeModal === 'reassignment' && (
        <Modal title="Reassign active agreement to another bike" onClose={() => setActiveModal(null)}>
          <form onSubmit={submitReassignment} className="grid grid-2">
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Target bike</label><select value={reassignmentForm.target_bike_id} onChange={(e) => setReassignmentForm((prev) => ({ ...prev, target_bike_id: e.target.value }))} required><option value="">Select ready-to-go bike</option>{readyBikeOptions.map((bike) => <option key={bike.id} value={bike.id}>{bike.registration || `Bike #${bike.id}`} · {bikeLabel(bike)}</option>)}</select></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Reassignment note</label><textarea rows="3" value={reassignmentForm.note} onChange={(e) => setReassignmentForm((prev) => ({ ...prev, note: e.target.value }))} placeholder="Optional reason for reassignment" /></div>
            <div className="row" style={{ gridColumn: '1 / -1', justifyContent: 'flex-end' }}><button type="button" className="btn btn-secondary" onClick={() => setActiveModal(null)}>Cancel</button><button className="btn" disabled={actionBusy === 'reassignment'}>{actionBusy === 'reassignment' ? 'Reassigning…' : 'Reassign bike'}</button></div>
          </form>
        </Modal>
      )}

      {activeModal === 'schedule' && (
        <Modal title="Schedule next service" onClose={() => setActiveModal(null)}>
          <form onSubmit={submitSchedule} className="grid grid-2">
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Bike</label><select value={scheduleForm.bike_id} onChange={(e) => setScheduleForm((prev) => ({ ...prev, bike_id: e.target.value }))} required><option value="">Select bike</option>{portal.bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.registration || `Bike #${bike.id}`} · {bikeLabel(bike)}</option>)}</select></div>
            <div className="field"><label className="label">Next service date</label><input type="date" value={scheduleForm.next_service_date} onChange={(e) => setScheduleForm((prev) => ({ ...prev, next_service_date: e.target.value }))} /></div>
            <div className="field"><label className="label">Next service km</label><input type="number" min="0" step="1" value={scheduleForm.next_service_km} onChange={(e) => setScheduleForm((prev) => ({ ...prev, next_service_km: e.target.value }))} /></div>
            <div className="field"><label className="label">Current odometer km</label><input type="number" min="0" step="1" value={scheduleForm.odometer_km} onChange={(e) => setScheduleForm((prev) => ({ ...prev, odometer_km: e.target.value }))} /></div>
            <div className="field"><label className="label">Note</label><input value={scheduleForm.notes} onChange={(e) => setScheduleForm((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Optional maintenance note" /></div>
            <div className="row" style={{ gridColumn: '1 / -1', justifyContent: 'flex-end' }}><button type="button" className="btn btn-secondary" onClick={() => setActiveModal(null)}>Cancel</button><button className="btn" disabled={actionBusy === 'schedule'}>{actionBusy === 'schedule' ? 'Saving…' : 'Save schedule'}</button></div>
          </form>
        </Modal>
      )}

      {activeModal === 'service-log' && (
        <Modal title="Log completed service" onClose={() => setActiveModal(null)}>
          <form onSubmit={submitServiceLog} className="grid grid-2">
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Bike</label><select value={serviceLogForm.bike_id} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, bike_id: e.target.value }))} required><option value="">Select bike</option>{portal.bikes.map((bike) => <option key={bike.id} value={bike.id}>{bike.registration || `Bike #${bike.id}`} · {bikeLabel(bike)}</option>)}</select></div>
            <div className="field"><label className="label">Service date</label><input type="date" value={serviceLogForm.service_date} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, service_date: e.target.value }))} required /></div>
            <div className="field"><label className="label">Service type</label><input value={serviceLogForm.service_type} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, service_type: e.target.value }))} required /></div>
            <div className="field"><label className="label">Cost</label><input type="number" min="0" step="0.01" value={serviceLogForm.cost} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, cost: e.target.value }))} /></div>
            <div className="field"><label className="label">Odometer km</label><input type="number" min="0" step="1" value={serviceLogForm.odometer_km} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, odometer_km: e.target.value }))} /></div>
            <div className="field"><label className="label">Next service date</label><input type="date" value={serviceLogForm.next_service_date} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, next_service_date: e.target.value }))} /></div>
            <div className="field"><label className="label">Next service km</label><input type="number" min="0" step="1" value={serviceLogForm.next_service_km} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, next_service_km: e.target.value }))} /></div>
            <div className="field"><label className="label">Status after service</label><select value={serviceLogForm.bike_status_after_service} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, bike_status_after_service: e.target.value }))}><option value="">Keep current status</option><option value="active">Active</option><option value="ready_to_go">Ready to go</option><option value="repairs">Repairs</option><option value="not_available">Not available</option><option value="stationary">Stationary</option></select></div>
            <div className="field"><label className="label">Performed by</label><input value={serviceLogForm.performed_by} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, performed_by: e.target.value }))} placeholder="Workshop or technician" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Description</label><textarea rows="3" value={serviceLogForm.description} onChange={(e) => setServiceLogForm((prev) => ({ ...prev, description: e.target.value }))} placeholder="Repairs completed, parts replaced, and notes" /></div>
            <div className="row" style={{ gridColumn: '1 / -1', justifyContent: 'flex-end' }}><button type="button" className="btn btn-secondary" onClick={() => setActiveModal(null)}>Cancel</button><button className="btn" disabled={actionBusy === 'service-log'}>{actionBusy === 'service-log' ? 'Saving…' : 'Save service log'}</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

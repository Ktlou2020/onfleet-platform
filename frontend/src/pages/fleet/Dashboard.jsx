import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bike, CheckCircle2, Clock3, CreditCard, FileText, TrendingUp, Wrench, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, EmptyState, Loading, fmt, fmtDate, fmtDateTime } from '../../components/ui';
import { canAccessFleetRoute } from './access';
import { FleetHelpTip } from './helpSupport';

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

function ServiceUrgencyDot({ nextServiceDate, nextServiceKm, odometerKm }) {
  if (!nextServiceDate && !nextServiceKm) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (nextServiceDate) {
    const serviceDay = new Date(`${nextServiceDate}T00:00:00`);
    const days = Math.round((serviceDay - today) / 86400000);
    if (days < 0) return <span className="urgency-dot urgency-overdue" title={`Service overdue by ${Math.abs(days)} day(s)`} />;
    if (days <= 14) return <span className="urgency-dot urgency-soon" title={`Service due in ${days} day(s)`} />;
  }
  if (nextServiceKm && odometerKm) {
    const kmLeft = Number(nextServiceKm) - Number(odometerKm);
    if (kmLeft <= 0) return <span className="urgency-dot urgency-overdue" title="Service overdue by km" />;
    if (kmLeft <= 500) return <span className="urgency-dot urgency-soon" title={`Service due in ${kmLeft} km`} />;
  }
  return <span className="urgency-dot urgency-ok" title="Service on track" />;
}

export default function FleetDashboard() {
  const { user } = useAuth();
  const [portal, setPortal] = useState(emptyPortal);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadPortal = async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const { data } = await api.get('/fleet/portal-data');
      setPortal({ ...emptyPortal, ...data });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load fleet dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadPortal(); }, []);

  const organization = portal.organization || {};
  const summary = portal.summary || {};
  const totalBikes = portal.bikes.length;
  const activeBikes = summary.active_bikes || 0;
  const utilization = totalBikes > 0 ? Math.round((activeBikes / totalBikes) * 100) : 0;

  const canOpenBikes = canAccessFleetRoute(user?.role, 'bikes');
  const canOpenAgreements = canAccessFleetRoute(user?.role, 'agreements');
  const canOpenPayments = canAccessFleetRoute(user?.role, 'payments');
  const canOpenHelp = canAccessFleetRoute(user?.role, 'help');

  const overdueServiceBikes = useMemo(() => portal.upcoming_services.filter((item) => {
    if (!item.next_service_date) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(`${item.next_service_date}T00:00:00`) < today;
  }), [portal.upcoming_services]);

  const expiredDiscBikes = useMemo(() => portal.bikes.filter((bike) => {
    if (!bike.license_disc_expiry) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(`${bike.license_disc_expiry}T00:00:00`) <= today;
  }), [portal.bikes]);

  const nearDiscBikes = useMemo(() => portal.bikes.filter((bike) => {
    if (!bike.license_disc_expiry) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiry = new Date(`${bike.license_disc_expiry}T00:00:00`);
    const days = Math.round((expiry - today) / 86400000);
    return days > 0 && days <= 30;
  }), [portal.bikes]);

  const canOpenBilling = canAccessFleetRoute(user?.role, 'billing');

  // Trial / subscription status checks
  const orgStatus = organization.status;
  const trialEndsAt = organization.trial_ends_at ? new Date(organization.trial_ends_at) : null;
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const trialDaysLeft = trialEndsAt ? Math.max(0, Math.round((trialEndsAt - todayDate) / 86400000)) : null;
  const trialExpired = orgStatus === 'past_due' || (orgStatus === 'trialing' && trialEndsAt && trialEndsAt < todayDate);
  const trialExpiringSoon = orgStatus === 'trialing' && trialDaysLeft !== null && trialDaysLeft <= 5 && !trialExpired;

  if (loading) return <Loading />;

  const hasAlerts = (summary.defaulted_agreements || 0) > 0 || overdueServiceBikes.length > 0 || expiredDiscBikes.length > 0 || trialExpired || trialExpiringSoon;

  return (
    <>
      {/* Header */}
      <div className="flex-between mb-4" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Fleet dashboard</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>Live overview of your fleet health, collections, and maintenance status.</p>
          <FleetHelpTip section="dashboard" tooltip="The dashboard shows your live fleet health, collections queue, maintenance reminders, and shortcuts to the next actions your team should take." label="Learn more about the dashboard" />
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="muted text-sm">Updated {portal.live_updated_at ? fmtDateTime(portal.live_updated_at) : '—'}</div>
          {canOpenHelp && <Link className="btn btn-secondary btn-sm" to="/fleet/app/help">Help guide</Link>}
          <button className="btn btn-secondary btn-sm" onClick={() => loadPortal({ silent: true })} disabled={refreshing} title="Refresh dashboard data">
            <RefreshCw size={14} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Alert banners */}
      {hasAlerts && (
        <div className="mb-4">
          {trialExpired && (
            <div className="alert-banner alert-danger">
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>Your trial has ended.</strong> Subscribe to a paid plan to restore full access.
                {canOpenBilling && <> <Link to="/fleet/app/billing">View billing →</Link></>}
              </span>
            </div>
          )}
          {trialExpiringSoon && (
            <div className="alert-banner alert-warn">
              <Clock3 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>Trial expires in {trialDaysLeft} day{trialDaysLeft !== 1 ? 's' : ''}.</strong> Subscribe now to avoid disruption.
                {canOpenBilling && <> <Link to="/fleet/app/billing">Subscribe →</Link></>}
              </span>
            </div>
          )}
          {(summary.defaulted_agreements || 0) > 0 && (
            <div className="alert-banner alert-danger">
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>{summary.defaulted_agreements} defaulted agreement{summary.defaulted_agreements !== 1 ? 's' : ''}</strong> require{summary.defaulted_agreements === 1 ? 's' : ''} follow-up.
                {canOpenAgreements && <> <Link to="/fleet/app/agreements">Review agreements →</Link></>}
              </span>
            </div>
          )}
          {overdueServiceBikes.length > 0 && (
            <div className="alert-banner alert-warn">
              <Wrench size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>{overdueServiceBikes.length} bike{overdueServiceBikes.length !== 1 ? 's' : ''}</strong> {overdueServiceBikes.length === 1 ? 'has' : 'have'} overdue service — schedule maintenance soon.
                {canOpenBikes && <> <Link to="/fleet/app/bikes">View bikes →</Link></>}
              </span>
            </div>
          )}
          {expiredDiscBikes.length > 0 && (
            <div className="alert-banner alert-danger">
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>{expiredDiscBikes.length} license disc{expiredDiscBikes.length !== 1 ? 's' : ''} expired</strong> — renew before operating on public roads.
              </span>
            </div>
          )}
          {nearDiscBikes.length > 0 && (
            <div className="alert-banner alert-warn">
              <Clock3 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>{nearDiscBikes.length} license disc{nearDiscBikes.length !== 1 ? 's' : ''}</strong> expiring within 30 days — renew proactively.
              </span>
            </div>
          )}
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-4 mb-4">
        <div className="stat">
          <div className="flex-between">
            <div className="stat-label">Active bikes</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}><Bike size={16} /></div>
          </div>
          <div className="stat-value">{activeBikes}</div>
          <div className="stat-delta muted">{summary.ready_bikes || 0} ready to deploy</div>
          {totalBikes > 0 && (
            <div className="metric-bar"><div className="metric-fill" style={{ width: `${utilization}%` }} /></div>
          )}
        </div>
        <div className={`stat ${utilization < 50 ? 'stat-warn' : ''}`}>
          <div className="flex-between">
            <div className="stat-label">Fleet utilization</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: utilization < 50 ? 'var(--warn)' : 'var(--primary)' }}><TrendingUp size={16} /></div>
          </div>
          <div className="stat-value">{utilization}%</div>
          <div className="stat-delta muted">{totalBikes} bikes total · {summary.bikes_in_repairs || 0} in repairs</div>
        </div>
        <div className="stat">
          <div className="flex-between">
            <div className="stat-label">Open agreements</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}><FileText size={16} /></div>
          </div>
          <div className="stat-value">{summary.open_agreements || 0}</div>
          <div className="stat-delta muted">{summary.defaulted_agreements || 0} defaulted</div>
        </div>
        <div className={`stat ${(summary.overdue_amount || 0) > 0 ? 'stat-danger' : ''}`}>
          <div className="flex-between">
            <div className="stat-label">Overdue balance</div>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: (summary.overdue_amount || 0) > 0 ? 'var(--danger)' : 'var(--primary)' }}><CreditCard size={16} /></div>
          </div>
          <div className="stat-value">{fmt(summary.overdue_amount || 0)}</div>
          <div className="stat-delta muted">{portal.collections_queue.length} collection{portal.collections_queue.length !== 1 ? 's' : ''} queued</div>
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-3 mb-4">
        {/* Organization account */}
        <div className="card">
          <div className="card-title">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h3>Organization</h3>
              <FleetHelpTip section="getting-started" tooltip="Confirm your company name, plan, trial dates, and team access here." compact />
            </div>
            <Badge status={organization.status === 'trialing' ? 'pending' : 'active'}>{organization.status || 'trialing'}</Badge>
          </div>
          <div className="fleet-demo-list">
            <div className="fleet-demo-list-item"><Bike size={15} /> {organization.name || '—'}</div>
            <div className="fleet-demo-list-item"><CreditCard size={15} /> {String(organization.plan_key || 'trial').replace(/_/g, ' ')}</div>
            <div className="fleet-demo-list-item"><Clock3 size={15} /> Trial ends: {organization.trial_ends_at ? fmtDate(organization.trial_ends_at) : '—'}</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} /> {portal.members.length} team member{portal.members.length !== 1 ? 's' : ''}</div>
          </div>
        </div>

        {/* Operations snapshot */}
        <div className="card">
          <div className="card-title">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h3>Operations</h3>
              <FleetHelpTip section="dashboard" tooltip="Use this snapshot to decide whether to work on bikes, agreements, or payments next." compact />
            </div>
            <Badge status="active">Live</Badge>
          </div>
          <div className="fleet-demo-list" style={{ marginBottom: 16 }}>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> {summary.ready_bikes || 0} bikes ready for allocation</div>
            {(summary.defaulted_agreements || 0) > 0 && <div className="fleet-demo-list-item"><AlertTriangle size={15} style={{ color: 'var(--danger)' }} /> {summary.defaulted_agreements} agreements need follow-up</div>}
            <div className="fleet-demo-list-item"><Wrench size={15} style={{ color: 'var(--warn)' }} /> {summary.bikes_in_repairs || 0} bikes in repairs</div>
            <div className="fleet-demo-list-item"><Clock3 size={15} /> {summary.due_this_week || 0} services due this week</div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {canOpenBikes && <Link className="btn btn-sm" to="/fleet/app/bikes">Bikes</Link>}
            {canOpenAgreements && <Link className="btn btn-sm btn-secondary" to="/fleet/app/agreements">Agreements</Link>}
            {canOpenPayments && <Link className="btn btn-sm btn-secondary" to="/fleet/app/payments">Payments</Link>}
          </div>
        </div>

        {/* Upcoming services */}
        <div className="card">
          <div className="card-title">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h3>Upcoming services</h3>
              <FleetHelpTip section="maintenance-and-accuracy" tooltip="Plan maintenance before bikes become unavailable or overdue for attention." compact />
            </div>
            <Badge status={overdueServiceBikes.length > 0 ? 'overdue' : 'pending'}>{portal.upcoming_services.length} scheduled</Badge>
          </div>
          {portal.upcoming_services.length ? (
            <div className="fleet-demo-list">
              {portal.upcoming_services.slice(0, 5).map((item) => (
                <div key={`${item.bike_id}-${item.next_service_date || 'none'}`} className="fleet-demo-queue-item">
                  <div className="flex-between" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <ServiceUrgencyDot nextServiceDate={item.next_service_date} nextServiceKm={item.next_service_km} odometerKm={item.odometer_km} />
                      <div>
                        <strong style={{ fontSize: 13 }}>{item.registration || item.bike_label}</strong>
                        <div className="muted text-xs">{item.rider_name || 'Unassigned'}</div>
                      </div>
                    </div>
                    <Badge status={item.status}>{String(item.status).replace(/_/g, ' ')}</Badge>
                  </div>
                  <div className="muted text-xs mt-2">
                    Due {item.next_service_date ? fmtDate(item.next_service_date) : '—'}
                    {item.next_service_km ? ` · ${Number(item.next_service_km).toLocaleString('en-ZA')} km` : ''}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No services scheduled" sub="Next service dates from your bikes page will show here." />
          )}
        </div>
      </div>

      {/* Bottom grid */}
      <div className="grid grid-2">
        {/* Collections queue */}
        <div className="card">
          <div className="card-title">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h3>Collections queue</h3>
              <FleetHelpTip section="common-questions" tooltip="Start here when you need to know which overdue or defaulted agreements need payment follow-up first." compact />
            </div>
            <Badge status="overdue">{fmt(summary.overdue_amount || 0)}</Badge>
          </div>
          {portal.collections_queue.length ? (
            <div className="fleet-demo-list">
              {portal.collections_queue.slice(0, 6).map((item) => (
                <div key={item.agreement_no} className="fleet-demo-queue-item">
                  <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start' }}>
                    <div>
                      <strong style={{ fontSize: 13 }}>{item.rider_name}</strong>
                      <div className="muted text-xs">{item.agreement_no} · {item.bike_registration || 'Bike pending'}</div>
                    </div>
                    <div style={{ fontWeight: 700, color: 'var(--danger)', whiteSpace: 'nowrap' }}>{fmt(item.amount)}</div>
                  </div>
                  <div className="muted text-xs mt-2">{item.note}</div>
                </div>
              ))}
              {portal.collections_queue.length > 6 && (
                <div className="muted text-xs" style={{ textAlign: 'center', paddingTop: 4 }}>
                  +{portal.collections_queue.length - 6} more ·{' '}
                  {canOpenPayments && <Link to="/fleet/app/payments" style={{ color: 'var(--primary-light)' }}>View all payments →</Link>}
                </div>
              )}
            </div>
          ) : (
            <EmptyState title="No collections items" sub="Overdue and defaulted agreements will surface here." />
          )}
        </div>

        {/* Recent maintenance */}
        <div className="card">
          <div className="card-title">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h3>Recent maintenance</h3>
              <FleetHelpTip section="maintenance-and-accuracy" tooltip="Review recent service logs to verify maintenance was recorded and spot bikes that need follow-up." compact />
            </div>
            <Badge status={portal.recent_services.length ? 'success' : 'pending'}>{portal.recent_services.length} logs</Badge>
          </div>
          {portal.recent_services.length ? (
            <div className="fleet-demo-list">
              {portal.recent_services.slice(0, 5).map((item) => (
                <div key={item.id} className="fleet-demo-queue-item">
                  <div className="flex-between" style={{ gap: 8 }}>
                    <div>
                      <strong style={{ fontSize: 13 }}>{item.registration || 'Bike record'}</strong>
                      <div className="muted text-xs">{item.service_type} · {fmtDate(item.service_date)}</div>
                    </div>
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(item.cost || 0)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No maintenance logs yet" sub="Scheduled and completed service history will appear here." />
          )}
        </div>
      </div>
    </>
  );
}

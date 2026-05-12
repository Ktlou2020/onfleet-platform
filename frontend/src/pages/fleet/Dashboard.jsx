import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bike, CheckCircle2, Clock3, CreditCard, FileText, Wrench } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, EmptyState, Loading, Stat, fmt, fmtDate, fmtDateTime } from '../../components/ui';
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

export default function FleetDashboard() {
  const { user } = useAuth();
  const [portal, setPortal] = useState(emptyPortal);
  const [loading, setLoading] = useState(true);

  const loadPortal = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/fleet/portal-data');
      setPortal({ ...emptyPortal, ...data });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load fleet dashboard');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { loadPortal(); }, []);

  const organization = portal.organization || {};
  const summary = portal.summary || {};
  const quickQueues = useMemo(() => portal.collections_queue.slice(0, 4), [portal.collections_queue]);
  const canOpenBikes = canAccessFleetRoute(user?.role, 'bikes');
  const canOpenAgreements = canAccessFleetRoute(user?.role, 'agreements');
  const canOpenPayments = canAccessFleetRoute(user?.role, 'payments');
  const canOpenHelp = canAccessFleetRoute(user?.role, 'help');

  if (loading) return <Loading />;

  return (
    <>
      <div className="flex-between mb-4" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Fleet dashboard</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>Run the same day-to-day bike, agreement, and payment workflows as the super admin console, but scoped to your organization only.</p>
          <FleetHelpTip section="dashboard" tooltip="The dashboard shows your live fleet health, collections queue, maintenance reminders, and shortcuts to the next actions your team should take." label="Learn more about the dashboard" />
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="muted text-sm">Live sync {portal.live_updated_at ? fmtDateTime(portal.live_updated_at) : '—'}</div>
          {canOpenHelp && <Link className="btn btn-secondary btn-sm" to="/fleet/app/help">Open help guide</Link>}
          <button className="btn btn-secondary btn-sm" onClick={() => loadPortal({ silent: true })}>Refresh</button>
        </div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Active bikes" value={summary.active_bikes || 0} delta={`${summary.ready_bikes || 0} ready to deploy`} icon={<Bike size={16} />} />
        <Stat label="Open agreements" value={summary.open_agreements || 0} delta={`${summary.defaulted_agreements || 0} defaulted`} icon={<FileText size={16} />} />
        <Stat label="Overdue amount" value={fmt(summary.overdue_amount || 0)} delta={`${quickQueues.length} queue items`} icon={<CreditCard size={16} />} accent="var(--danger)" />
        <Stat label="Upcoming services" value={summary.upcoming_services || 0} delta={`${summary.due_this_week || 0} due this week`} icon={<Wrench size={16} />} accent="var(--warning)" />
      </div>

      <div className="grid grid-3 mb-4">
        <div className="card">
          <div className="card-title"><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><h3>Organization account</h3><FleetHelpTip section="getting-started" tooltip="Use this card to confirm your company name, plan, trial dates, and team access before working through daily operations." compact /></div><Badge status={organization.status === 'trialing' ? 'pending' : 'active'}>{organization.status || 'trialing'}</Badge></div>
          <div className="fleet-demo-list">
            <div className="fleet-demo-list-item"><Bike size={16} /> Company: {organization.name || '—'}</div>
            <div className="fleet-demo-list-item"><CreditCard size={16} /> Plan: {String(organization.plan_key || 'trial').replace(/_/g, ' ')}</div>
            <div className="fleet-demo-list-item"><Clock3 size={16} /> Trial ends: {organization.trial_ends_at ? fmtDate(organization.trial_ends_at) : '—'}</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> Team members: {portal.members.length}</div>
          </div>
        </div>

        <div className="card">
          <div className="card-title"><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><h3>Operations snapshot</h3><FleetHelpTip section="dashboard" tooltip="Use this snapshot to decide whether to work on bikes, agreements, or payments next." compact /></div><Badge status="active">Live</Badge></div>
          <div className="fleet-demo-list">
            <div className="fleet-demo-list-item"><CheckCircle2 size={16} /> {summary.ready_bikes || 0} bikes ready for agreement allocation</div>
            <div className="fleet-demo-list-item"><AlertTriangle size={16} /> {summary.defaulted_agreements || 0} agreements need follow-up</div>
            <div className="fleet-demo-list-item"><Wrench size={16} /> {summary.bikes_in_repairs || 0} bikes currently in repairs</div>
          </div>
          <div className="row mt-3" style={{ flexWrap: 'wrap', gap: 8 }}>
            {canOpenBikes && <Link className="btn btn-sm" to="/fleet/app/bikes">Open bikes</Link>}
            {canOpenAgreements && <Link className="btn btn-sm btn-secondary" to="/fleet/app/agreements">Open agreements</Link>}
            {canOpenPayments && <Link className="btn btn-sm btn-secondary" to="/fleet/app/payments">Open payments</Link>}
          </div>
        </div>

        <div className="card">
          <div className="card-title"><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><h3>Recent maintenance</h3><FleetHelpTip section="maintenance-and-accuracy" tooltip="Review recent service logs to verify maintenance was recorded and to spot bikes that may need follow-up service planning." compact /></div><Badge status={portal.recent_services.length ? 'success' : 'pending'}>{portal.recent_services.length} logs</Badge></div>
          {portal.recent_services.length ? (
            <div className="fleet-demo-list">
              {portal.recent_services.slice(0, 3).map((item) => (
                <div key={item.id} className="fleet-demo-queue-item">
                  <strong>{item.registration || 'Bike record'}</strong>
                  <div className="muted text-sm">{item.service_type} · {fmtDate(item.service_date)}</div>
                  <div className="muted text-sm">{fmt(item.cost || 0)}</div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No maintenance logs yet" sub="Scheduled and completed service history will appear here." />
          )}
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-title"><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><h3>Collections queue</h3><FleetHelpTip section="common-questions" tooltip="Start here when you need to know which overdue or defaulted agreements need payment follow-up first." compact /></div><Badge status="overdue">{fmt(summary.overdue_amount || 0)}</Badge></div>
          {quickQueues.length ? (
            <div className="fleet-demo-list">
              {quickQueues.map((item) => (
                <div key={item.agreement_no} className="fleet-demo-queue-item">
                  <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start' }}>
                    <div>
                      <strong>{item.rider_name}</strong>
                      <div className="muted text-sm">{item.agreement_no} · {item.bike_registration || 'Bike pending'}</div>
                    </div>
                    <div style={{ fontWeight: 700 }}>{fmt(item.amount)}</div>
                  </div>
                  <div className="muted text-sm mt-2">{item.note}</div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No collections items" sub="Overdue and defaulted agreements will surface here." />
          )}
        </div>

        <div className="card">
          <div className="card-title"><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><h3>Upcoming services</h3><FleetHelpTip section="maintenance-and-accuracy" tooltip="Use upcoming services to plan maintenance before bikes become unavailable or overdue for attention." compact /></div><Badge status="pending">{portal.upcoming_services.length}</Badge></div>
          {portal.upcoming_services.length ? (
            <div className="fleet-demo-list">
              {portal.upcoming_services.slice(0, 6).map((item) => (
                <div key={`${item.bike_id}-${item.next_service_date || 'none'}`} className="fleet-demo-queue-item">
                  <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start' }}>
                    <div>
                      <strong>{item.registration || item.bike_label}</strong>
                      <div className="muted text-sm">{item.bike_label} · {item.rider_name || 'Unassigned'}</div>
                    </div>
                    <Badge status={item.status}>{String(item.status).replace(/_/g, ' ')}</Badge>
                  </div>
                  <div className="muted text-sm mt-2">Due {item.next_service_date ? fmtDate(item.next_service_date) : '—'}{item.next_service_km ? ` · ${Number(item.next_service_km).toLocaleString('en-ZA')} km` : ''}</div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No service bookings yet" sub="Next service dates from your bikes page will show here." />
          )}
        </div>
      </div>
    </>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, DashboardSkeleton, EmptyState, Stat, fmt } from '../../components/ui';
import { Briefcase, Bike, Radio, AlertTriangle, TrendingUp, Wallet, Plus } from 'lucide-react';
import OnboardFleet from './OnboardFleet';
import { brandName } from '../../brand';

// The home page of a telematics console.
//
// A company that sells the platform has a different set of questions from one
// that runs motorcycles. Not "who is in arrears" — that is a tenant's problem,
// on a tenant's own dashboard — but: how many fleets are on it, are their
// devices actually reporting, and is anybody about to stop paying.
//
// Both halves come from endpoints that already existed for other pages:
// /admin/fleet-owners/dashboard and /tracking/device-health. Nothing new is
// computed here, which is deliberate — a second implementation of "how many
// bikes" is a second number to disagree with the first.

const STATUS_TONE = {
  active: 'success',
  trialing: 'info',
  past_due: 'warning',
  suspended: 'danger',
};

// Device states that mean somebody has to do something, in the order a
// telematics company would work through them.
const DEVICE_ACTIONS = [
  ['uncommissioned', 'Not commissioned', 'Fitted but never signed off'],
  ['awaiting_install_proof', 'No install proof', 'Registered over a day ago with nothing to show'],
  ['ignition_unwired', 'Ignition not wired', 'Reports the element but never a 1 — every ride reads as a tow'],
  ['unlinked', 'Not on a bike', 'In stock, or fitted and never linked'],
  ['silent', 'Silent over a day', 'Last position more than 24 hours ago'],
  ['never_connected', 'Never connected', 'Has not reported once since it was added'],
];

export default function PlatformDashboard() {
  const [fleets, setFleets] = useState(null);
  const [devices, setDevices] = useState(null);
  const [loading, setLoading] = useState(true);
  const [onboarding, setOnboarding] = useState(false);
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      // Settled separately: a telematics console with no trackers yet should
      // still show its tenants, and vice versa.
      const [f, d] = await Promise.allSettled([
        api.get('/admin/fleet-owners/dashboard'),
        api.get('/tracking/device-health'),
      ]);
      if (f.status === 'fulfilled') setFleets(f.value.data);
      if (d.status === 'fulfilled') setDevices(d.value.data.summary);
      if (f.status === 'rejected' && d.status === 'rejected') {
        toast.error('Could not load the platform dashboard');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const s = fleets?.summary;
  const orgs = useMemo(
    () => [...(fleets?.organizations || [])].sort(
      (a, z) => Number(z.bike_count || 0) - Number(a.bike_count || 0)),
    [fleets]);

  const needsAttention = useMemo(
    () => DEVICE_ACTIONS.map(([key, label, why]) => ({ key, label, why, n: Number(devices?.[key] || 0) }))
      .filter((r) => r.n > 0),
    [devices]);

  if (loading) return <DashboardSkeleton statCount={4} />;

  return (
    <>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{brandName} platform</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            The fleets on it, the devices in their bikes, and what they are billed.
          </p>
        </div>
        <button className="btn" onClick={() => setOnboarding(true)}>
          <Plus size={16} /> Onboard a fleet
        </button>
      </div>

      <div className="grid grid-4" style={{ marginTop: 18 }}>
        <Stat label="Fleets" value={s?.organizations ?? '—'} icon={<Briefcase size={18} />}
              onClick={() => nav('/admin/fleet-dashboard')} />
        <Stat label="Bikes under management" value={s?.bikes ?? '—'} icon={<Bike size={18} />} />
        <Stat
          label="Devices reporting"
          value={devices?.reporting_pct != null ? `${devices.reporting_pct}%` : '—'}
          delta={devices ? `${devices.reporting} of ${devices.total}` : undefined}
          icon={<Radio size={18} />}
          onClick={() => nav('/admin/tracking/dashboard')}
        />
        <Stat label="Collected, 30 days" value={s ? fmt(s.revenue_30d) : '—'} icon={<TrendingUp size={18} />} />
      </div>

      {/* Money owed to us by tenants, and money their riders owe them, are
          different things and must not sit in one number. */}
      <div className="grid grid-4" style={{ marginTop: 14 }}>
        <Stat label="Trialing" value={s?.trialing ?? '—'} />
        <Stat label="Active" value={s?.active ?? '—'} />
        <Stat label="Past due" value={s?.past_due ?? '—'} accent={s?.past_due ? 'warning' : undefined}
              onClick={() => nav('/admin/paystack-subscriptions')} />
        <Stat label="Suspended" value={s?.suspended ?? '—'} accent={s?.suspended ? 'danger' : undefined} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 22, gap: 18, alignItems: 'start' }}>
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 10 }}>
            <h2 style={{ marginBottom: 0, marginLeft: 0 }}>Devices needing attention</h2>
            <button className="btn btn-secondary btn-sm" onClick={() => nav('/admin/tracking/dashboard')}>
              Open device health
            </button>
          </div>
          {!devices ? (
            <p className="muted text-sm">No tracking data yet.</p>
          ) : needsAttention.length === 0 ? (
            <p className="muted text-sm">
              Nothing outstanding — every device is commissioned, linked and reporting.
            </p>
          ) : needsAttention.map((r) => (
            <div key={r.key} className="flex-between"
                 style={{ padding: '9px 0', borderTop: '1px solid var(--border)', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.label}</div>
                <div className="text-xs muted">{r.why}</div>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, flexShrink: 0 }}>{r.n}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="flex-between" style={{ marginBottom: 10 }}>
            <h2 style={{ marginBottom: 0, marginLeft: 0 }}>Fleets</h2>
            <button className="btn btn-secondary btn-sm" onClick={() => nav('/admin/fleet-owners')}>
              Manage accounts
            </button>
          </div>
          {orgs.length === 0 ? (
            <EmptyState title="No fleets yet" sub="Accounts you sign up will appear here." />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Fleet</th><th style={{ textAlign: 'right' }}>Bikes</th>
                    <th>Status</th><th style={{ textAlign: 'right' }}>30 days</th>
                  </tr>
                </thead>
                <tbody>
                  {orgs.slice(0, 10).map((o) => (
                    <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => nav('/admin/fleet-dashboard')}>
                      <td>{o.name}</td>
                      <td style={{ textAlign: 'right' }}>{o.bike_count ?? 0}</td>
                      <td><Badge status={STATUS_TONE[o.status] || ''}>{String(o.status || '').replace(/_/g, ' ')}</Badge></td>
                      <td style={{ textAlign: 'right' }}>{fmt(o.revenue_30d)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {orgs.length > 10 && (
                <p className="text-xs muted" style={{ marginTop: 8 }}>
                  Showing the 10 largest of {orgs.length}.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {onboarding && (
        <OnboardFleet onClose={() => setOnboarding(false)} onDone={load} />
      )}

      {s?.overdue_amount > 0 && (
        <div className="card" style={{ marginTop: 18, borderColor: 'rgba(234,179,8,0.4)' }}>
          <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
            <AlertTriangle size={20} style={{ color: '#ca8a04', flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong>{fmt(s.overdue_amount)} overdue across all fleets</strong>
              <div className="text-sm muted" style={{ marginTop: 4 }}>
                This is what riders owe the fleets, not what the fleets owe you.
                It is worth watching because a fleet that is not collecting is a
                fleet that will stop paying its subscription.
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 6 }}>
                  <Wallet size={13} /> {fmt(s.revenue_total)} collected all time.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

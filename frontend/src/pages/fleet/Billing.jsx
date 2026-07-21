import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, CreditCard, RefreshCw, XCircle, Wrench, TrendingUp } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api';
import { Badge, ConfirmModal, Loading, fmt, fmtDate } from '../../components/ui';
import { FleetHelpTip } from './helpSupport';

const STATUS_LABELS = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Past due',
  suspended: 'Suspended',
  cancelled: 'Cancelled'
};

const STATUS_BADGE = {
  trialing: 'pending',
  active: 'active',
  past_due: 'overdue',
  suspended: 'overdue',
  cancelled: 'cancelled'
};

const PLAN_DISPLAY = {
  small:  { label: 'Starter',      color: '#10b981' },
  medium: { label: 'Growth',       color: '#3b82f6' },
  large:  { label: 'Professional', color: '#8b5cf6' },
  empire: { label: 'Empire',       color: '#f59e0b' },
};

function DiagRow({ ok, label, value }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start', fontSize: 13 }}>
      {ok
        ? <CheckCircle2 size={14} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 1 }} />
        : <XCircle size={14} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />}
      <span style={{ minWidth: 200 }}>{label}</span>
      <code className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{value}</code>
    </div>
  );
}

function PlanCard({ plan, current, canSubscribe, onSubscribe, busy, recommended }) {
  const isCurrent = current?.plan_key === plan.key && current?.status === 'active';
  const display = PLAN_DISPLAY[plan.key] || {};
  return (
    <div className="card" style={{
      borderColor: isCurrent ? 'rgba(30,136,209,0.5)' : recommended && !isCurrent ? 'rgba(16,185,129,0.4)' : undefined,
      boxShadow: isCurrent
        ? '0 0 0 1px rgba(30,136,209,0.3)'
        : recommended && !isCurrent
          ? '0 0 0 1px rgba(16,185,129,0.2)'
          : undefined,
      display: 'flex', flexDirection: 'column', gap: 16, position: 'relative'
    }}>
      {recommended && !isCurrent && (
        <div style={{
          position: 'absolute', top: -10, left: 16,
          background: '#10b981', color: '#fff',
          fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 20,
          letterSpacing: '0.04em', textTransform: 'uppercase'
        }}>Recommended for your fleet</div>
      )}

      <div className="flex-between">
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: display.color || 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
            {display.label || plan.name}
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--primary-light)', fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.1 }}>
            {fmt(plan.monthly_price)}
            <span className="muted text-sm" style={{ fontWeight: 400 }}>/mo</span>
          </div>
          <div className="muted text-xs" style={{ marginTop: 3 }}>Up to {plan.max_bikes} bikes · flat rate</div>
        </div>
        {isCurrent && <Badge status="active">Current plan</Badge>}
      </div>

      <ul style={{ listStyle: 'none', display: 'grid', gap: 8 }}>
        {plan.features.map((f) => (
          <li key={f} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <CheckCircle2 size={14} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 2 }} />
            <span className="text-sm">{f}</span>
          </li>
        ))}
      </ul>

      {isCurrent ? (
        <div className="muted text-sm">Your current active plan.</div>
      ) : canSubscribe ? (
        <button className="btn" onClick={() => onSubscribe(plan.key)} disabled={busy === plan.key}
          style={recommended ? { background: '#10b981', borderColor: '#10b981' } : undefined}>
          {busy === plan.key ? 'Redirecting to Paystack…' : `Subscribe — ${fmt(plan.monthly_price)}/mo`}
        </button>
      ) : (
        <div className="muted text-sm">Manage your subscription to change plans.</div>
      )}
    </div>
  );
}

export default function FleetBilling() {
  const [searchParams] = useSearchParams();
  const [billing, setBilling] = useState(null);
  const [busy, setBusy] = useState('');
  const [showCancel, setShowCancel] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [diag, setDiag] = useState(null);
  const [diagBusy, setDiagBusy] = useState(false);

  const load = async () => {
    const { data } = await api.get('/fleet/billing/status');
    setBilling(data);
  };

  useEffect(() => {
    const reference = searchParams.get('reference') || searchParams.get('trxref');
    if (!reference || verifying || verified) return;
    setVerifying(true);
    api.get(`/fleet/billing/verify?reference=${encodeURIComponent(reference)}`)
      .then(({ data }) => {
        setVerified(true);
        const planName = PLAN_DISPLAY[data.plan_key]?.label || data.plan_key || 'paid';
        toast.success(`Subscription activated! Welcome to the ${planName} plan.`);
        window.history.replaceState({}, '', window.location.pathname);
        load();
      })
      .catch((err) => {
        toast.error(err.response?.data?.error || 'Could not verify payment — contact support if you were charged.');
      })
      .finally(() => setVerifying(false));
  }, []);

  useEffect(() => { load().catch(() => toast.error('Could not load billing status')); }, []);

  const subscribe = async (planKey) => {
    try {
      setBusy(planKey);
      const { data } = await api.post('/fleet/billing/subscribe', { plan_key: planKey });
      window.location.href = data.authorization_url;
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not initiate checkout');
      setBusy('');
    }
  };

  const cancelSubscription = async () => {
    try {
      setBusy('cancel');
      await api.post('/fleet/billing/cancel');
      toast.success('Subscription cancelled. Access continues until end of billing period.');
      setShowCancel(false);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not cancel subscription');
    } finally {
      setBusy('');
    }
  };

  const runDiag = async () => {
    setDiagBusy(true);
    try {
      const { data } = await api.get('/fleet/billing/diagnose');
      setDiag(data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Diagnose failed');
    } finally {
      setDiagBusy(false);
    }
  };

  if (!billing || verifying) return <Loading />;

  const { organization: org, plans, can_subscribe } = billing;
  const trialExpiringSoon = org.status === 'trialing' && org.trial_days_left !== null && org.trial_days_left <= 5;
  const trialExpired = org.status === 'past_due';
  const currentPlanDisplay = PLAN_DISPLAY[org.plan_key];

  return (
    <>
      <div className="flex-between mb-2" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Billing &amp; subscription</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>Manage your OnFleet fleet plan and Paystack subscription.</p>
          <FleetHelpTip section="getting-started" tooltip="Start with a 14-day free trial. Upgrade to a flat-rate monthly plan to unlock higher bike and user limits. All billing via Paystack." label="Learn more about plans" />
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => load().catch(() => {})} disabled={!!busy}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {trialExpired && (
        <div className="alert-banner alert-danger mb-4">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span><strong>Your trial has ended.</strong> Subscribe to a paid plan below to continue using all fleet features.</span>
        </div>
      )}
      {trialExpiringSoon && (
        <div className="alert-banner alert-warn mb-4">
          <Clock3 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span><strong>Your trial expires in {org.trial_days_left} day{org.trial_days_left !== 1 ? 's' : ''}.</strong> Subscribe now to avoid any disruption to your fleet operations.</span>
        </div>
      )}
      {org.status === 'suspended' && (
        <div className="alert-banner alert-danger mb-4">
          <XCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span><strong>Account suspended.</strong> Contact support to reactivate your account.</span>
        </div>
      )}
      {org.approaching_limit && org.status === 'active' && (
        <div className="alert-banner alert-warn mb-4">
          <TrendingUp size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            <strong>Approaching your bike limit.</strong> Your fleet has {org.bike_count} of {org.max_bikes} bikes.{' '}
            {org.suggested_tier !== org.plan_key && PLAN_DISPLAY[org.suggested_tier]
              ? `Upgrade to the ${PLAN_DISPLAY[org.suggested_tier].label} plan to keep growing.`
              : 'Consider upgrading your plan.'}
          </span>
        </div>
      )}

      <div className="grid grid-2 mb-4">
        <div className="card">
          <div className="card-title">
            <h3>Current plan</h3>
            <Badge status={STATUS_BADGE[org.status] || 'pending'}>{STATUS_LABELS[org.status] || org.status}</Badge>
          </div>
          <div className="fleet-demo-list">
            <div className="fleet-demo-list-item">
              <CreditCard size={15} />
              {currentPlanDisplay?.label || String(org.plan_key || 'trial').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              {org.monthly_price ? <span className="muted text-xs ml-2">{fmt(org.monthly_price)}/mo flat</span> : null}
            </div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} /> Up to {org.max_bikes} bikes</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} /> Up to {org.max_admin_users} admin users</div>
            {org.status === 'trialing' && org.trial_ends_at && (
              <div className="fleet-demo-list-item">
                <Clock3 size={15} style={{ color: trialExpiringSoon ? 'var(--warn)' : undefined }} />
                14-day free trial — ends {fmtDate(org.trial_ends_at)}
                {org.trial_days_left !== null && (
                  <span className="muted text-xs ml-2">({org.trial_days_left} day{org.trial_days_left !== 1 ? 's' : ''} left)</span>
                )}
              </div>
            )}
          </div>
          {org.status === 'active' && (
            <div className="mt-4">
              <button className="btn btn-sm btn-secondary" onClick={() => setShowCancel(true)} style={{ color: 'var(--danger)', borderColor: 'rgba(239,68,68,0.3)' }}>
                Cancel subscription
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title"><h3>How billing works</h3></div>
          <div className="fleet-demo-list">
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> Flat monthly fee — no per-bike charges</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> 14-day free trial on every new account</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> Pay monthly via Paystack (card or EFT)</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> Cancel any time — access continues until period end</div>
          </div>
          {org.bike_count != null && (
            <div className="muted text-xs mt-3" style={{ padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8 }}>
              Your fleet: <strong>{org.bike_count} bike{org.bike_count !== 1 ? 's' : ''}</strong>
              {org.suggested_tier && PLAN_DISPLAY[org.suggested_tier] && (
                <> · suggested plan: <strong>{PLAN_DISPLAY[org.suggested_tier].label}</strong> ({fmt(plans.find(p => p.key === org.suggested_tier)?.monthly_price || 0)}/mo)</>
              )}
            </div>
          )}
          <div className="muted text-xs mt-3">All transactions secured by Paystack and processed in ZAR. VAT may apply.</div>
        </div>
      </div>

      <h3 style={{ marginBottom: 16, fontSize: 18 }}>
        {can_subscribe ? 'Choose a plan' : 'Available plans'}
      </h3>
      <div className="grid grid-2 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            current={org}
            canSubscribe={can_subscribe}
            onSubscribe={subscribe}
            busy={busy}
            recommended={org.suggested_tier === plan.key && can_subscribe}
          />
        ))}
      </div>

      <div className="card" style={{ background: 'rgba(79,168,224,0.06)', borderColor: 'rgba(79,168,224,0.18)' }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <CreditCard size={20} style={{ color: 'var(--primary-light)', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Need a custom enterprise arrangement?</div>
            <div className="muted text-sm">For 100+ bikes, multi-city operations, or bespoke integrations — contact the OnFleet team directly.</div>
          </div>
        </div>
      </div>

      <div className="card mt-4" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <div className="flex-between" style={{ marginBottom: diag ? 12 : 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <Wrench size={14} style={{ color: 'var(--muted)' }} />
            <span className="text-sm muted">Paystack configuration diagnostics</span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={runDiag} disabled={diagBusy}>
            {diagBusy ? 'Checking…' : 'Run check'}
          </button>
        </div>
        {diag && (
          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            <DiagRow ok={diag.secret_key_set} label="Paystack secret key" value={diag.secret_key_env} />
            <DiagRow ok={diag.paystack_reachable} label="Paystack API reachable" value={diag.paystack_error || 'OK'} />
            {Object.entries(diag.plans).map(([key, p]) => (
              <DiagRow key={key} ok={p.valid_format} label={`Plan code: ${key} (${PLAN_DISPLAY[key]?.label || key})`} value={p.code} />
            ))}
          </div>
        )}
      </div>

      {showCancel && (
        <ConfirmModal
          title="Cancel subscription?"
          body={<>Your subscription will be cancelled and your plan will revert to <strong>trial</strong> at the end of the current billing period. You can resubscribe at any time.</>}
          danger
          confirmLabel="Yes, cancel subscription"
          busy={busy === 'cancel'}
          onConfirm={cancelSubscription}
          onClose={() => { if (busy !== 'cancel') setShowCancel(false); }}
        />
      )}
    </>
  );
}

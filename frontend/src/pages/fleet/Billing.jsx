import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, CreditCard, RefreshCw, XCircle, Wrench } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api';
import { Badge, ConfirmModal, Loading, fmt, fmtDate } from '../../components/ui';
import { FleetHelpTip } from './helpSupport';

const STATUS_LABELS = {
  trialing: 'Trial',
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

function PlanCard({ plan, current, canSubscribe, onSubscribe, busy }) {
  const isCurrent = current?.plan_key === plan.key && current?.status === 'active';
  return (
    <div className="card" style={{
      borderColor: isCurrent ? 'rgba(30,136,209,0.5)' : undefined,
      boxShadow: isCurrent ? '0 0 0 1px rgba(30,136,209,0.3)' : undefined,
      display: 'flex', flexDirection: 'column', gap: 16
    }}>
      <div className="flex-between">
        <div>
          <h3 style={{ marginBottom: 4 }}>{plan.name}</h3>
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--primary-light)', fontFamily: "'Space Grotesk', sans-serif" }}>
            {fmt(plan.price_zar)}<span className="muted text-sm" style={{ fontWeight: 400 }}>/mo</span>
          </div>
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
        <button className="btn" onClick={() => onSubscribe(plan.key)} disabled={busy === plan.key}>
          {busy === plan.key ? 'Redirecting to Paystack…' : `Subscribe — ${fmt(plan.price_zar)}/mo`}
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

  // Verify if redirected back from Paystack
  useEffect(() => {
    const reference = searchParams.get('reference') || searchParams.get('trxref');
    if (!reference || verifying || verified) return;
    setVerifying(true);
    api.get(`/fleet/billing/verify?reference=${encodeURIComponent(reference)}`)
      .then(({ data }) => {
        setVerified(true);
        toast.success(`Subscription activated! Welcome to the ${data.plan_key ? String(data.plan_key).replace(/_/g, ' ') : 'paid'} plan.`);
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

  return (
    <>
      <div className="flex-between mb-2" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Billing & subscription</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>Manage your OnFleet fleet plan and Paystack subscription.</p>
          <FleetHelpTip section="getting-started" tooltip="Upgrade from trial to a paid plan to unlock higher bike and user limits. All billing is processed securely via Paystack." label="Learn more about plans" />
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => load().catch(() => {})} disabled={!!busy}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Status alerts */}
      {trialExpired && (
        <div className="alert-banner alert-danger mb-4">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span><strong>Your trial has ended.</strong> Subscribe to a paid plan below to continue using all fleet features without interruption.</span>
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

      {/* Current plan summary */}
      <div className="grid grid-2 mb-4">
        <div className="card">
          <div className="card-title">
            <h3>Current plan</h3>
            <Badge status={STATUS_BADGE[org.status] || 'pending'}>{STATUS_LABELS[org.status] || org.status}</Badge>
          </div>
          <div className="fleet-demo-list">
            <div className="fleet-demo-list-item"><CreditCard size={15} /> {String(org.plan_key || 'trial').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} /> Up to {org.max_bikes} bikes</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} /> Up to {org.max_admin_users} admin users</div>
            {org.status === 'trialing' && org.trial_ends_at && (
              <div className="fleet-demo-list-item">
                <Clock3 size={15} style={{ color: trialExpiringSoon ? 'var(--warn)' : undefined }} />
                Trial ends: {fmtDate(org.trial_ends_at)}
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
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> Pay monthly via Paystack (card or EFT)</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> Subscription renews automatically each month</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> Plan limits update immediately after subscribing</div>
            <div className="fleet-demo-list-item"><CheckCircle2 size={15} style={{ color: 'var(--success)' }} /> Cancel any time — access continues until period end</div>
          </div>
          <div className="muted text-xs mt-3">All transactions are secured by Paystack and processed in ZAR. VAT may apply.</div>
        </div>
      </div>

      {/* Plan comparison */}
      <h3 style={{ marginBottom: 16, fontSize: 18 }}>
        {can_subscribe ? 'Choose a plan' : 'Available plans'}
      </h3>
      <div className="grid grid-3 mb-4">
        {plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            current={org}
            canSubscribe={can_subscribe}
            onSubscribe={subscribe}
            busy={busy}
          />
        ))}
      </div>

      <div className="card" style={{ background: 'rgba(79,168,224,0.06)', borderColor: 'rgba(79,168,224,0.18)' }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <CreditCard size={20} style={{ color: 'var(--primary-light)', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Need an Enterprise plan or custom pricing?</div>
            <div className="muted text-sm">For 100+ bikes, dedicated onboarding, or custom integrations, contact the OnFleet team directly.</div>
          </div>
        </div>
      </div>

      {/* Paystack config diagnostics */}
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
              <DiagRow key={key} ok={p.valid_format} label={`Plan code: ${key}`} value={p.code} />
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

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, CreditCard, AlertTriangle, Bike, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api';
import { ConfirmModal, Loading, fmt, fmtDate } from '../../components/ui';

// Choosing and paying for a Pillion plan.
//
// Priced per bike, so every price on this page is this fleet's own price at
// its own bike count — never an example. A fleet with 40 bikes should not have
// to multiply anything to find out what it will be charged.

const CYCLES = [
  { key: 'monthly', label: 'Monthly' },
  { key: 'annual', label: 'Annual', note: 'two months free' },
];

const STATUS_LABEL = {
  none: 'Not subscribed',
  active: 'Active',
  past_due: 'Payment failed',
  cancelled: 'Cancelled',
};

function TierCard({ quote, tier, selected, current, onPick }) {
  return (
    <button
      type="button"
      onClick={() => onPick(tier.key)}
      style={{
        textAlign: 'left', padding: 16, borderRadius: 10, cursor: 'pointer',
        background: selected ? 'var(--surface-2)' : 'transparent',
        border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
      }}
    >
      <div className="flex-between" style={{ alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 15 }}>{tier.name}</strong>
        {current && <span style={{ fontSize: 10, color: 'var(--success)', fontWeight: 700 }}>CURRENT</span>}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>
        {quote ? fmt(quote.total) : '—'}
        <span className="text-xs muted" style={{ fontWeight: 400 }}>
          {quote?.cycle === 'annual' ? ' / year' : ' / month'}
        </span>
      </div>
      <div className="text-xs muted" style={{ marginTop: 2 }}>
        {quote ? <>{quote.charged_bikes} bikes × {fmt(tier.per_bike_monthly)} each</> : null}
      </div>
      <div className="text-xs muted" style={{ marginTop: 8, lineHeight: 1.5 }}>{tier.includes}</div>
    </button>
  );
}

export default function Subscription() {
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState(null);
  const [cycle, setCycle] = useState('monthly');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/fleet/subscription');
      setState(data);
      setPicked((p) => p || data.tier || 'manage');
      setCycle(data.cycle || 'monthly');
    } catch {
      toast.error('Could not load your subscription');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Paystack sends the fleet back here with the reference it was given. The
  // card is only saved once we have verified the payment on our own account —
  // never on the strength of having been redirected.
  useEffect(() => {
    const ref = params.get('ref');
    if (!ref) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/fleet/subscription/confirm/${ref}`);
        if (cancelled) return;
        if (data.status === 'paid') toast.success('Subscription active — thank you');
        else toast.error(data.reason || 'That payment did not go through');
      } catch (e) {
        if (!cancelled) toast.error(e.response?.data?.error || 'Could not confirm that payment');
      } finally {
        if (!cancelled) {
          const next = new URLSearchParams(params);
          next.delete('ref');
          setParams(next, { replace: true });
          load();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [params, setParams, load]);

  const quoteFor = (tierKey) => state?.quotes?.find((q) => q.tier === tierKey && q.cycle === cycle)
    || state?.quotes?.find((q) => q.tier === tierKey);

  const subscribe = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/fleet/subscription/start', { tier: picked, cycle });
      window.location.href = data.authorization_url;
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not start the payment');
      setBusy(false);
    }
  };

  const changePlan = async () => {
    setBusy(true);
    try {
      await api.put('/fleet/subscription', { tier: picked, cycle });
      toast.success('Plan updated — it takes effect on your next charge');
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not change your plan');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await api.delete('/fleet/subscription');
      setConfirmCancel(false);
      toast.success('Subscription cancelled');
      load();
    } catch {
      toast.error('Could not cancel');
    }
  };

  if (loading) return <Loading />;

  const active = state.status === 'active';
  // A fleet whose charge failed is still a customer — it needs to retry, not
  // to be greeted as though it had never subscribed.
  const pastDue = state.status === 'past_due';
  const subscribed = active || pastDue;
  const chosen = quoteFor(picked);
  const bikes = chosen?.bikes ?? 0;
  const atMinimum = chosen?.at_minimum;

  return (
    <div>
      <h1>Your Pillion plan</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        Priced per bike, so what you pay follows the size of your fleet. Everything below is your own
        price at your own bike count.
      </p>

      <div className="card mt-3">
        <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}>
              {active ? <CheckCircle2 size={15} style={{ color: 'var(--success)' }} />
                : <AlertTriangle size={15} style={{ color: 'var(--warn)' }} />}
              {STATUS_LABEL[state.status] || state.status}
            </div>
            <div className="text-sm muted" style={{ marginTop: 3 }}>
              <Bike size={12} /> {bikes} billable {bikes === 1 ? 'bike' : 'bikes'}
              {state.next_billing_date && <> · next charge {fmtDate(state.next_billing_date)}</>}
            </div>
          </div>
          {state.card && (
            <div className="text-sm muted" style={{ textAlign: 'right' }}>
              <CreditCard size={12} /> {state.card.brand} ending {state.card.last4}
              {state.card.expiry && <div className="text-xs">expires {state.card.expiry}</div>}
            </div>
          )}
        </div>

        {state.failure_count > 0 && (
          <div className="text-sm" style={{ marginTop: 12, color: 'var(--danger)' }}>
            The last charge did not go through ({state.failure_count} {state.failure_count === 1 ? 'attempt' : 'attempts'}).
            Update your card below and we will try again.
          </div>
        )}
      </div>

      <div className="row mt-3" style={{ gap: 8 }}>
        {CYCLES.map((c) => (
          <button key={c.key} type="button"
            className={`btn btn-sm ${cycle === c.key ? '' : 'btn-secondary'}`}
            onClick={() => setCycle(c.key)}>
            {c.label}{c.note ? ` — ${c.note}` : ''}
          </button>
        ))}
      </div>

      <div className="grid grid-3 mt-2" style={{ gap: 12 }}>
        {state.tiers.map((t) => (
          <TierCard key={t.key} tier={t} quote={quoteFor(t.key)}
            selected={picked === t.key} current={state.tier === t.key} onPick={setPicked} />
        ))}
      </div>

      {atMinimum && (
        <div className="text-xs muted mt-2">
          Fleets under {state.minimum_bikes} bikes are billed as {state.minimum_bikes}. You have {bikes},
          so you are charged for {chosen.charged_bikes}.
        </div>
      )}

      <div className="card mt-3">
        <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>
              {chosen ? fmt(chosen.total) : '—'}
              <span className="text-sm muted" style={{ fontWeight: 400 }}>
                {cycle === 'annual' ? ' per year' : ' per month'}
              </span>
            </div>
            <div className="text-xs muted">{chosen?.description}</div>
          </div>
          {active ? (
            <button className="btn" onClick={changePlan} disabled={busy || (state.tier === picked && state.cycle === cycle)}>
              {busy ? 'Saving…' : 'Change plan'}
            </button>
          ) : (
            <button className="btn" onClick={subscribe} disabled={busy}>
              {busy ? <><Loader2 size={13} /> Opening Paystack…</>
                : pastDue ? 'Retry payment' : 'Subscribe and pay'}
            </button>
          )}
        </div>
        {!subscribed && (
          <div className="text-xs muted" style={{ marginTop: 10 }}>
            You pay the first {cycle === 'annual' ? 'year' : 'month'} now. We keep the card so later charges
            do not send you back here, and your bike count is counted fresh each time.
          </div>
        )}
        {pastDue && (
          <div className="text-xs muted" style={{ marginTop: 10 }}>
            This charges the outstanding amount and replaces the card we have on file.
          </div>
        )}
      </div>

      {state.invoices?.length > 0 && (
        <div className="card mt-3">
          <h3 style={{ marginTop: 0, fontSize: 15 }}>Invoices</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr><th>Date</th><th>For</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th></tr>
              </thead>
              <tbody>
                {state.invoices.map((inv) => (
                  <tr key={inv.reference}>
                    <td className="text-sm">{fmtDate(inv.charged_at || inv.created_at)}</td>
                    <td className="text-sm muted">{inv.description}</td>
                    <td className="text-sm" style={{ textAlign: 'right' }}>{fmt(inv.amount)}</td>
                    <td className="text-sm">
                      {inv.status === 'paid' ? <span style={{ color: 'var(--success)' }}>Paid</span>
                        : inv.status === 'failed' ? <span style={{ color: 'var(--danger)' }} title={inv.failure_reason}>Failed</span>
                        : <span className="muted">Pending</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subscribed && (
        <button className="btn btn-secondary mt-3" onClick={() => setConfirmCancel(true)}>
          Cancel subscription
        </button>
      )}

      {confirmCancel && (
        <ConfirmModal
          title="Cancel your subscription?"
          body="You keep access until the period you have paid for ends. Nothing further is charged after that."
          confirmLabel="Cancel subscription"
          danger
          onConfirm={cancel}
          onClose={() => setConfirmCancel(false)}
        />
      )}
    </div>
  );
}

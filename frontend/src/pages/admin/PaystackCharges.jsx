import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, Check, X } from 'lucide-react';
import api from '../../api';
import { Loading, Modal, fmt, fmtDateTime } from '../../components/ui';

const TABS = [
  ['unconfirmed', 'To review'],
  ['confirmed', 'Confirmed'],
  ['dismissed', 'Dismissed'],
];

const DISMISS_REASONS = [
  'Already entered as a manual payment',
  'Refunded to the rider',
  'Not an OnFleet rider payment',
];

const day = (value) => (value ? String(value).slice(0, 10) : '—');

// Debit-order charges Paystack collected that never reached a rider's account.
// The webhook used to drop these for platform riders; staff typed most of them
// in by hand. Confirming records the payment with its Paystack reference, so
// the same charge can't be credited twice.
export default function AdminPaystackCharges() {
  const [status, setStatus] = useState('unconfirmed');
  const [data, setData] = useState(null);
  const [credit, setCredit] = useState({});
  const [busy, setBusy] = useState(null);
  const [dismissing, setDismissing] = useState(null);
  const [reason, setReason] = useState(DISMISS_REASONS[0]);
  const [otherReason, setOtherReason] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get('/admin/paystack-charges', { params: { status } });
      setData(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load Paystack charges');
      setData({ charges: [], counts: {} });
    }
  }, [status]);

  useEffect(() => { setData(null); load(); }, [load]);

  const confirmCharge = async (charge) => {
    const amount = Number(credit[charge.id] ?? charge.suggested_credit);
    const match = charge.possible_existing_payment;
    if (match && !window.confirm(
      `${charge.rider_name} already has a ${match.method} payment of ${fmt(match.amount)} on ${day(match.paid_at)} (${match.reference}). `
      + 'If that was this charge typed in by hand, confirming will credit them twice.\n\nConfirm anyway?'
    )) return;
    setBusy(charge.id);
    try {
      await api.post(`/admin/paystack-charges/${charge.id}/confirm`, { agreement_id: charge.agreement_id, credited_amount: amount });
      toast.success(`${fmt(amount)} credited to ${charge.agreement_no}`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not confirm that charge');
    } finally {
      setBusy(null);
    }
  };

  const dismissCharge = async () => {
    const note = reason === 'other' ? otherReason.trim() : reason;
    if (!note) return toast.error('Say why this charge is being dismissed');
    setBusy(dismissing.id);
    try {
      await api.post(`/admin/paystack-charges/${dismissing.id}/dismiss`, { note });
      toast.success('Charge dismissed');
      setDismissing(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not dismiss that charge');
    } finally {
      setBusy(null);
    }
  };

  const counts = data?.counts || {};

  return (
    <>
      <div className="mb-3">
        <h1 className="page-title">Paystack charges</h1>
        <p className="page-sub">
          Debit orders Paystack collected that aren&rsquo;t recorded against a rider yet. Confirm each one to credit the
          agreement, or dismiss it if it was already entered by hand.
        </p>
      </div>

      <div className="row mb-3" style={{ gap: 8, flexWrap: 'wrap' }}>
        {TABS.map(([key, label]) => (
          <button key={key} className={`btn btn-sm ${status === key ? '' : 'btn-secondary'}`} onClick={() => setStatus(key)}>
            {label}{counts[key] ? ` (${counts[key].count})` : ''}
          </button>
        ))}
      </div>

      {!data ? <Loading /> : (
        <div className="card">
          {status === 'unconfirmed' && counts.unconfirmed?.count > 0 && (
            <div className="muted text-sm mb-3">
              {counts.unconfirmed.count} charge{counts.unconfirmed.count === 1 ? '' : 's'} totalling {fmt(counts.unconfirmed.amount)} waiting.
              Where a similar payment is already recorded for the rider, check it before confirming.
            </div>
          )}

          {!data.charges.length ? (
            <div className="muted text-sm">
              {status === 'unconfirmed' ? 'Nothing waiting — every Paystack charge is accounted for.' : 'None yet.'}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Charged</th>
                    <th>Rider</th>
                    <th>Amount</th>
                    {status === 'unconfirmed' && <th>Credit to agreement</th>}
                    <th>{status === 'unconfirmed' ? 'Check' : status === 'confirmed' ? 'Confirmed' : 'Reason'}</th>
                    {status === 'unconfirmed' && <th style={{ width: 170 }} />}
                  </tr>
                </thead>
                <tbody>
                  {data.charges.map((c) => (
                    <tr key={c.id}>
                      <td className="text-xs" style={{ whiteSpace: 'nowrap' }}>
                        {fmtDateTime(c.paid_at)}
                        {c.source === 'backfill' && <div className="muted">from before the queue</div>}
                      </td>
                      <td className="text-xs">
                        <div style={{ fontWeight: 600 }}>{c.rider_name || c.customer_email || 'Unknown customer'}</div>
                        {c.agreement_id
                          ? <Link to={`/admin/agreements/${c.agreement_id}`}>{c.agreement_no}</Link>
                          : <span style={{ color: 'var(--danger)' }}>No agreement found</span>}
                      </td>
                      <td className="text-xs" style={{ whiteSpace: 'nowrap' }} title={c.reference}>{fmt(c.amount)}</td>

                      {status === 'unconfirmed' && (
                        <td className="text-xs">
                          <input
                            type="number" step="0.01" min="0" max={c.amount}
                            value={credit[c.id] ?? c.suggested_credit}
                            onChange={(e) => setCredit((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            style={{ width: 110 }}
                          />
                          {Number(c.suggested_credit) < Number(c.amount) && (
                            <div className="muted">card fee {fmt(c.amount - c.suggested_credit)}</div>
                          )}
                        </td>
                      )}

                      <td className="text-xs" style={{ maxWidth: 280 }}>
                        {status === 'unconfirmed' && (c.possible_existing_payment ? (
                          <span style={{ color: 'var(--warn)', display: 'inline-flex', gap: 5, alignItems: 'flex-start' }}>
                            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                            <span>
                              Possibly already entered: {c.possible_existing_payment.method} {fmt(c.possible_existing_payment.amount)} on{' '}
                              {day(c.possible_existing_payment.paid_at)}
                            </span>
                          </span>
                        ) : <span className="muted">No similar payment recorded</span>)}
                        {status === 'confirmed' && <>{c.resolved_by_name || '—'} · {fmtDateTime(c.resolved_at)}</>}
                        {status === 'dismissed' && <>{c.resolution_note} <div className="muted">{c.resolved_by_name || '—'}</div></>}
                      </td>

                      {status === 'unconfirmed' && (
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button
                            className="btn btn-sm" disabled={busy === c.id || !c.agreement_id}
                            title={c.agreement_id ? 'Record this payment against the agreement' : 'No agreement to credit — dismiss it or fix the rider first'}
                            onClick={() => confirmCharge(c)}
                          >
                            <Check size={13} /> Confirm
                          </button>{' '}
                          <button className="btn btn-sm btn-secondary" disabled={busy === c.id}
                            onClick={() => { setDismissing(c); setReason(DISMISS_REASONS[0]); setOtherReason(''); }}>
                            <X size={13} /> Dismiss
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <Modal isOpen={!!dismissing} onClose={() => setDismissing(null)} title="Dismiss charge">
        {dismissing && (
          <div>
            <div className="text-sm mb-3">
              {fmt(dismissing.amount)} charged to {dismissing.rider_name || dismissing.customer_email} on {day(dismissing.paid_at)}.
              Nothing will be credited.
            </div>
            {[...DISMISS_REASONS, 'other'].map((r) => (
              <label key={r} className="text-sm" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <input type="radio" name="dismiss-reason" checked={reason === r} onChange={() => setReason(r)} />
                {r === 'other' ? 'Something else' : r}
              </label>
            ))}
            {reason === 'other' && (
              <input value={otherReason} onChange={(e) => setOtherReason(e.target.value)} placeholder="Why?" style={{ width: '100%', marginTop: 4 }} />
            )}
            <div className="row mt-3" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setDismissing(null)}>Cancel</button>
              <button className="btn" onClick={dismissCharge} disabled={busy === dismissing.id}>Dismiss charge</button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

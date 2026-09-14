import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { RefreshCw } from 'lucide-react';
import api from '../../api';
import { Loading, fmt } from '../../components/ui';

const day = (value) => (value ? String(value).slice(0, 10) : '—');

// The subscription that matches what the agreement actually bills, fee
// included or not. The one to keep is usually this one.
const matchesWeekly = (amount, weekly) => weekly > 0
  && (Math.abs(amount - weekly) <= 1 || Math.abs(amount - (weekly * 1.029 + 1)) <= 1);

// Riders with more than one Paystack subscription that can still charge them.
// Each new payment link created a new subscription and left the old ones
// running, so some riders were charged twice in a day. Nothing is cancelled
// unless someone presses the button.
export default function AdminPaystackSubscriptions() {
  const [data, setData] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  const load = async () => {
    setData(null);
    try {
      const res = await api.get('/admin/paystack-subscriptions/duplicates');
      setData(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not read subscriptions from Paystack');
      setData({ riders: [], riders_with_duplicates: 0 });
    }
  };

  useEffect(() => { load(); }, []);

  const cancel = async (rider, sub) => {
    const who = rider.rider_name || rider.email;
    if (!window.confirm(
      `Cancel ${sub.subscription_code} for ${who}?\n\n${fmt(sub.amount)} · ${sub.status}\n\n`
      + 'Paystack will stop charging this subscription. It cannot be restarted from here.'
    )) return;
    setCancelling(sub.subscription_code);
    try {
      await api.post(`/admin/paystack-subscriptions/${encodeURIComponent(sub.subscription_code)}/cancel`);
      toast.success(`Cancelled ${sub.subscription_code}`);
      setData((prev) => ({
        ...prev,
        riders: prev.riders
          .map((r) => (r.email === rider.email
            ? { ...r, subscriptions: r.subscriptions.filter((s) => s.subscription_code !== sub.subscription_code) }
            : r))
          .filter((r) => r.subscriptions.length > 1),
      }));
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not cancel that subscription');
    } finally {
      setCancelling(null);
    }
  };

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Paystack subscriptions</h1>
          <p className="page-sub">
            Riders with more than one subscription that can still charge them. &ldquo;Attention&rdquo; means Paystack is
            retrying a failed charge and will take it when the card has funds.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={!data}><RefreshCw size={14} /> Refresh</button>
      </div>

      {!data ? (
        <div className="card"><Loading /><div className="muted text-sm" style={{ textAlign: 'center' }}>Reading every subscription from Paystack…</div></div>
      ) : !data.riders.length ? (
        <div className="card muted text-sm">No rider has more than one live subscription.</div>
      ) : (
        <>
          <div className="muted text-sm mb-3">
            {data.riders.length} rider{data.riders.length === 1 ? '' : 's'} with duplicates. Keep the subscription that matches the
            agreement&rsquo;s weekly amount — it&rsquo;s marked — and cancel the rest.
          </div>
          {data.riders.map((rider) => (
            <div className="card mb-3" key={rider.email}>
              <div className="flex-between mb-2" style={{ gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{rider.rider_name || rider.email}</div>
                  <div className="muted text-xs">
                    {rider.agreement_no ? <>{rider.agreement_no} · {rider.agreement_status} · {fmt(rider.weekly_amount)}/week</> : 'No agreement found'}
                    {rider.agreement_id && <> · <Link to={`/admin/agreements/${rider.agreement_id}`}>open agreement</Link></>}
                  </div>
                </div>
                <div className="text-sm" style={{ color: 'var(--danger)', fontWeight: 600 }}>
                  {rider.subscriptions.length} live subscriptions
                </div>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Created</th><th>Status</th><th>Amount</th><th>Next charge</th><th>Code</th><th style={{ width: 110 }} /></tr></thead>
                  <tbody>
                    {rider.subscriptions.map((sub) => (
                      <tr key={sub.subscription_code}>
                        <td className="text-xs">{day(sub.created_at)}</td>
                        <td className="text-xs" style={{ color: sub.status === 'attention' ? 'var(--warn)' : undefined, fontWeight: 600 }}>{sub.status}</td>
                        <td className="text-xs">
                          {fmt(sub.amount)}
                          {matchesWeekly(sub.amount, rider.weekly_amount) && <span className="muted"> · matches agreement</span>}
                        </td>
                        <td className="text-xs">{day(sub.next_payment_date)}</td>
                        <td className="text-xs muted">{sub.subscription_code}</td>
                        <td>
                          <button className="btn btn-sm btn-secondary" disabled={cancelling === sub.subscription_code}
                            onClick={() => cancel(rider, sub)}>
                            {cancelling === sub.subscription_code ? 'Cancelling…' : 'Cancel'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

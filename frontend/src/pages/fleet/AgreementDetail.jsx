import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { Loading, Badge, Modal, fmt, fmtDate, fmtDateTime } from '../../components/ui';
import { useAuth } from '../../auth';
import { canManageFleetSection } from './access';

function FleetContractBtn({ agreementId }) {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    setBusy(true);
    try {
      const { data } = await api.get(`/fleet/agreements/${agreementId}/fleet-contract`);
      window.open(data.url, '_blank');
    } catch (e) {
      toast.error(e?.message || 'Could not generate contract');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-sm btn-secondary" onClick={handle} disabled={busy}>
      {busy ? 'Generating…' : 'Rent-to-Own Contract'}
    </button>
  );
}

const creditedAmount = (payment) => Number(payment?.net_amount || payment?.amount || 0);
const feeAmount = (payment) => Number(payment?.fee_amount || 0);
const grossAmount = (payment) => Number(payment?.amount || 0);

function Stat({ label, value, accent }) {
  return (
    <div className="stat" style={{ borderTop: `3px solid ${accent || 'var(--accent)'}` }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-sm btn-secondary"
      onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

export default function FleetAgreementDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'agreements');

  const [data, setData] = useState(null);
  const [showPay, setShowPay] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'eft', reference: '', notes: '' });
  const [busyAction, setBusyAction] = useState('');
  const PAY_LINK_AMOUNTS = [600, 650, 700, 850];
  const [subAmount, setSubAmount] = useState('600');
  const [subLink, setSubLink] = useState(null);
  const [showBalanceEdit, setShowBalanceEdit] = useState(false);
  const [newBalance, setNewBalance] = useState('');
  const [riderPortalLink, setRiderPortalLink] = useState(null);

  const load = () => api.get(`/fleet/agreements/${id}`).then((response) => {
    setData(response.data);
    setPay((current) => ({ ...current, amount: response.data.agreement.weekly_amount }));
  });

  useEffect(() => { load(); }, [id]);
  if (!data) return <Loading />;

  const { agreement, schedule, payments, summary } = data;
  const isDiscontinued = agreement.status === 'discontinued';
  const totalReceived = payments.filter((p) => p.status === 'success').reduce((sum, p) => sum + creditedAmount(p), 0);
  const remaining = Math.max(0, +(agreement.total_amount - totalReceived).toFixed(2));
  const canReinstate = isDiscontinued && agreement.discontinued_reason === 'bike_stolen';
  const bikeStillStolen = agreement.bike_status === 'stolen';

  const recordPayment = async () => {
    try {
      await api.post('/fleet/payments/manual', { agreement_id: Number(id), ...pay, amount: Number(pay.amount) });
      toast.success('Payment recorded');
      setShowPay(false);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed');
    }
  };

  const updateStatus = async (status) => {
    if (!window.confirm(`Change status to ${status}?`)) return;
    try {
      setBusyAction(status);
      await api.post(`/fleet/agreements/${id}/status`, { status });
      toast.success('Status updated');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update agreement status');
    } finally {
      setBusyAction('');
    }
  };

  const generatePayLink = async () => {
    try {
      setBusyAction('pay_link');
      const body = subAmount ? { plan_amount: Number(subAmount) } : {};
      const response = await api.post(`/fleet/agreements/${id}/payment-link`, body);
      setSubLink(response.data);
      toast.success(`Payment link sent to ${response.data.rider_email}`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not generate payment link');
    } finally {
      setBusyAction('');
    }
  };

  const reinstate = async () => {
    if (!window.confirm('Reinstate this discontinued contract and resume future payments from today onward?')) return;
    try {
      setBusyAction('reinstate');
      await api.post(`/fleet/agreements/${id}/reinstate`);
      toast.success('Agreement reinstated');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not reinstate this agreement');
    } finally {
      setBusyAction('');
    }
  };

  const editBalance = async () => {
    const val = parseFloat(String(newBalance).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(val) || val < 0) return toast.error('Enter a valid balance amount (0 or greater)');
    try {
      setBusyAction('balance');
      await api.patch(`/fleet/agreements/${id}/remaining-balance`, { remaining_balance: val });
      toast.success('Balance updated');
      setShowBalanceEdit(false);
      setNewBalance('');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update balance');
    } finally {
      setBusyAction('');
    }
  };

  return (
    <>
      <Link to="/fleet/app/agreements" className="muted text-sm">← Back</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">{agreement.agreement_no}</h1>
          <div className="muted">
            {agreement.full_name} · {agreement.make} {agreement.model}
            {agreement.bike_registration && ` · ${agreement.bike_registration}`}
          </div>
        </div>
        <Badge status={agreement.status} />
      </div>

      {isDiscontinued && (
        <div className="card mb-4" style={{ border: '1px solid var(--danger)', background: 'rgba(239,68,68,0.08)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--danger)' }}>Agreement discontinued</div>
          <div className="muted text-sm" style={{ marginBottom: 12 }}>
            This contract was discontinued because the bike was marked stolen. No further payment is required while the agreement stays discontinued.
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="badge badge-muted">Bike status: {agreement.bike_status || '—'}</div>
            {agreement.discontinued_at && <div className="badge badge-muted">Stopped {fmtDateTime(agreement.discontinued_at)}</div>}
            {agreement.reinstated_at && <div className="badge badge-muted">Previously reinstated {fmtDateTime(agreement.reinstated_at)}</div>}
          </div>
          {canReinstate && canManage && (
            <div className="row mt-3" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={reinstate} disabled={busyAction === 'reinstate' || bikeStillStolen}>
                {busyAction === 'reinstate' ? 'Reinstating…' : 'Reinstate contract'}
              </button>
              {bikeStillStolen && (
                <div className="muted text-sm">Recover the bike from stolen status first, then reinstate the contract.</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-4 mb-4">
        <Stat label="Total contract" value={fmt(agreement.total_amount)} />
        <Stat label="Received" value={fmt(totalReceived)} accent="var(--success)" />
        <div style={{ position: 'relative' }}>
          <Stat label="Remaining" value={fmt(remaining)} accent="var(--accent)" />
          {!isDiscontinued && canManage && (
            <button
              className="btn btn-sm btn-secondary"
              style={{ position: 'absolute', top: 8, right: 8, fontSize: 11, padding: '2px 8px' }}
              onClick={() => { setNewBalance(remaining ?? ''); setShowBalanceEdit(true); }}
            >Edit</button>
          )}
        </div>
        <Stat label="Overdue" value={fmt(summary.overdue)} accent="var(--danger)" />
      </div>

      <div className="card mb-4">
        <div className="flex-between mb-3" style={{ gap: 16, flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Progress to ownership · {summary.progress_pct}%</h3>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {canManage && !isDiscontinued && (
              <button className="btn btn-sm" onClick={() => setShowPay(true)}>+ Record manual payment</button>
            )}
            {agreement.contract_file_path && (
              <a className="btn btn-sm btn-secondary" href={agreement.contract_file_path} target="_blank" rel="noreferrer">Contract</a>
            )}
            {agreement.signed_contract_path && (
              <a className="btn btn-sm btn-secondary" href={agreement.signed_contract_path} target="_blank" rel="noreferrer">Signed copy</a>
            )}
            <FleetContractBtn agreementId={agreement.id} />
            {canManage && agreement.status === 'active' && (
              <button className="btn btn-sm btn-secondary" onClick={() => updateStatus('paused')} disabled={busyAction === 'paused'}>Pause</button>
            )}
            {canManage && agreement.status === 'paused' && (
              <button className="btn btn-sm btn-secondary" onClick={() => updateStatus('active')} disabled={busyAction === 'active'}>Resume</button>
            )}
            {canManage && agreement.status === 'active' && (
              <button className="btn btn-sm btn-danger" onClick={() => updateStatus('defaulted')} disabled={busyAction === 'defaulted'}>Default</button>
            )}
            {canManage && !['completed', 'cancelled', 'discontinued'].includes(agreement.status) && (
              <button className="btn btn-sm btn-success" onClick={() => updateStatus('completed')} disabled={busyAction === 'completed'}>Mark completed</button>
            )}
            {canManage && !['completed', 'cancelled', 'discontinued'].includes(agreement.status) && (
              <button className="btn btn-sm btn-secondary" onClick={() => updateStatus('cancelled')} disabled={busyAction === 'cancelled'}>Mark cancelled</button>
            )}
            {canManage && !['completed', 'cancelled', 'discontinued'].includes(agreement.status) && (
              <button className="btn btn-sm btn-danger" onClick={() => updateStatus('discontinued')} disabled={busyAction === 'discontinued'}>Discontinue</button>
            )}
            {canManage && canReinstate && (
              <button className="btn btn-sm" onClick={reinstate} disabled={busyAction === 'reinstate' || bikeStillStolen}>
                {busyAction === 'reinstate' ? 'Reinstating…' : 'Reinstate'}
              </button>
            )}
          </div>
        </div>

        <div className="progress-bar"><div className="progress-fill" style={{ width: `${summary.progress_pct}%` }} /></div>
        <div className="flex-between mt-3 text-sm muted">
          <div>Start {fmtDate(agreement.start_date)}</div>
          <div>{summary.weeks_paid} / {summary.weeks_total} weeks</div>
          <div>End {fmtDate(agreement.end_date)}</div>
        </div>
      </div>

      {canManage && (
        <div className="card mb-4">
          <h3 className="mb-3">Payment link</h3>
          <p className="muted text-sm mb-3">
            Generate a secure Paystack payment link and send it to the driver automatically. The link is also emailed to {agreement.rider_email || 'the driver'}.
          </p>
          <div className="field mb-3">
            <label className="label">Weekly payment amount</label>
            <div className="row" style={{ gap: 8 }}>
              {PAY_LINK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => { setSubAmount(String(amt)); setSubLink(null); }}
                  className={String(subAmount) === String(amt) ? 'btn btn-sm' : 'btn btn-sm btn-secondary'}
                  style={{ minWidth: 70 }}
                >
                  R{amt}
                </button>
              ))}
            </div>
          </div>
          <button className="btn btn-sm" onClick={generatePayLink} disabled={busyAction === 'pay_link'}>
            {busyAction === 'pay_link' ? 'Generating…' : 'Generate & send to driver'}
          </button>
          {subLink && (
            <div className="mt-3">
              <div
                style={{ marginBottom: 12, padding: '10px 14px', background: 'rgba(34,197,94,0.08)', borderRadius: 8, border: '1px solid rgba(34,197,94,0.3)' }}
              >
                <div className="text-sm" style={{ fontWeight: 600, marginBottom: 4, color: 'var(--success, #22c55e)' }}>
                  Link sent to {subLink.rider_email}
                </div>
                <div className="text-xs muted">
                  {subLink.is_subscription ? 'Recurring weekly card payment' : 'One-time card payment'} · R{Number(subLink.weekly_amount).toFixed(2)}/week · {subLink.rider_name}
                </div>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input readOnly value={subLink.authorization_url} style={{ flex: 1, minWidth: 200, fontSize: 12 }} onClick={(e) => e.target.select()} />
                <CopyBtn text={subLink.authorization_url} />
                <a className="btn btn-sm btn-secondary" href={subLink.authorization_url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <ExternalLink size={13} /> Open
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card mb-4">
        <div className="flex-between mb-2">
          <div>
            <h3 style={{ margin: 0 }}>Rider portal link</h3>
            <p className="muted text-sm mt-1">Share this read-only link with the rider so they can view their agreement, schedule, and payment history — no login required.</p>
          </div>
        </div>
        {!riderPortalLink ? (
          <button
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              try {
                setBusyAction('portal_link');
                const { data } = await api.get(`/fleet/agreements/${id}/rider-portal-token`);
                setRiderPortalLink(`${window.location.origin}${data.path}`);
              } catch {
                toast.error('Could not generate portal link');
              } finally {
                setBusyAction('');
              }
            }}
            disabled={busyAction === 'portal_link'}
          >
            {busyAction === 'portal_link' ? 'Generating…' : 'Generate rider portal link'}
          </button>
        ) : (
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input readOnly value={riderPortalLink} style={{ flex: 1, minWidth: 220, fontSize: 12 }} onClick={(e) => e.target.select()} />
            <CopyBtn text={riderPortalLink} />
            <a className="btn btn-sm btn-secondary" href={riderPortalLink} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ExternalLink size={13} /> Preview
            </a>
          </div>
        )}
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Payment schedule</h3>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr><th>#</th><th>Due</th><th>Paid</th><th>Status</th></tr>
              </thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.id}>
                    <td>{row.week_number}</td>
                    <td>{fmtDate(row.due_date)}</td>
                    <td>{fmt(row.amount_paid)} / {fmt(row.amount_due)}</td>
                    <td><Badge status={row.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3 className="mb-3">Payment history</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Method</th><th>Ref</th><th>Status</th><th>Rental</th><th>Fee</th><th>Gross</th></tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{fmtDateTime(payment.paid_at || payment.created_at)}</td>
                    <td>{payment.method}</td>
                    <td className="text-xs muted">{payment.reference}</td>
                    <td><Badge status={payment.status} /></td>
                    <td><strong>{fmt(creditedAmount(payment))}</strong></td>
                    <td>{feeAmount(payment) > 0 ? fmt(feeAmount(payment)) : '—'}</td>
                    <td>{fmt(grossAmount(payment))}</td>
                  </tr>
                ))}
                {!payments.length && (
                  <tr><td colSpan={7} className="muted text-sm" style={{ textAlign: 'center', padding: 16 }}>No payments recorded yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showPay && (
        <Modal title="Record manual payment" onClose={() => setShowPay(false)}>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">Amount</label>
              <input type="number" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">Method</label>
              <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                <option value="eft">EFT</option>
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label className="label">Reference</label>
            <input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
          </div>
          <div className="field">
            <label className="label">Notes</label>
            <textarea rows={3} value={pay.notes} onChange={(e) => setPay({ ...pay, notes: e.target.value })} />
          </div>
          <div className="row">
            <button className="btn" onClick={recordPayment}>Record</button>
            <button className="btn btn-secondary" onClick={() => setShowPay(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {showBalanceEdit && (
        <Modal title="Edit outstanding balance" onClose={() => { setShowBalanceEdit(false); setNewBalance(''); }}>
          <p className="muted text-sm mb-3">
            Sets the new remaining balance. The total contract value is adjusted to <strong>amount paid so far + new remaining</strong>, and the unpaid schedule rows are re-scaled proportionally.
          </p>
          <div className="field">
            <label className="label">New remaining balance (ZAR)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={newBalance}
              onChange={(e) => setNewBalance(e.target.value)}
              placeholder={fmt(remaining)}
              autoFocus
            />
          </div>
          <div className="muted text-sm mb-3">
            Current: {fmt(remaining)} · Paid: {fmt(totalReceived)} · New total: {fmt((totalReceived || 0) + (parseFloat(newBalance) || 0))}
          </div>
          <div className="row">
            <button className="btn" onClick={editBalance} disabled={busyAction === 'balance'}>
              {busyAction === 'balance' ? 'Saving…' : 'Save balance'}
            </button>
            <button className="btn btn-secondary" onClick={() => { setShowBalanceEdit(false); setNewBalance(''); }}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

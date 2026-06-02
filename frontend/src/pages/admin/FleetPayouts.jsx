import { useEffect, useState, useCallback } from 'react';
import { PiggyBank, CheckCircle2, XCircle, Clock, RefreshCw, Banknote } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api';
import { Badge, Loading, fmt, fmtDate } from '../../components/ui';

const STATUS_BADGE = { pending: 'pending', approved: 'active', paid: 'active', rejected: 'cancelled' };
const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', paid: 'Paid out', rejected: 'Rejected' };

function ProcessModal({ request, onClose, onDone }) {
  const [action, setAction] = useState('paid');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/fleet-payouts/${request.id}/process`, { action, admin_notes: notes });
      toast.success(`Payout request ${action === 'paid' ? 'marked as paid' : action === 'approve' ? 'approved' : 'rejected'}`);
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not process request');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ maxWidth: 480, width: '100%' }}>
        <div className="flex-between" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: 0 }}>Process Payout #{request.id}</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 16, fontSize: 13 }}>
          <div><strong>{request.org_name}</strong></div>
          <div className="muted">Requested by: {request.requested_by_name} · {fmtDate(request.created_at)}</div>
          <div style={{ marginTop: 8 }}>
            <span>Amount: <strong>{fmt(request.amount_requested)}</strong></span>
            <span className="muted" style={{ marginLeft: 12 }}>Fee: {fmt(request.withdrawal_fee)}</span>
            <span style={{ marginLeft: 12 }}>Net to pay: <strong>{fmt(request.net_payout)}</strong></span>
          </div>
        </div>

        <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 16, fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Bank details</div>
          <div>{request.bank_account_name}</div>
          <div className="muted">{request.bank_name}</div>
          <div className="muted">Account: {request.bank_account_number}</div>
          {request.bank_branch_code && <div className="muted">Branch: {request.bank_branch_code}</div>}
        </div>

        <div className="field" style={{ marginBottom: 16 }}>
          <label className="label">Action *</label>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="paid">Mark as Paid (transfer complete)</option>
            <option value="approve">Approve (payment pending)</option>
            <option value="reject">Reject (refund wallet)</option>
          </select>
        </div>

        <div className="field" style={{ marginBottom: 20 }}>
          <label className="label">Admin notes</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes for the fleet owner" />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className={`btn${action === 'reject' ? ' btn-secondary' : ''}`}
            onClick={submit}
            disabled={busy}
            style={action === 'reject' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}}
          >
            {busy ? 'Processing…' : action === 'paid' ? 'Mark as Paid' : action === 'approve' ? 'Approve' : 'Reject & Refund'}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function AdminFleetPayouts() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('pending');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/fleet-payouts');
      setRequests(data.requests || []);
    } catch (e) {
      toast.error('Could not load payout requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = filter === 'all' ? requests : requests.filter((r) => r.status === filter);
  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  if (loading) return <Loading />;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <PiggyBank size={22} /> Fleet Payout Requests
          {pendingCount > 0 && (
            <span className="badge" style={{ background: 'var(--danger)', color: '#fff', fontSize: 12 }}>{pendingCount}</span>
          )}
        </h2>
        <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={14} /></button>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[['pending', 'Pending'], ['approved', 'Approved'], ['paid', 'Paid'], ['rejected', 'Rejected'], ['all', 'All']].map(([key, label]) => (
          <button
            key={key}
            className={`btn btn-sm ${filter === key ? '' : 'btn-secondary'}`}
            onClick={() => setFilter(key)}
          >
            {label}
            {key === 'pending' && pendingCount > 0 && ` (${pendingCount})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '32px 0' }}>
          <div className="muted">No {filter !== 'all' ? filter : ''} payout requests.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {filtered.map((req) => (
            <div key={req.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 16 }}>#{req.id}</span>
                    <span style={{ fontWeight: 600 }}>{req.org_name}</span>
                    <Badge status={STATUS_BADGE[req.status] || 'pending'}>{STATUS_LABEL[req.status] || req.status}</Badge>
                  </div>
                  <div className="text-sm muted" style={{ marginBottom: 8 }}>
                    Requested by {req.requested_by_name} · {fmtDate(req.created_at)}
                    {req.processed_at && ` · Processed ${fmtDate(req.processed_at)}`}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 10 }}>
                    <div>
                      <div className="text-xs muted">Amount requested</div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{fmt(req.amount_requested)}</div>
                    </div>
                    <div>
                      <div className="text-xs muted">Withdrawal fee (0.5%)</div>
                      <div style={{ fontWeight: 600 }}>{fmt(req.withdrawal_fee)}</div>
                    </div>
                    <div>
                      <div className="text-xs muted">Net to transfer</div>
                      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--primary-light)' }}>{fmt(req.net_payout)}</div>
                    </div>
                  </div>

                  <div className="card" style={{ background: 'var(--surface-2)', fontSize: 12, padding: '8px 12px' }}>
                    <Banknote size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
                    <strong>{req.bank_account_name}</strong>
                    {' · '}{req.bank_name}
                    {' · '}Account: {req.bank_account_number}
                    {req.bank_branch_code && ` · Branch: ${req.bank_branch_code}`}
                  </div>

                  {req.admin_notes && (
                    <div className="text-xs muted" style={{ marginTop: 8 }}>Note: {req.admin_notes}</div>
                  )}
                </div>

                {(req.status === 'pending' || req.status === 'approved') && (
                  <button className="btn btn-sm" onClick={() => setSelected(req)} style={{ flexShrink: 0 }}>
                    Process
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <ProcessModal
          request={selected}
          onClose={() => setSelected(null)}
          onDone={() => { setSelected(null); load(); }}
        />
      )}
    </div>
  );
}

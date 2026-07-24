import { useEffect, useState, useCallback } from 'react';
import { PiggyBank, ArrowDownCircle, Clock, CheckCircle2, XCircle, AlertTriangle, Banknote, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api';
import { Badge, Loading, fmt, fmtDate } from '../../components/ui';
import { canManageFleetSection } from './access';
import { useAuth } from '../../auth';

const TX_TYPE_LABEL = { credit: 'Payment received', withdrawal: 'Payout requested', withdrawal_fee: 'Withdrawal fee' };
const TX_TYPE_BADGE = { credit: 'active', withdrawal: 'pending', withdrawal_fee: 'overdue' };
const PAYOUT_STATUS_BADGE = { pending: 'pending', approved: 'active', paid: 'active', rejected: 'cancelled' };
const PAYOUT_STATUS_LABEL = { pending: 'Pending', approved: 'Approved', paid: 'Paid', rejected: 'Rejected' };

const SA_BANKS = [
  'ABSA', 'Capitec Bank', 'FNB (First National Bank)', 'Nedbank', 'Standard Bank',
  'African Bank', 'Bidvest Bank', 'Discovery Bank', 'Investec', 'Old Mutual Bank',
  'SA Post Bank (PostBank)', 'TymeBank', 'Other'
];

function BankDetailsForm({ initial, onSave, saving }) {
  const [form, setForm] = useState({
    bank_account_name: initial?.bank_account_name || '',
    bank_name: initial?.bank_name || '',
    bank_account_number: initial?.bank_account_number || '',
    bank_branch_code: initial?.bank_branch_code || ''
  });

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="field">
        <label className="label">Account holder name *</label>
        <input value={form.bank_account_name} onChange={set('bank_account_name')} placeholder="e.g. Speedy Riders (Pty) Ltd" />
      </div>
      <div className="field">
        <label className="label">Bank *</label>
        <select value={form.bank_name} onChange={set('bank_name')}>
          <option value="">Select bank…</option>
          {SA_BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label">Account number *</label>
        <input value={form.bank_account_number} onChange={set('bank_account_number')} placeholder="e.g. 62012345678" inputMode="numeric" />
      </div>
      <div className="field">
        <label className="label">Branch code</label>
        <input value={form.bank_branch_code} onChange={set('bank_branch_code')} placeholder="e.g. 632005 (universal branch)" inputMode="numeric" />
      </div>
      <button
        className="btn"
        disabled={saving || !form.bank_account_name || !form.bank_name || !form.bank_account_number}
        onClick={() => onSave(form)}
      >
        {saving ? 'Saving…' : 'Save bank details'}
      </button>
    </div>
  );
}

function PayoutModal({ wallet, bankDetails, onClose, onSuccess }) {
  const [amount, setAmount] = useState('');
  const [overrideBankDetails, setOverrideBankDetails] = useState(false);
  const [form, setForm] = useState({
    bank_account_name: bankDetails?.bank_account_name || '',
    bank_name: bankDetails?.bank_name || '',
    bank_account_number: bankDetails?.bank_account_number || '',
    bank_branch_code: bankDetails?.bank_branch_code || ''
  });
  const [busy, setBusy] = useState(false);

  const hasSavedBankDetails = bankDetails?.bank_account_name && bankDetails?.bank_name && bankDetails?.bank_account_number;
  const balance = Number(wallet?.balance || 0);
  const parsedAmount = Number(amount);
  const withdrawalFee = parsedAmount > 0 ? +(parsedAmount * 0.005).toFixed(2) : 0;
  const netPayout = parsedAmount > 0 ? +(parsedAmount - withdrawalFee).toFixed(2) : 0;

  const setField = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const submit = async () => {
    if (!parsedAmount || parsedAmount <= 0) return toast.error('Enter a valid amount');
    if (parsedAmount > balance) return toast.error('Amount exceeds wallet balance');
    const bankToUse = overrideBankDetails || !hasSavedBankDetails ? form : bankDetails;
    if (!bankToUse.bank_account_name || !bankToUse.bank_name || !bankToUse.bank_account_number) {
      return toast.error('Bank account details are required');
    }
    setBusy(true);
    try {
      await api.post('/fleet/wallet/payout', { amount: parsedAmount, ...bankToUse });
      toast.success('Payout request submitted! Admin will process within 1-2 business days.');
      onSuccess();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not submit payout request');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="flex-between" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: 0 }}>Request Payout</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 20 }}>
          <div className="text-sm muted">Available balance</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--primary-light)', fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(balance)}</div>
          <div className="text-xs muted" style={{ marginTop: 4 }}>0.5% withdrawal fee applies</div>
        </div>

        <div className="field" style={{ marginBottom: 16 }}>
          <label className="label">Amount to withdraw (ZAR) *</label>
          <input
            type="number"
            min="1"
            step="0.01"
            max={balance}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Max ${fmt(balance)}`}
          />
          {parsedAmount > 0 && (
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              Fee: {fmt(withdrawalFee)} · You receive: <strong>{fmt(netPayout)}</strong>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <div className="text-sm" style={{ fontWeight: 600, marginBottom: 8 }}>Bank account</div>
          {hasSavedBankDetails && !overrideBankDetails ? (
            <div className="card" style={{ background: 'var(--surface-2)', fontSize: 13 }}>
              <div><strong>{bankDetails.bank_account_name}</strong></div>
              <div className="muted">{bankDetails.bank_name} · {bankDetails.bank_account_number}</div>
              {bankDetails.bank_branch_code && <div className="muted">Branch: {bankDetails.bank_branch_code}</div>}
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setOverrideBankDetails(true)}>
                Use different account
              </button>
            </div>
          ) : (
            <>
              <div className="field"><label className="label">Account holder name *</label><input value={form.bank_account_name} onChange={setField('bank_account_name')} /></div>
              <div className="field"><label className="label">Bank *</label>
                <select value={form.bank_name} onChange={setField('bank_name')}>
                  <option value="">Select bank…</option>
                  {SA_BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div className="field"><label className="label">Account number *</label><input value={form.bank_account_number} onChange={setField('bank_account_number')} inputMode="numeric" /></div>
              <div className="field"><label className="label">Branch code</label><input value={form.bank_branch_code} onChange={setField('bank_branch_code')} inputMode="numeric" /></div>
            </>
          )}
        </div>

        <div className="card" style={{ background: 'rgba(239,68,68,0.06)', marginBottom: 16, fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <AlertTriangle size={14} style={{ color: 'var(--danger)', marginTop: 2, flexShrink: 0 }} />
            <span>Your payout request will be sent to an OnFleet admin. Funds are transferred manually and may take 1–2 business days.</span>
          </div>
        </div>

        <button className="btn" onClick={submit} disabled={busy || !parsedAmount || parsedAmount <= 0 || parsedAmount > balance} style={{ width: '100%' }}>
          {busy ? 'Submitting…' : `Request ${parsedAmount > 0 ? fmt(parsedAmount) : ''} Payout`}
        </button>
      </div>
    </div>
  );
}

export default function FleetWallet() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [bankDetails, setBankDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showPayout, setShowPayout] = useState(false);
  const [showBankForm, setShowBankForm] = useState(false);
  const [savingBank, setSavingBank] = useState(false);

  const canManage = canManageFleetSection(user?.role, 'wallet');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [walletRes, bankRes] = await Promise.all([
        api.get('/fleet/wallet'),
        api.get('/fleet/bank-details')
      ]);
      setData(walletRes.data);
      setBankDetails(bankRes.data);
    } catch (e) {
      toast.error('Could not load wallet data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveBank = async (form) => {
    setSavingBank(true);
    try {
      await api.put('/fleet/bank-details', form);
      setBankDetails(form);
      toast.success('Bank details saved');
      setShowBankForm(false);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save bank details');
    } finally {
      setSavingBank(false);
    }
  };

  if (loading) return <Loading />;

  const wallet = data?.wallet || { balance: 0, total_collected: 0, total_withdrawn: 0 };
  const transactions = data?.transactions || [];
  const payoutRequests = data?.payout_requests || [];
  const hasBankDetails = bankDetails?.bank_account_name && bankDetails?.bank_name && bankDetails?.bank_account_number;

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <PiggyBank size={22} /> Fleet Wallet
        </h2>
        <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={14} /></button>
      </div>

      {/* Balance cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ borderColor: 'rgba(30,136,209,0.4)', background: 'rgba(30,136,209,0.05)' }}>
          <div className="text-sm muted">Available balance</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--primary-light)', fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(wallet.balance)}</div>
        </div>
        <div className="card">
          <div className="text-sm muted">Total collected</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(wallet.total_collected)}</div>
        </div>
        <div className="card">
          <div className="text-sm muted">Total withdrawn</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(wallet.total_withdrawn)}</div>
        </div>
      </div>

      {/* Actions */}
      {canManage && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
          <button
            className="btn"
            onClick={() => setShowPayout(true)}
            disabled={Number(wallet.balance) <= 0}
          >
            <ArrowDownCircle size={15} /> Request Payout
          </button>
          <button className="btn btn-secondary" onClick={() => setShowBankForm(!showBankForm)}>
            <Banknote size={15} /> {hasBankDetails ? 'Update Bank Details' : 'Add Bank Details'}
          </button>
        </div>
      )}

      {/* Bank details form */}
      {showBankForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h4 style={{ margin: '0 0 16px' }}>Bank Account Details</h4>
          <div className="text-sm muted" style={{ marginBottom: 16 }}>
            These details will be used for payout requests. OnFleet admin transfers funds manually to this account.
          </div>
          <BankDetailsForm initial={bankDetails} onSave={saveBank} saving={savingBank} />
        </div>
      )}

      {/* Saved bank details summary */}
      {hasBankDetails && !showBankForm && (
        <div className="card" style={{ marginBottom: 24, background: 'var(--surface-2)' }}>
          <div className="flex-between">
            <div>
              <div className="text-sm muted">Payout account</div>
              <div style={{ fontWeight: 600, marginTop: 2 }}>{bankDetails.bank_account_name}</div>
              <div className="text-sm muted">{bankDetails.bank_name} · {bankDetails.bank_account_number}{bankDetails.bank_branch_code ? ` · ${bankDetails.bank_branch_code}` : ''}</div>
            </div>
            {canManage && (
              <button className="btn btn-secondary btn-sm" onClick={() => setShowBankForm(true)}>Edit</button>
            )}
          </div>
        </div>
      )}

      {/* Fee info */}
      <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 24, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Fee structure</div>
        <div className="muted">Collection fee: 3.5% + R1.00 deducted per weekly rider payment before crediting your wallet.</div>
        <div className="muted">Withdrawal fee: 0.5% deducted when you withdraw from your wallet.</div>
      </div>

      {/* Payout requests */}
      {payoutRequests.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h4 style={{ margin: '0 0 16px' }}>Payout Requests</h4>
          <div style={{ display: 'grid', gap: 10 }}>
            {payoutRequests.map((pr) => (
              <div key={pr.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Request #{pr.id} · {fmt(pr.amount_requested)}</div>
                  <div className="text-xs muted">
                    Fee: {fmt(pr.withdrawal_fee)} · Net: {fmt(pr.net_payout)} · {fmtDate(pr.created_at)}
                  </div>
                  {pr.admin_notes && <div className="text-xs muted" style={{ marginTop: 2 }}>Note: {pr.admin_notes}</div>}
                </div>
                <Badge status={PAYOUT_STATUS_BADGE[pr.status] || 'pending'}>{PAYOUT_STATUS_LABEL[pr.status] || pr.status}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transaction history */}
      <div className="card">
        <h4 style={{ margin: '0 0 16px' }}>Transaction History</h4>
        {transactions.length === 0 ? (
          <div className="muted text-sm" style={{ textAlign: 'center', padding: '24px 0' }}>
            No transactions yet. Rider subscription payments will appear here.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 0 }}>
            {transactions.map((tx) => (
              <div key={tx.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  {tx.type === 'credit'
                    ? <CheckCircle2 size={16} style={{ color: 'var(--success)', marginTop: 2, flexShrink: 0 }} />
                    : <ArrowDownCircle size={16} style={{ color: 'var(--muted)', marginTop: 2, flexShrink: 0 }} />}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{TX_TYPE_LABEL[tx.type] || tx.type}</div>
                    {tx.rider_name && <div className="text-xs muted">{tx.rider_name}</div>}
                    <div className="text-xs muted">{fmtDate(tx.created_at)}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 600, color: tx.type === 'credit' ? 'var(--success)' : 'var(--text)' }}>
                    {tx.type === 'credit' ? '+' : '-'}{fmt(Math.abs(tx.net_amount))}
                  </div>
                  {tx.type === 'credit' && tx.fee_amount > 0 && (
                    <div className="text-xs muted">Fee: {fmt(tx.fee_amount)}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showPayout && (
        <PayoutModal
          wallet={wallet}
          bankDetails={bankDetails}
          onClose={() => setShowPayout(false)}
          onSuccess={() => { setShowPayout(false); load(); }}
        />
      )}
    </div>
  );
}

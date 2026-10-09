import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Landmark, AlertTriangle, ShieldCheck, History } from 'lucide-react';
import api from '../../api';
import { Loading, fmtDateTime } from '../../components/ui';

const FIELDS = [
  { key: 'eft_account_name', label: 'Account name', placeholder: 'SV Capital (Pty) Ltd',
    hint: 'Exactly as the bank has it, so a payment is not returned for a name mismatch.' },
  { key: 'eft_bank_name', label: 'Bank', placeholder: 'FNB' },
  { key: 'eft_account_number', label: 'Account number', placeholder: '62012345678' },
  { key: 'eft_branch_code', label: 'Branch code', placeholder: '250655' },
];

export default function BillingSettings() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get('/admin/billing-settings')
    .then((r) => { setData(r.data); setForm(r.data.settings); })
    .catch((e) => toast.error(e.response?.data?.error || 'Could not load billing settings')), []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const { data: body } = await api.put('/admin/billing-settings', form);
      toast.success(body.complete
        ? 'Banking details saved — they appear on every EFT invoice from now on'
        : 'Banking details cleared');
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save those details');
    } finally { setBusy(false); }
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await api.put('/admin/billing-settings', Object.fromEntries(FIELDS.map((f) => [f.key, ''])));
      toast.success('Banking details cleared — invoices will ask clients to request them');
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not clear those details');
    } finally { setBusy(false); }
  };

  if (!data) return <Loading />;

  const dirty = FIELDS.some((f) => (form[f.key] || '') !== (data.settings[f.key] || ''));
  const needed = data.eft_organizations > 0;

  return (
    <>
      <h1 className="page-title">Banking details</h1>
      <p className="page-sub">
        The account printed on every invoice sent to a client who pays by EFT.
      </p>

      {/* Blank details are fine until somebody is actually being invoiced,
          at which point they are the difference between an invoice that can
          be paid and one that cannot. */}
      {needed && !data.complete && (
        <div className="row mb-4" style={{
          gap: 8, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 8,
          border: '1px solid var(--danger)', background: 'rgba(229,57,53,0.08)', fontSize: 13,
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>{data.eft_organizations} {data.eft_organizations === 1 ? 'client pays' : 'clients pay'} by EFT and there are no banking details here.</strong>{' '}
            Their invoices currently say to reply for the details — which gets ignored, and
            delays money you are owed. An invoice with some details and a missing account
            number is worse still, so it is all four or none.
          </div>
        </div>
      )}

      {!needed && (
        <div className="muted text-sm mb-4">
          No client is set to pay by EFT yet. Filling this in now means the first one you
          switch over gets a complete invoice.
        </div>
      )}

      <div className="card" style={{ maxWidth: 620 }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Landmark size={16} color="var(--accent)" /> Where clients send money
          {data.complete && (
            <span className="text-xs" style={{ color: 'var(--success)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ShieldCheck size={12} /> On invoices
            </span>
          )}
        </h3>
        <div className="muted text-xs mb-4">
          Each invoice also carries its own reference, which is what the payment is matched
          against — clients are asked to use it.
        </div>

        {FIELDS.map((f) => (
          <div key={f.key} className="mb-3">
            <label className="label">{f.label}</label>
            <input
              className="input"
              value={form[f.key] || ''}
              placeholder={f.placeholder}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
            {f.hint && <div className="muted text-xs mt-1">{f.hint}</div>}
          </div>
        ))}

        <div className="row mt-4" style={{ gap: 8, flexWrap: 'wrap' }}>
          {/* "Saved" on a form that has never been filled in is a lie the
              first time somebody opens this page. */}
          <button className="btn" disabled={busy || !dirty} onClick={save}>
            {dirty || !data.complete ? 'Save banking details' : 'Saved'}
          </button>
          {data.complete && (
            <button className="btn btn-secondary" disabled={busy} onClick={clearAll}>Clear</button>
          )}
          {dirty && (
            <button className="btn btn-secondary" disabled={busy} onClick={() => setForm(data.settings)}>
              Discard changes
            </button>
          )}
        </div>
      </div>

      {/* Who changed the account money is sent to, and when. An attacker who
          reaches an admin session and edits this quietly redirects every
          invoice from then on; a name and a date is what makes that a short
          conversation rather than a long one. */}
      <div className="muted text-sm mt-3" style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: 620 }}>
        <History size={13} />
        {data.last_changed
          ? <>Last changed by {data.last_changed.by || 'a deleted user'} on {fmtDateTime(data.last_changed.at)}. Every change is recorded in Audit Logs with the previous values.</>
          : <>Never changed from here. Every change is recorded in Audit Logs with the previous values.</>}
      </div>
    </>
  );
}

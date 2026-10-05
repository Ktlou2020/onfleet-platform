import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Layers, Plus, RefreshCw, Banknote, TrendingDown, AlertTriangle,
  X, KeyRound, Copy, Check, ChevronRight, Webhook,
} from 'lucide-react';
import api from '../../api';
import { Loading, Modal, EmptyState, SearchInput, fmt, fmtDate, matchesSearch } from '../../components/ui';

// A pool's health in one word, decided by how much of what fell due actually
// came in. The bands match the collections team's own escalation points, so
// the colour here and the queue they work from say the same thing.
const rateAccent = (pct) => (pct == null ? 'var(--muted)'
  : pct >= 90 ? 'var(--success)' : pct >= 75 ? 'var(--warn)' : 'var(--danger)');

const AGE_LABELS = {
  days_1_30: '1–30 days',
  days_31_60: '31–60 days',
  days_61_90: '61–90 days',
  days_90_plus: '90+ days',
};

function Figure({ label, value, sub, accent }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={accent ? { color: accent } : undefined}>{value}</div>
      {sub && <div className="muted text-xs mt-1">{sub}</div>}
    </div>
  );
}

function SecretReveal({ value, onDone }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { toast.error('Could not copy — select and copy manually'); }
  };
  return (
    <div style={{ minWidth: 380, maxWidth: 560 }}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start', marginBottom: 12 }}>
        <AlertTriangle size={18} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 2 }} />
        <div className="text-sm">
          Copy this now — it is shown once and cannot be retrieved again. Send it to the
          funder over a channel you would send a password over, not by email.
        </div>
      </div>
      <div className="card" style={{ background: 'var(--surface-2)', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12 }}>
        {value}
      </div>
      <div className="row mt-3" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-secondary btn-sm" onClick={copy}>
          {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
        </button>
        <button className="btn btn-sm" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function PoolDetail({ poolId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [available, setAvailable] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get(`/admin/pools/${poolId}`).then((r) => setData(r.data))
    .catch((e) => toast.error(e.response?.data?.error || 'Could not load that pool')), [poolId]);

  useEffect(() => { load(); }, [load]);

  const openPicker = async () => {
    try {
      const { data: body } = await api.get('/admin/pools-unassigned-bikes');
      setAvailable(body.bikes);
      setPicked(new Set());
      setSearch('');
      setAdding(true);
    } catch (e) { toast.error(e.response?.data?.error || 'Could not load bikes'); }
  };

  const addBikes = async () => {
    if (!picked.size) return;
    setBusy(true);
    try {
      const { data: body } = await api.post(`/admin/pools/${poolId}/bikes`, { bike_ids: [...picked] });
      toast.success(`${body.added} bike${body.added === 1 ? '' : 's'} added${body.reassigned ? ` (${body.reassigned} moved from another pool)` : ''}`);
      setAdding(false);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not add those bikes');
    } finally { setBusy(false); }
  };

  const removeBike = async (bikeId, registration) => {
    try {
      await api.delete(`/admin/pools/${poolId}/bikes/${bikeId}`);
      toast.success(`${registration} removed from the pool`);
      await load();
      onChanged?.();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not remove that bike'); }
  };

  if (!data) return <Modal onClose={onClose} title="Pool"><Loading /></Modal>;

  const { pool, summary, bikes } = data;
  const visible = available.filter((b) => matchesSearch(search, b.registration, b.vin, b.make, b.model));

  return (
    <Modal onClose={onClose} title={`${pool.name}${pool.reference ? ` · ${pool.reference}` : ''}`} style={{ maxWidth: 1040 }}>
      <div className="muted text-sm mb-3">
        Funded by {pool.funder}
        {pool.advanced_on && <> · advanced {fmtDate(pool.advanced_on)}</>}
        {pool.organization && <> · {pool.organization.name}</>}
      </div>

      <div className="grid grid-4 mb-3">
        <Figure label="Capital advanced" value={summary.capital_advanced == null ? '—' : fmt(summary.capital_advanced)}
          sub={summary.capital_recovery_pct == null ? 'Not recorded' : `${summary.capital_recovery_pct}% recovered`} />
        <Figure label="Collected (net)" value={fmt(summary.collected_net)}
          sub={`${fmt(summary.collected_gross)} gross · ${fmt(summary.processing_fees)} fees`} accent="var(--success)" />
        <Figure label="Still outstanding" value={fmt(summary.outstanding)}
          sub={summary.paid_off_pct == null ? '—' : `${summary.paid_off_pct}% of contract paid off`} />
        <Figure label="Collection rate" value={summary.collection_rate_pct == null ? '—' : `${summary.collection_rate_pct}%`}
          sub={`${fmt(summary.collected_against_billed)} of ${fmt(summary.billed_to_date)} due`}
          accent={rateAccent(summary.collection_rate_pct)} />
      </div>

      {/* A pool can honestly show money collected and a collection rate of
          zero, because a payment is cash in and an allocation is that cash
          applied to a week. Saying which is which beats leaving two numbers
          to contradict each other on the screen. */}
      {summary.unallocated_cash > 0 && (
        <div className="row mb-3" style={{
          gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8,
          border: '1px solid var(--warn)', background: 'rgba(255,182,39,0.08)', fontSize: 13,
        }}>
          <AlertTriangle size={15} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>{fmt(summary.unallocated_cash)} received but not applied to a week.</strong>{' '}
            Either riders have paid ahead, or receipts have not been reconciled against the
            schedule. Until they are, the collection rate above understates this pool.
          </div>
        </div>
      )}

      <div className="grid grid-4 mb-4">
        <Figure label="Bikes" value={summary.bikes} sub={`${summary.bikes_earning} on an active agreement`} />
        <Figure label="Arrears" value={fmt(summary.arrears_total)}
          sub={Object.entries(AGE_LABELS).map(([k, l]) => `${l}: ${fmt(summary.arrears_by_age[k])}`).join(' · ')}
          accent={summary.arrears_total > 0 ? 'var(--warn)' : undefined} />
        <Figure label="Capital at risk" value={fmt(summary.capital_at_risk)}
          sub="Outstanding on stolen or written-off bikes"
          accent={summary.capital_at_risk > 0 ? 'var(--danger)' : undefined} />
        <Figure label="Weeks paid" value={`${summary.weeks_paid} / ${summary.weeks_contracted}`}
          sub={summary.last_payment_at ? `Last payment ${fmtDate(summary.last_payment_at)}` : 'No payments yet'} />
      </div>

      <div className="flex-between mb-2">
        <h3 style={{ fontSize: 15 }}>Bikes in this pool</h3>
        <button className="btn btn-sm" onClick={openPicker}><Plus size={13} /> Add bikes</button>
      </div>

      {bikes.length === 0 ? (
        <EmptyState title="No bikes in this pool yet"
          sub="A pool with no bikes has nothing to collect. Add the bikes this tranche paid for." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Bike</th><th>Status</th><th>Agreement</th>
                <th style={{ textAlign: 'right' }}>Contracted</th>
                <th style={{ textAlign: 'right' }}>Collected</th>
                <th style={{ textAlign: 'right' }}>Outstanding</th>
                <th style={{ textAlign: 'right' }}>Arrears</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bikes.map((b) => (
                <tr key={b.bike_id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{b.registration}</div>
                    <div className="muted text-xs">{[b.make, b.model].filter(Boolean).join(' ')}</div>
                  </td>
                  <td className="text-sm">{b.bike_status}</td>
                  <td className="text-sm">
                    {b.current_agreement
                      ? <>{b.current_agreement.agreement_no}<div className="muted text-xs">{b.weeks_paid}/{b.weeks_contracted} weeks</div></>
                      : <span className="muted">No active agreement</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(b.contracted_total)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(b.collected_gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(b.outstanding)}</td>
                  <td style={{ textAlign: 'right', color: b.arrears_total > 0 ? 'var(--warn)' : undefined }}>
                    {fmt(b.arrears_total)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm btn-secondary" title="Remove from pool"
                      onClick={() => removeBike(b.bike_id, b.registration)}><X size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <Modal onClose={() => !busy && setAdding(false)} title="Add bikes to this pool" style={{ maxWidth: 720 }}>
          <div className="muted text-sm mb-2">
            Only bikes that are not already in a pool are listed. To move a bike off another
            funder&apos;s pool, remove it there first — the change is recorded either way.
          </div>
          <SearchInput value={search} onChange={setSearch} placeholder="Registration, VIN, make or model" />
          <div className="table-wrap mt-3" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th /><th>Registration</th><th>Bike</th><th>Status</th><th>Fleet</th></tr></thead>
              <tbody>
                {visible.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <input type="checkbox" checked={picked.has(b.id)} onChange={() => setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(b.id)) next.delete(b.id); else next.add(b.id);
                        return next;
                      })} />
                    </td>
                    <td>{b.registration}</td>
                    <td className="text-sm">{[b.make, b.model].filter(Boolean).join(' ')}</td>
                    <td className="text-sm">{b.status}</td>
                    <td className="muted text-sm">{b.organization_name || 'Platform'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!visible.length && <div className="muted text-sm mt-2">No unassigned bikes match that.</div>}
          <div className="row mt-3" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" disabled={busy || !picked.size} onClick={addBikes}>
              Add {picked.size || ''} bike{picked.size === 1 ? '' : 's'}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

export default function BikePools() {
  const [pools, setPools] = useState(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [openPool, setOpenPool] = useState(null);
  const [form, setForm] = useState({ name: '', funder: 'SV Capital', reference: '', capital_advanced: '', advanced_on: '' });
  const [busy, setBusy] = useState(false);
  const [keyFor, setKeyFor] = useState(null);
  const [issuedKey, setIssuedKey] = useState(null);
  const [hookFor, setHookFor] = useState(null);
  const [hookUrl, setHookUrl] = useState('');
  const [issuedSecret, setIssuedSecret] = useState(null);

  const load = useCallback(() => api.get('/admin/pools').then((r) => setPools(r.data.pools))
    .catch((e) => toast.error(e.response?.data?.error || 'Could not load pools')), []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name.trim()) return toast.error('Give the pool a name');
    if (!form.funder.trim()) return toast.error('Who advanced the money?');
    setBusy(true);
    try {
      await api.post('/admin/pools', form);
      toast.success('Pool created');
      setCreating(false);
      setForm({ name: '', funder: 'SV Capital', reference: '', capital_advanced: '', advanced_on: '' });
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not create that pool');
    } finally { setBusy(false); }
  };

  const issueKey = async (pool) => {
    setBusy(true);
    try {
      const { data } = await api.post('/admin/integrations/api-keys', {
        name: `${pool.funder} — ${pool.name}`, scope: 'funder', pool_ids: [pool.id],
      });
      setIssuedKey(data.key);
      setKeyFor(null);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not issue that key');
    } finally { setBusy(false); }
  };

  const registerHook = async (pool) => {
    const url = hookUrl.trim();
    if (!url) return toast.error('Where should events be sent?');
    setBusy(true);
    try {
      const { data } = await api.post('/admin/integrations/webhooks', {
        name: `${pool.funder} — ${pool.name}`, url, scope: 'funder', pool_ids: [pool.id],
      });
      setIssuedSecret(data.secret);
      setHookFor(null);
      setHookUrl('');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not register that endpoint');
    } finally { setBusy(false); }
  };

  const visible = useMemo(() => (pools || []).filter(
    (p) => matchesSearch(search, p.name, p.reference, p.funder)), [pools, search]);

  if (!pools) return <Loading />;

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Bike pools</h1>
          <p className="page-sub">
            Bikes financed as a tranche, and what each tranche has paid back. A funder reads
            their own pools through the API; nothing here shares a rider&apos;s details.
          </p>
        </div>
        <button className="btn" onClick={() => setCreating(true)}><Plus size={14} /> New pool</button>
      </div>

      <div className="row mb-4" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, reference or funder"
          style={{ flex: '1 1 320px', maxWidth: 420 }} />
        <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={12} /> Refresh</button>
      </div>

      {!visible.length ? (
        <EmptyState
          title={pools.length ? 'No pools match that' : 'No bike pools yet'}
          sub={pools.length ? undefined : 'A pool groups the bikes one funder paid for, so what they are owed can be read off directly instead of assembled from a spreadsheet.'}
          action={!pools.length && <button className="btn" onClick={() => setCreating(true)}>Create the first pool</button>}
        />
      ) : visible.map((p) => (
        <div className="card mb-3" key={p.id}>
          <div className="flex-between" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Layers size={16} color="var(--accent)" /> {p.name}
                {p.reference && <span className="muted text-sm">· {p.reference}</span>}
                {p.status === 'closed' && <span className="badge">Closed</span>}
              </h3>
              <div className="muted text-sm">
                <Banknote size={12} style={{ verticalAlign: -2 }} /> {p.funder}
                {p.advanced_on && <> · advanced {fmtDate(p.advanced_on)}</>}
                {' · '}{p.summary.bikes} bike{p.summary.bikes === 1 ? '' : 's'}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn-sm btn-secondary" onClick={() => setKeyFor(p)}>
                <KeyRound size={12} /> Issue API key
              </button>
              <button className="btn btn-sm btn-secondary" onClick={() => { setHookUrl(''); setHookFor(p); }}>
                <Webhook size={12} /> Push updates
              </button>
              <button className="btn btn-sm" onClick={() => setOpenPool(p.id)}>
                Open <ChevronRight size={12} />
              </button>
            </div>
          </div>

          <div className="grid grid-4 mt-3">
            <Figure label="Capital advanced" value={p.summary.capital_advanced == null ? '—' : fmt(p.summary.capital_advanced)}
              sub={p.summary.capital_recovery_pct == null ? 'Not recorded' : `${p.summary.capital_recovery_pct}% recovered`} />
            <Figure label="Collected (net)" value={fmt(p.summary.collected_net)}
              sub={`${fmt(p.summary.collected_gross)} gross`} accent="var(--success)" />
            <Figure label="Outstanding" value={fmt(p.summary.outstanding)}
              sub={p.summary.paid_off_pct == null ? '—' : `${p.summary.paid_off_pct}% paid off`} />
            <Figure label="Collection rate" value={p.summary.collection_rate_pct == null ? '—' : `${p.summary.collection_rate_pct}%`}
              sub={p.summary.arrears_total > 0 ? `${fmt(p.summary.arrears_total)} in arrears` : 'No arrears'}
              accent={rateAccent(p.summary.collection_rate_pct)} />
          </div>

          {p.summary.capital_at_risk > 0 && (
            <div className="row mt-3" style={{ gap: 8, alignItems: 'center', color: 'var(--danger)', fontSize: 13 }}>
              <TrendingDown size={14} />
              {fmt(p.summary.capital_at_risk)} outstanding on bikes that are stolen or written off — not
              money that is merely late.
            </div>
          )}
        </div>
      ))}

      {creating && (
        <Modal onClose={() => !busy && setCreating(false)} title="New bike pool">
          <div style={{ minWidth: 380 }}>
            <label className="label">Pool name</label>
            <input className="input mb-3" value={form.name} placeholder="Tranche 3 — Soweto delivery"
              onChange={(e) => setForm({ ...form, name: e.target.value })} />

            <label className="label">Funder</label>
            <input className="input mb-3" value={form.funder}
              onChange={(e) => setForm({ ...form, funder: e.target.value })} />

            <label className="label">Funder&apos;s reference</label>
            <input className="input mb-1" value={form.reference} placeholder="SVC-2026-03"
              onChange={(e) => setForm({ ...form, reference: e.target.value })} />
            <div className="muted text-xs mb-3">
              What they call this tranche. They will quote it back long before they quote our id.
            </div>

            <label className="label">Capital advanced</label>
            <input className="input mb-1" type="number" value={form.capital_advanced} placeholder="500000"
              onChange={(e) => setForm({ ...form, capital_advanced: e.target.value })} />
            <div className="muted text-xs mb-3">
              What was actually wired — not what the bikes cost us. The two differ, and a funder
              reconciling their own books needs their number.
            </div>

            <label className="label">Advanced on</label>
            <input className="input mb-3" type="date" value={form.advanced_on}
              onChange={(e) => setForm({ ...form, advanced_on: e.target.value })} />

            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-secondary" disabled={busy} onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn" disabled={busy} onClick={create}>Create pool</button>
            </div>
          </div>
        </Modal>
      )}

      {keyFor && (
        <Modal onClose={() => !busy && setKeyFor(null)} title={`API key for ${keyFor.funder}`}>
          <div style={{ minWidth: 380, maxWidth: 520 }}>
            <p className="text-sm mb-3">
              This issues a key that can read <strong>{keyFor.name}</strong> and nothing else — not
              other pools, not vehicles, not riders, not alarms. It cannot change anything.
            </p>
            <p className="muted text-sm mb-3">
              No rider name or phone number appears in any response it can reach.
            </p>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-secondary" disabled={busy} onClick={() => setKeyFor(null)}>Cancel</button>
              <button className="btn" disabled={busy} onClick={() => issueKey(keyFor)}>
                <KeyRound size={14} /> Issue key
              </button>
            </div>
          </div>
        </Modal>
      )}

      {issuedKey && (
        <Modal onClose={() => setIssuedKey(null)} title="Funder API key">
          <SecretReveal value={issuedKey} onDone={() => setIssuedKey(null)} />
        </Modal>
      )}

      {hookFor && (
        <Modal onClose={() => !busy && setHookFor(null)} title={`Push updates to ${hookFor.funder}`}>
          <div style={{ minWidth: 400, maxWidth: 540 }}>
            <p className="text-sm mb-3">
              We POST to this URL as things happen on <strong>{hookFor.name}</strong>, signed so the
              receiver can prove it came from us. Failed deliveries retry for about six hours.
            </p>
            <ul className="text-sm muted mb-3" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
              <li><code>pool.payment_received</code> — a rider paid, with the fee broken out</li>
              <li><code>pool.composition_changed</code> — bikes moved into or out of the tranche</li>
              <li><code>pool.daily_summary</code> — the whole position, 06:00 SAST</li>
            </ul>
            <label className="label">Endpoint URL</label>
            <input className="input mb-1" value={hookUrl} placeholder="https://svcapital.co.za/hooks/onfleet"
              onChange={(e) => setHookUrl(e.target.value)} />
            <div className="muted text-xs mb-3">
              HTTPS only. This endpoint receives money and never an alarm, so no rider name or
              phone number is sent to it.
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-secondary" disabled={busy} onClick={() => setHookFor(null)}>Cancel</button>
              <button className="btn" disabled={busy} onClick={() => registerHook(hookFor)}>
                <Webhook size={14} /> Register endpoint
              </button>
            </div>
          </div>
        </Modal>
      )}

      {issuedSecret && (
        <Modal onClose={() => setIssuedSecret(null)} title="Signing secret">
          <SecretReveal value={issuedSecret} onDone={() => setIssuedSecret(null)} />
        </Modal>
      )}

      {openPool && (
        <PoolDetail poolId={openPool} onClose={() => setOpenPool(null)} onChanged={load} />
      )}
    </>
  );
}

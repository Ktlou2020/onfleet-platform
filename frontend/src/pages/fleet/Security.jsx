import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { useAuth } from '../../auth';
import { Badge, EmptyState, Loading, Modal, fmt, fmtDate, fmtDateTime } from '../../components/ui';
import { canManageFleetSection } from './access';
import { Siren, ShieldAlert, Plus } from 'lucide-react';

// Theft cases and insurance claims for this fleet's bikes.
//
// Both scope through bikes, which is the only thing either is attached to.
//
// The fleet works these itself. Most theft cases open on their own off a
// tamper or a towing alert, but the worst ones do not — a bike taken while
// parked with the tracker ripped out sends nothing at all — so reporting one
// by hand is the first thing here. Closing a case and recording what the
// insurer said are the other two, and both are the fleet's to do: they hold
// the police reference and they get the insurer's letter.

const THEFT_TONE = { open: 'danger', with_police: 'warning', recovered: 'success', false_alarm: '', written_off: 'danger' };
const CLAIM_TONE = { filed: 'info', investigating: 'warning', approved: 'success', paid: 'success', rejected: 'danger', closed: '' };

const OPEN_STATUSES = [
  { value: 'open', label: 'Still open' },
  { value: 'with_police', label: 'With the police' },
];
const CLOSING_STATUSES = [
  { value: 'recovered', label: 'Recovered' },
  { value: 'false_alarm', label: 'False alarm' },
  { value: 'written_off', label: 'Gone for good' },
];
const CLAIM_TYPES = ['theft', 'damage', 'accident', 'fire', 'other'];
const CLAIM_STATUSES = ['filed', 'investigating', 'approved', 'rejected', 'paid', 'closed'];
const PAYOUT_STATUSES = ['approved', 'paid'];

const isClosed = (c) => !!c.closed_at;
const sastToday = () => new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);

function Field({ label, hint, children }) {
  return (
    <label className="field" style={{ display: 'block' }}>
      <span className="label">{label}{hint && <span className="muted"> {hint}</span>}</span>
      {children}
    </label>
  );
}

function BikePicker({ bikes, value, onChange }) {
  return (
    <Field label="Bike">
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }}>
        <option value="">— Which bike —</option>
        {bikes.map((b) => (
          <option key={b.id} value={b.id}>
            {b.registration || `Bike #${b.id}`} · {[b.make, b.model].filter(Boolean).join(' ')}
          </option>
        ))}
      </select>
    </Field>
  );
}

export default function FleetSecurity() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'security');

  const [theft, setTheft] = useState([]);
  const [claims, setClaims] = useState([]);
  const [bikes, setBikes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [reporting, setReporting] = useState(null);      // { bike_id, reason }
  const [openCase, setOpenCase] = useState(null);        // { case, events }
  const [caseForm, setCaseForm] = useState({ status: '', police_reference: '', note: '' });
  const [newNote, setNewNote] = useState('');
  const [filing, setFiling] = useState(null);            // new claim draft
  const [outcome, setOutcome] = useState(null);          // { claim, status, payout_amount, notes }

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        api.get('/fleet/theft-cases'),
        api.get('/fleet/claims'),
      ]);
      setTheft(t.data.theft_cases || []);
      setClaims(c.data.claims || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load theft and claims');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Only needed to report or file, and only by somebody who may.
  useEffect(() => {
    if (!canManage) return;
    api.get('/fleet/bikes').then((r) => setBikes(r.data.bikes || [])).catch(() => setBikes([]));
  }, [canManage]);

  const openCases = useMemo(() => theft.filter((c) => !isClosed(c)).length, [theft]);

  const showCase = async (id) => {
    try {
      const { data } = await api.get(`/fleet/theft-cases/${id}`);
      setOpenCase(data);
      setCaseForm({ status: data.case.status, police_reference: data.case.police_reference || '', note: '' });
      setNewNote('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not open that case');
    }
  };

  const reportTheft = async () => {
    if (!reporting?.bike_id) return toast.error('Which bike?');
    if (String(reporting.reason || '').trim().length < 3) return toast.error('Say what happened');
    setBusy(true);
    try {
      const { data } = await api.post('/fleet/theft-cases', {
        bike_id: Number(reporting.bike_id), reason: reporting.reason,
      });
      toast.success(data.created ? 'Case opened' : 'Added to the case already open on that bike');
      setReporting(null);
      await load();
      await showCase(data.case.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not open that case');
    } finally {
      setBusy(false);
    }
  };

  const saveCase = async () => {
    setBusy(true);
    try {
      await api.put(`/fleet/theft-cases/${openCase.case.id}/status`, {
        status: caseForm.status,
        police_reference: caseForm.police_reference || undefined,
        note: caseForm.note || undefined,
      });
      toast.success('Case updated');
      await load();
      await showCase(openCase.case.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update that case');
    } finally {
      setBusy(false);
    }
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    setBusy(true);
    try {
      await api.post(`/fleet/theft-cases/${openCase.case.id}/notes`, { note: newNote });
      setNewNote('');
      await showCase(openCase.case.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not add that note');
    } finally {
      setBusy(false);
    }
  };

  const fileClaim = async () => {
    if (!filing?.bike_id) return toast.error('Which bike?');
    if (String(filing.description || '').trim().length < 3) return toast.error('Say what happened');
    setBusy(true);
    try {
      await api.post('/fleet/claims', { ...filing, bike_id: Number(filing.bike_id) });
      toast.success('Claim filed');
      setFiling(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not file that claim');
    } finally {
      setBusy(false);
    }
  };

  const saveOutcome = async () => {
    setBusy(true);
    try {
      await api.put(`/fleet/claims/${outcome.claim.id}`, {
        status: outcome.status,
        payout_amount: PAYOUT_STATUSES.includes(outcome.status) && outcome.payout_amount !== ''
          ? Number(outcome.payout_amount) : undefined,
        notes: outcome.notes || undefined,
      });
      toast.success('Claim updated');
      setOutcome(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update that claim');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <>
      <h1>Theft &amp; claims</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Cases opened on your bikes, and the claims that followed.
        {openCases > 0 && <> <strong>{openCases} still open.</strong></>}
      </p>

      <div className="flex-between" style={{ marginTop: 22, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Siren size={18} /> Theft cases
        </h2>
        {canManage && (
          <button className="btn btn-sm" onClick={() => setReporting({ bike_id: '', reason: '' })}>
            <Plus size={14} /> Report a theft
          </button>
        )}
      </div>

      {theft.length === 0 ? (
        <EmptyState title="No theft cases"
                    sub="A case opens itself when a bike is tampered with or towed — or report one here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr>
              <th>Bike</th><th>Status</th><th>Opened</th><th>Police ref</th><th>Closed</th>
              <th style={{ textAlign: 'right' }}></th>
            </tr></thead>
            <tbody>
              {theft.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.registration}</strong><div className="text-xs muted">{c.make} {c.model}</div></td>
                  <td><Badge status={THEFT_TONE[c.status] || ''}>{String(c.status).replace(/_/g, ' ')}</Badge></td>
                  <td>{fmtDate(c.opened_at)}<div className="text-xs muted">{c.opened_reason}</div></td>
                  <td>{c.police_reference || '—'}</td>
                  <td>{c.closed_at ? fmtDate(c.closed_at) : '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className={isClosed(c) ? 'btn btn-secondary btn-sm' : 'btn btn-sm'}
                            onClick={() => showCase(c.id)}>
                      {isClosed(c) ? 'Open file' : 'Work the case'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex-between" style={{ marginTop: 26, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldAlert size={18} /> Insurance claims
        </h2>
        {canManage && (
          <button className="btn btn-sm" onClick={() => setFiling({
            bike_id: '', claim_type: 'theft', description: '', incident_date: sastToday(),
            saps_case_number: '', saps_police_station: '',
          })}>
            <Plus size={14} /> File a claim
          </button>
        )}
      </div>

      {claims.length === 0 ? (
        <EmptyState title="No claims" sub="Claims raised against your bikes will appear here." />
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr>
              <th>Bike</th><th>Type</th><th>What happened</th><th>Status</th><th>Payout</th>
              <th style={{ textAlign: 'right' }}></th>
            </tr></thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.registration}</strong><div className="text-xs muted">{c.make} {c.model}</div></td>
                  <td>{c.claim_type}</td>
                  <td style={{ maxWidth: 300 }}>
                    {c.description}
                    {c.saps_case_number && <div className="text-xs muted">SAPS {c.saps_case_number}</div>}
                  </td>
                  <td>
                    <Badge status={CLAIM_TONE[c.status] ?? ''}>{String(c.status).replace(/_/g, ' ')}</Badge>
                    {c.resolved_at && <div className="text-xs muted">{fmtDate(c.resolved_at)}</div>}
                  </td>
                  <td>{c.payout_amount != null ? fmt(c.payout_amount) : '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canManage && c.status !== 'closed' && (
                      <button className="btn btn-sm" onClick={() => setOutcome({
                        claim: c,
                        status: c.status,
                        payout_amount: c.payout_amount != null ? String(c.payout_amount) : '',
                        notes: c.notes || '',
                      })}>Record outcome</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reporting && (
        <Modal title="Report a theft" onClose={() => setReporting(null)}>
          <p className="muted text-sm" style={{ marginTop: 0 }}>
            For a bike taken without the tracker noticing. If a case is already open on
            this bike, this joins it rather than starting a second one.
          </p>
          <BikePicker bikes={bikes} value={reporting.bike_id}
                      onChange={(v) => setReporting((r) => ({ ...r, bike_id: v }))} />
          <Field label="What happened">
            <textarea rows="3" style={{ width: '100%' }} value={reporting.reason}
                      placeholder="Taken from outside the depot overnight"
                      onChange={(e) => setReporting((r) => ({ ...r, reason: e.target.value }))} />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn btn-secondary" onClick={() => setReporting(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={reportTheft}>
              {busy ? 'Opening…' : 'Open the case'}
            </button>
          </div>
        </Modal>
      )}

      {openCase && (
        <Modal title={`Case #${openCase.case.id}`} onClose={() => setOpenCase(null)} style={{ maxWidth: 620 }}>
          <p className="muted text-sm" style={{ marginTop: 0 }}>
            Opened {fmtDateTime(openCase.case.opened_at)} — {openCase.case.opened_reason}
          </p>

          {canManage && !isClosed(openCase.case) ? (
            <>
              <Field label="Where it stands">
                <select value={caseForm.status} style={{ width: '100%' }}
                        onChange={(e) => setCaseForm((f) => ({ ...f, status: e.target.value }))}>
                  <optgroup label="Still running">
                    {OPEN_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </optgroup>
                  <optgroup label="Closes the case">
                    {CLOSING_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </optgroup>
                </select>
              </Field>
              <Field label="Police reference" hint="(optional)">
                <input value={caseForm.police_reference} placeholder="CAS 114/09/2026" style={{ width: '100%' }}
                       onChange={(e) => setCaseForm((f) => ({ ...f, police_reference: e.target.value }))} />
              </Field>
              {CLOSING_STATUSES.some((s) => s.value === caseForm.status) && (
                <Field label="Closing note" hint="— what actually happened">
                  <textarea rows="2" style={{ width: '100%' }} value={caseForm.note}
                            placeholder="Found in Katlehong, rider unhurt"
                            onChange={(e) => setCaseForm((f) => ({ ...f, note: e.target.value }))} />
                </Field>
              )}
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginBottom: 6 }}>
                <button className="btn btn-sm" disabled={busy} onClick={saveCase}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm">
              Closed {fmtDateTime(openCase.case.closed_at)} as{' '}
              <strong>{String(openCase.case.status).replace(/_/g, ' ')}</strong>
              {openCase.case.closing_note ? ` — ${openCase.case.closing_note}` : ''}
            </p>
          )}

          <h3 style={{ marginTop: 18, marginBottom: 8 }}>The story so far</h3>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {openCase.events.map((e) => (
              <div key={e.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <div className="text-sm">{e.summary}</div>
                <div className="text-xs muted">
                  {fmtDateTime(e.created_at)}{e.actor_name ? ` · ${e.actor_name}` : ' · automatic'}
                </div>
              </div>
            ))}
          </div>

          {canManage && !isClosed(openCase.case) && (
            <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
              <input style={{ flex: 1 }} value={newNote} placeholder="Add what you have just found out"
                     onChange={(e) => setNewNote(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} />
              <button className="btn btn-secondary btn-sm" disabled={busy || !newNote.trim()} onClick={addNote}>Add</button>
            </div>
          )}
        </Modal>
      )}

      {filing && (
        <Modal title="File a claim" onClose={() => setFiling(null)} style={{ maxWidth: 560 }}>
          <BikePicker bikes={bikes} value={filing.bike_id}
                      onChange={(v) => setFiling((f) => ({ ...f, bike_id: v }))} />
          <div className="grid grid-2">
            <Field label="Kind of claim">
              <select value={filing.claim_type} style={{ width: '100%' }}
                      onChange={(e) => setFiling((f) => ({ ...f, claim_type: e.target.value }))}>
                {CLAIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="When it happened">
              <input type="date" value={filing.incident_date} max={sastToday()} style={{ width: '100%' }}
                     onChange={(e) => setFiling((f) => ({ ...f, incident_date: e.target.value }))} />
            </Field>
          </div>
          <Field label="What happened">
            <textarea rows="3" style={{ width: '100%' }} value={filing.description}
                      onChange={(e) => setFiling((f) => ({ ...f, description: e.target.value }))} />
          </Field>
          <div className="grid grid-2">
            <Field label="SAPS case number" hint="(optional)">
              <input value={filing.saps_case_number} placeholder="CAS 114/09/2026" style={{ width: '100%' }}
                     onChange={(e) => setFiling((f) => ({ ...f, saps_case_number: e.target.value }))} />
            </Field>
            <Field label="Police station" hint="(optional)">
              <input value={filing.saps_police_station} placeholder="Germiston" style={{ width: '100%' }}
                     onChange={(e) => setFiling((f) => ({ ...f, saps_police_station: e.target.value }))} />
            </Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn btn-secondary" onClick={() => setFiling(null)}>Cancel</button>
            <button className="btn" disabled={busy} onClick={fileClaim}>{busy ? 'Filing…' : 'File the claim'}</button>
          </div>
        </Modal>
      )}

      {outcome && (
        <Modal title={`Claim #${outcome.claim.id} — ${outcome.claim.registration}`}
               onClose={() => setOutcome(null)} style={{ maxWidth: 520 }}>
          <p className="muted text-sm" style={{ marginTop: 0 }}>
            What the insurer said. Approving and paying are their decisions — this writes
            them down, it does not move money.
          </p>
          <Field label="Where it stands">
            <select value={outcome.status} style={{ width: '100%' }}
                    onChange={(e) => setOutcome((o) => ({ ...o, status: e.target.value }))}>
              {CLAIM_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          {PAYOUT_STATUSES.includes(outcome.status) && (
            <Field label="Payout" hint={outcome.status === 'paid' ? '— what actually arrived' : '— what they agreed to'}>
              <input type="number" min="0" step="0.01" value={outcome.payout_amount} style={{ width: '100%' }}
                     onChange={(e) => setOutcome((o) => ({ ...o, payout_amount: e.target.value }))} />
            </Field>
          )}
          <Field label="Notes" hint="(optional)">
            <textarea rows="3" style={{ width: '100%' }} value={outcome.notes}
                      onChange={(e) => setOutcome((o) => ({ ...o, notes: e.target.value }))} />
          </Field>
          {outcome.status === 'closed' && (
            <p className="text-sm" style={{ color: 'var(--warn)' }}>
              Closing is final. A closed claim cannot be reopened — file a new one instead.
            </p>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn btn-secondary" onClick={() => setOutcome(null)}>Cancel</button>
            <button className="btn" disabled={busy} onClick={saveOutcome}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

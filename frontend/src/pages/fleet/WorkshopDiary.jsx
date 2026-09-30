import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, ConfirmModal, EmptyState, Loading } from '../../components/ui';
import { MapPin, Plus, Trash2, Save, Power, Clock, CalendarDays, AlertTriangle } from 'lucide-react';
import WorkshopTabs from './workshopTabs';

// A fleet running its own workshop.
//
// Until now a fleet owner could be given a workshop and do nothing with it:
// the opening hours and the closures were the platform operator's to set, so
// the workshop existed and took no bookings. This is the other half.
//
// Shared workshops — the ones the platform offers everybody — are named here
// but not editable. They belong to the operator and every other fleet books
// into them, so one fleet changing their hours would close them for all.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HORIZON_DAYS = 14;

// SAST is UTC+2 all year, so the local date is the UTC date two hours ahead.
const sastDate = (offsetDays = 0) =>
  new Date(Date.now() + (2 * 60 + offsetDays * 24 * 60) * 60000).toISOString().slice(0, 10);

const longDay = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-ZA', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
};

const slotWhen = (iso) => new Date(iso).toLocaleString('en-ZA', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'Africa/Johannesburg',
});

// The same arithmetic the server does — 30 minutes of work, 15 to write it up
// — so the hours being typed show the slots they will produce before saving.
// If the two ever disagree the server wins; this is a preview, not a rule.
const SLOT_MINUTES = 30;
const STEP_MINUTES = 45;

function minutesOf(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

function previewSlots(opens, closes) {
  if (!/^\d{2}:\d{2}$/.test(opens) || !/^\d{2}:\d{2}$/.test(closes)) return [];
  const out = [];
  for (let t = minutesOf(opens); t + SLOT_MINUTES <= minutesOf(closes); t += STEP_MINUTES) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

// Refused before it is sent, in the same words the server uses, so a typo in
// the hours is a sentence on the screen rather than a round trip and a toast.
function firstProblem(rules) {
  for (const r of rules) {
    if (minutesOf(r.closes_at) <= minutesOf(r.opens_at)) {
      return `${DAYS[r.weekday]}: ${r.opens_at}–${r.closes_at} ends before it starts`;
    }
  }
  for (let d = 0; d <= 6; d += 1) {
    const day = rules.filter((r) => Number(r.weekday) === d)
      .sort((a, z) => minutesOf(a.opens_at) - minutesOf(z.opens_at));
    for (let i = 1; i < day.length; i += 1) {
      if (minutesOf(day[i].opens_at) < minutesOf(day[i - 1].closes_at)) {
        return `${DAYS[d]}: ${day[i - 1].opens_at}–${day[i - 1].closes_at} and ${day[i].opens_at}–${day[i].closes_at} overlap`;
      }
    }
  }
  return null;
}

function WeekEditor({ rules, onSave, saving, workshopName }) {
  const [draft, setDraft] = useState(rules);
  useEffect(() => { setDraft(rules); }, [rules]);

  const byDay = useMemo(() => {
    const map = Array.from({ length: 7 }, () => []);
    draft.forEach((r, i) => { map[Number(r.weekday)]?.push({ ...r, _i: i }); });
    map.forEach((d) => d.sort((a, z) => String(a.opens_at).localeCompare(String(z.opens_at))));
    return map;
  }, [draft]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(rules);
  const problem = firstProblem(draft);
  const totalSlots = draft.reduce((n, r) => n + previewSlots(r.opens_at, r.closes_at).length, 0);

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ marginBottom: 0 }}>Opening hours — {workshopName}</h2>
        <button className="btn btn-sm" onClick={() => onSave(draft)} disabled={!dirty || saving || !!problem}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save the week'}
        </button>
      </div>
      <p className="muted text-sm" style={{ marginTop: 0 }}>
        A booking is {SLOT_MINUTES} minutes with {STEP_MINUTES - SLOT_MINUTES} after it, so slots
        start every {STEP_MINUTES} minutes. A day with no hours is a day your riders cannot book —
        this week offers {totalSlots} slot{totalSlots === 1 ? '' : 's'}.
      </p>
      {problem && (
        <p className="text-sm" style={{ color: 'var(--danger)', marginTop: 0 }}>
          <AlertTriangle size={13} style={{ verticalAlign: -2 }} /> {problem}
        </p>
      )}

      {DAYS.map((name, weekday) => (
        <div key={name} style={{
          padding: '12px 0', borderTop: weekday ? '1px solid var(--border)' : 'none',
          display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap',
        }}>
          <div style={{ minWidth: 100, paddingTop: 6 }}>
            <strong>{name}</strong>
            {byDay[weekday].length === 0 && <div className="text-xs muted">Closed</div>}
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            {byDay[weekday].map((w) => {
              const slots = previewSlots(w.opens_at, w.closes_at);
              return (
                <div key={w._i} className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <input type="time" value={w.opens_at} style={{ width: 118 }}
                         aria-label={`${name} opens`}
                         onChange={(e) => setDraft((d) => d.map((r, i) => (i === w._i ? { ...r, opens_at: e.target.value } : r)))} />
                  <span className="muted">to</span>
                  <input type="time" value={w.closes_at} style={{ width: 118 }}
                         aria-label={`${name} closes`}
                         onChange={(e) => setDraft((d) => d.map((r, i) => (i === w._i ? { ...r, closes_at: e.target.value } : r)))} />
                  <span className="text-xs muted">
                    {slots.length
                      ? `${slots.length} slot${slots.length === 1 ? '' : 's'} · ${slots[0]} to ${slots[slots.length - 1]}`
                      : 'no slot fits'}
                  </span>
                  <button className="btn btn-secondary btn-sm" aria-label={`Remove ${name} ${w.opens_at}`}
                          onClick={() => setDraft((d) => d.filter((_, i) => i !== w._i))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
            <button className="btn btn-secondary btn-sm"
                    onClick={() => setDraft((d) => [...d, { weekday, opens_at: '08:00', closes_at: '12:00' }])}>
              <Plus size={14} /> {byDay[weekday].length ? 'Another window' : 'Open this day'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function FleetWorkshopDiary() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [rules, setRules] = useState([]);
  const [closures, setClosures] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [locked, setLocked] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', city: '', province: '', phone: '' });
  const [closureDate, setClosureDate] = useState('');
  const [closureReason, setClosureReason] = useState('');
  const [stranding, setStranding] = useState(null);
  const [closingDown, setClosingDown] = useState(null);

  // Only a workshop of this fleet's own can be run from here; a shared one has
  // no organisation and belongs to the platform.
  const mine = useMemo(() => locations.filter((l) => l.organization_id != null), [locations]);
  const shared = useMemo(() => locations.filter((l) => l.organization_id == null), [locations]);
  const current = useMemo(() => mine.find((l) => l.id === selected) || null, [mine, selected]);

  const loadList = useCallback(async () => {
    try {
      const { data } = await api.get('/bookings/locations?include_inactive=1');
      const all = data.locations || [];
      setLocations(all);
      const owned = all.filter((l) => l.organization_id != null);
      setSelected((cur) => (owned.some((l) => l.id === cur) ? cur : owned[0]?.id ?? null));
    } catch (err) {
      if (err.response?.data?.code === 'TIER_REQUIRED') setLocked(err.response.data);
      else toast.error(err.response?.data?.error || 'Could not load your workshops');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDiary = useCallback(async (locationId) => {
    if (!locationId) { setRules([]); setClosures([]); setBookings([]); return; }
    try {
      const from = sastDate();
      const to = sastDate(HORIZON_DAYS);
      const [r, d] = await Promise.all([
        api.get(`/bookings/rules?location_id=${locationId}`),
        api.get(`/bookings/day?from=${from}&to=${to}&location_id=${locationId}`),
      ]);
      setRules(r.data.rules || []);
      setClosures(r.data.closures || []);
      setBookings(d.data.bookings || []);
      setLocked(null);
    } catch (err) {
      // A plan that does not include running a workshop is a different thing
      // from an error, and says so.
      if (err.response?.data?.code === 'TIER_REQUIRED') setLocked(err.response.data);
      else toast.error(err.response?.data?.error || 'Could not load that workshop');
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadDiary(selected); }, [selected, loadDiary]);

  const saveRules = async (next) => {
    setSaving(true);
    try {
      await api.put('/bookings/rules', { location_id: selected, rules: next });
      toast.success('Opening hours saved');
      await loadDiary(selected);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save those hours');
    } finally {
      setSaving(false);
    }
  };

  const addWorkshop = async () => {
    if (!draft.name.trim() || !draft.city.trim()) {
      toast.error('A workshop needs a name and a city');
      return;
    }
    try {
      const { data } = await api.post('/bookings/locations', draft);
      toast.success(`${data.name} added`);
      setDraft({ name: '', city: '', province: '', phone: '' });
      setAdding(false);
      setSelected(data.id);
      await loadList();
    } catch (err) {
      if (err.response?.data?.code === 'TIER_REQUIRED') setLocked(err.response.data);
      else toast.error(err.response?.data?.error || 'Could not add that workshop');
    }
  };

  const addClosure = async () => {
    if (!closureDate) {
      toast.error('Pick a date to close');
      return;
    }
    try {
      const { data } = await api.post('/bookings/closures', {
        location_id: selected, closed_on: closureDate, reason: closureReason,
      });
      setClosureDate('');
      setClosureReason('');
      toast.success('Day closed');
      // Closing a day with bikes already booked into it is allowed — holidays
      // get announced late — but somebody has to phone them.
      if (data.affected_bookings?.length) setStranding(data.affected_bookings);
      await loadDiary(selected);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not close that day');
    }
  };

  const reopen = async (closureId) => {
    try {
      await api.delete(`/bookings/closures/${closureId}`);
      toast.success('Day reopened');
      await loadDiary(selected);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not reopen that day');
    }
  };

  const toggleActive = async (confirm = false) => {
    if (!current) return;
    try {
      await api.put(`/bookings/locations/${current.id}`, { active: !current.active, confirm });
      toast.success(`${current.name} switched ${current.active ? 'off' : 'on'}`);
      setClosingDown(null);
      await loadList();
      await loadDiary(current.id);
    } catch (err) {
      // 409 means bikes are still booked in. The names come back with it, so
      // they are shown rather than summarised, and then it is asked again.
      if (err.response?.status === 409) {
        setClosingDown({
          bookings: err.response.data.affected_bookings || [],
          message: err.response.data.error,
        });
        return;
      }
      toast.error(err.response?.data?.error || 'Could not change that');
    }
  };

  if (loading) return <Loading />;

  if (locked) {
    return (
      <>
        <h1>Your workshop</h1>
        <div className="card" style={{ borderColor: 'rgba(234,179,8,0.4)', marginTop: 16 }}>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <AlertTriangle size={20} style={{ color: '#ca8a04', flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong>Running your own workshop is part of the {locked.required_tier} plan</strong>
              <p className="text-sm muted" style={{ margin: '6px 0 0' }}>
                You are on {locked.current_tier}. Your riders can still book at the workshops the
                platform offers — this is about running one of your own.
              </p>
              <a className="btn btn-sm" href="/fleet/app/billing" style={{ marginTop: 12 }}>See plans</a>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Workshop</h1>
      <WorkshopTabs />
      <p className="muted" style={{ marginTop: 0 }}>
        Your own workshop: when it is open, when it is not, and what is booked in.{' '}
        <Clock size={12} style={{ verticalAlign: -2 }} /> All times are Johannesburg time.
      </p>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ marginBottom: 0 }}><MapPin size={17} style={{ verticalAlign: -3 }} /> Your workshops</h2>
          <button className="btn btn-secondary btn-sm" onClick={() => setAdding((v) => !v)}>
            <Plus size={14} /> {adding ? 'Cancel' : 'Add a workshop'}
          </button>
        </div>

        {mine.length === 0 && !adding ? (
          <EmptyState
            title="You have no workshop of your own"
            sub="Add one to set its hours and take your riders' bookings."
            action={<button className="btn" onClick={() => setAdding(true)}><Plus size={15} /> Add a workshop</button>}
          />
        ) : (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0 10px' }}>
            {mine.map((l) => (
              <button key={l.id}
                      className={selected === l.id ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
                      style={l.active ? undefined : { opacity: 0.55 }}
                      onClick={() => setSelected(l.id)}>
                {l.name} · {l.city}{l.active ? '' : ' (off)'}
              </button>
            ))}
          </div>
        )}

        {/* Named, but not editable. They are the platform's, every fleet books
            into them, and one fleet must not be able to change their hours. */}
        {shared.length > 0 && (
          <div className="text-sm muted" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            Your riders can also book at {shared.map((l) => `${l.name} (${l.city})`).join(', ')} —
            offered by the platform, so those hours are not yours to set.
          </div>
        )}

        {adding && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {[['name', 'Name', 'Main Workshop'], ['city', 'City', 'Johannesburg'],
                ['province', 'Province', 'Gauteng'], ['phone', 'Phone', '011 000 0000']].map(([k, label, hint]) => (
                  <label key={k} style={{ flex: 1, minWidth: 150 }}>
                    <span className="text-sm">{label}</span>
                    <input value={draft[k]} placeholder={hint} style={{ display: 'block', marginTop: 4, width: '100%' }}
                           onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
                  </label>
                ))}
              <button className="btn btn-sm" onClick={addWorkshop}>Add</button>
            </div>
          </div>
        )}
      </div>

      {current && (
        <>
          <div style={{ marginTop: 16 }}>
            <WeekEditor rules={rules} onSave={saveRules} saving={saving} workshopName={current.name} />
          </div>

          <div className="grid grid-2" style={{ gap: 16, marginTop: 16, alignItems: 'start' }}>
            <div className="card">
              <h2><CalendarDays size={17} style={{ verticalAlign: -3 }} /> Days you are closed</h2>
              <p className="muted text-sm" style={{ marginTop: 0 }}>
                Public holidays and one-off closures. The weekly hours go back to normal by
                themselves the next day.
              </p>
              <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
                <label>
                  <span className="text-sm">Date</span>
                  <input type="date" value={closureDate} min={sastDate()}
                         style={{ display: 'block', marginTop: 4 }}
                         onChange={(e) => setClosureDate(e.target.value)} />
                </label>
                <label style={{ flex: 1, minWidth: 150 }}>
                  <span className="text-sm">Reason <span className="muted">(optional)</span></span>
                  <input value={closureReason} maxLength={200} placeholder="Stocktake"
                         style={{ display: 'block', marginTop: 4, width: '100%' }}
                         onChange={(e) => setClosureReason(e.target.value)} />
                </label>
                <button className="btn btn-sm" onClick={addClosure}><Plus size={14} /> Close</button>
              </div>
              {closures.length === 0 ? (
                <p className="muted text-sm">No closures coming up.</p>
              ) : closures.map((c) => (
                <div key={c.id} className="flex-between"
                     style={{ padding: '8px 0', borderTop: '1px solid var(--border)', gap: 8 }}>
                  <div>
                    <strong>{longDay(c.closed_on)}</strong>
                    {c.reason && <span className="muted text-sm"> — {c.reason}</span>}
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => reopen(c.id)}>Reopen</button>
                </div>
              ))}
            </div>

            <div className="card">
              <h2>Booked in, next {HORIZON_DAYS} days</h2>
              {bookings.length === 0 ? (
                <p className="muted text-sm">Nothing booked yet.</p>
              ) : bookings.map((b) => (
                <div key={b.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{slotWhen(b.starts_at)}</strong>
                    <span>{b.registration}</span>
                    <Badge status={b.status}>{String(b.status).replace(/_/g, ' ')}</Badge>
                  </div>
                  <div className="text-xs muted">
                    {[b.make, b.model].filter(Boolean).join(' ') || 'Bike'}
                    {b.booked_by_name ? ` · booked by ${b.booked_by_name}` : ''}
                    {b.note ? ` · “${b.note}”` : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div className="text-sm muted">
                {current.active
                  ? `${current.name} is open for bookings.`
                  : `${current.name} is switched off — your riders are not offered it.`}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => toggleActive(false)}>
                <Power size={14} /> {current.active ? 'Switch off' : 'Switch on'}
              </button>
            </div>
          </div>
        </>
      )}

      {stranding && (
        <ConfirmModal
          title={`${stranding.length} ${stranding.length === 1 ? 'booking needs' : 'bookings need'} moving`}
          body={(
            <div>
              <p>That day is now closed, but these bikes were already booked in. Your riders need telling:</p>
              <ul style={{ margin: '8px 0 0 18px' }}>
                {stranding.map((b) => (
                  <li key={b.id}><strong>{b.registration}</strong> — {slotWhen(b.starts_at)}</li>
                ))}
              </ul>
            </div>
          )}
          confirmLabel="Understood"
          onConfirm={() => setStranding(null)}
          onClose={() => setStranding(null)}
        />
      )}

      {closingDown && (
        <ConfirmModal
          danger
          title="Switch off anyway?"
          body={(
            <div>
              <p>{closingDown.message} Switching off does not cancel them — somebody has to phone:</p>
              <ul style={{ margin: '8px 0 0 18px' }}>
                {closingDown.bookings.map((b) => (
                  <li key={b.id}><strong>{b.registration}</strong> — {slotWhen(b.starts_at)}</li>
                ))}
              </ul>
            </div>
          )}
          confirmLabel="Switch off"
          onConfirm={() => toggleActive(true)}
          onClose={() => setClosingDown(null)}
        />
      )}
    </>
  );
}

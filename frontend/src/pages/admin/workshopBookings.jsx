import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, ConfirmModal, EmptyState, Loading } from '../../components/ui';
import { Plus, Trash2, CalendarDays, Clock, AlertTriangle, Save, MapPin, Power, Pencil } from 'lucide-react';

// The admin's side of the service calendar: which days and hours can be
// booked, which specific dates are shut, and how far ahead riders may go.
//
// Kept out of Workshop.jsx the way workshopParts.jsx is, because that file is
// already fourteen hundred lines and this is a self-contained screen.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Name, city, province, phone — the four things a workshop is. Province is
// matched against a rider's own to pick which workshop they see first.
const FIELDS = [
  ['name', 'Name', 'Durban Moto'],
  ['city', 'City', 'Durban'],
  ['province', 'Province', 'KwaZulu-Natal'],
  ['phone', 'Phone', '031 000 0000'],
];

const todayInJohannesburg = () => new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);

const longDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-ZA', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
};

const slotWhen = (iso) => new Date(iso).toLocaleString('en-ZA', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'Africa/Johannesburg',
});

// The same arithmetic the server does, so the admin can see what a window will
// actually produce before saving it. 30 minutes of work, 15 to write it up.
function previewSlots(opens, closes) {
  const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  if (!/^\d{2}:\d{2}$/.test(opens) || !/^\d{2}:\d{2}$/.test(closes)) return [];
  const out = [];
  for (let t = mins(opens); t + 30 <= mins(closes); t += 45) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

function WeekEditor({ rules, onSave, saving, locationName }) {
  const [draft, setDraft] = useState(rules);
  useEffect(() => { setDraft(rules); }, [rules]);

  const byDay = useMemo(() => {
    const map = Array.from({ length: 7 }, () => []);
    draft.forEach((r, i) => map[Number(r.weekday)].push({ ...r, _i: i }));
    map.forEach((d) => d.sort((a, z) => a.opens_at.localeCompare(z.opens_at)));
    return map;
  }, [draft]);

  const setWindow = (index, field, value) =>
    setDraft((d) => d.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  const addWindow = (weekday) =>
    setDraft((d) => [...d, { weekday, opens_at: '08:00', closes_at: '12:00' }]);
  const removeWindow = (index) => setDraft((d) => d.filter((_, i) => i !== index));

  const dirty = JSON.stringify(draft) !== JSON.stringify(rules);
  const totalSlots = draft.reduce((n, r) => n + previewSlots(r.opens_at, r.closes_at).length, 0);

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ marginBottom: 0, marginLeft: 0 }}>Opening hours{locationName ? ` — ${locationName}` : ''}</h2>
        <button className="btn btn-sm" onClick={() => onSave(draft)} disabled={!dirty || saving}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save the week'}
        </button>
      </div>
      <p className="muted text-sm" style={{ marginTop: 0 }}>
        Each booking is 30 minutes with 15 minutes between, so slots start every 45 minutes.
        A day with no hours is a day riders cannot book. That is {totalSlots} slots a week.
      </p>

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
                <div key={w._i} className="row gap-2" style={{ alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <input
                    type="time" value={w.opens_at} step="900"
                    onChange={(e) => setWindow(w._i, 'opens_at', e.target.value)}
                    style={{ width: 120 }} aria-label={`${name} opens`}
                  />
                  <span className="muted">to</span>
                  <input
                    type="time" value={w.closes_at} step="900"
                    onChange={(e) => setWindow(w._i, 'closes_at', e.target.value)}
                    style={{ width: 120 }} aria-label={`${name} closes`}
                  />
                  <span className="text-xs muted">
                    {slots.length ? `${slots.length} slots · ${slots[0]}–${slots[slots.length - 1]}` : 'no slots fit'}
                  </span>
                  <button
                    className="btn btn-secondary btn-sm" onClick={() => removeWindow(w._i)}
                    aria-label={`Remove ${name} ${w.opens_at}`}
                  ><Trash2 size={14} /></button>
                </div>
              );
            })}
            <button className="btn btn-secondary btn-sm" onClick={() => addWindow(weekday)}>
              <Plus size={14} /> {byDay[weekday].length ? 'Another window' : 'Open this day'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ClosuresCard({ closures, onAdd, onRemove }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(null);

  const add = async () => {
    if (!date) return toast.error('Pick a date to close');
    const affected = await onAdd(date, reason);
    setDate(''); setReason('');
    if (affected?.length) setConfirming(affected);
  };

  return (
    <div className="card">
      <h2 style={{ marginLeft: 0 }}>Days this workshop is closed</h2>
      <p className="muted text-sm" style={{ marginTop: 0 }}>
        Public holidays and one-off closures. Use these rather than editing the weekly hours,
        so the week goes back to normal on its own.
      </p>

      <div className="row gap-2" style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <label>
          <span className="text-sm">Date</span>
          <input type="date" value={date} min={todayInJohannesburg()} onChange={(e) => setDate(e.target.value)} style={{ display: 'block', marginTop: 4 }} />
        </label>
        <label style={{ flex: 1, minWidth: 180 }}>
          <span className="text-sm">Reason <span className="muted">(optional)</span></span>
          <input value={reason} maxLength={200} placeholder="Human Rights Day" onChange={(e) => setReason(e.target.value)} style={{ display: 'block', marginTop: 4, width: '100%' }} />
        </label>
        <button className="btn btn-sm" onClick={add}><Plus size={14} /> Close this day</button>
      </div>

      {closures.length === 0 ? (
        <p className="muted text-sm">No closures coming up.</p>
      ) : closures.map((c) => (
        <div key={c.id} className="flex-between" style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
          <div>
            <strong>{longDay(c.closed_on)}</strong>
            {c.reason && <span className="muted text-sm"> — {c.reason}</span>}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => onRemove(c.id)}>Reopen</button>
        </div>
      ))}

      {confirming && (
        <ConfirmModal
          title={`${confirming.length} ${confirming.length === 1 ? 'booking needs' : 'bookings need'} moving`}
          body={
            <div>
              <p>That day is now closed, but these were already booked in. They need phoning:</p>
              <ul style={{ margin: '8px 0 0 18px' }}>
                {confirming.map((b) => (
                  <li key={b.id}><strong>{b.registration}</strong> — {slotWhen(b.starts_at)}</li>
                ))}
              </ul>
            </div>
          }
          confirmLabel="Understood"
          onConfirm={() => setConfirming(null)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function SettingsCard({ settings, onSave, saving }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => { setDraft(settings); }, [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const field = (name, label, help) => (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="text-sm">{label}</span>
      <input
        type="number" min="1" value={draft?.[name] ?? ''}
        onChange={(e) => setDraft((d) => ({ ...d, [name]: Number(e.target.value) }))}
        style={{ display: 'block', marginTop: 4, width: 120 }}
      />
      <span className="text-xs muted">{help}</span>
    </label>
  );

  return (
    <div className="card">
      <h2>Booking rules</h2>
      {field('horizon_days', 'Riders can book this many days ahead', 'Beyond this the calendar stops.')}
      {field('lead_hours', 'Least notice a rider must give (hours)', 'Stops somebody booking a slot that starts in twenty minutes. Does not apply to bookings you take yourself.')}
      {field('change_cutoff_hours', 'Riders can change or cancel up to (hours before)', 'After this they are told to phone. You can always still move it.')}
      <button className="btn btn-sm" onClick={() => onSave(draft)} disabled={!dirty || saving}>
        <Save size={14} /> {saving ? 'Saving…' : 'Save rules'}
      </button>
    </div>
  );
}

function UpcomingCard({ bookings }) {
  if (!bookings.length) {
    return <EmptyState title="Nothing booked yet" sub="Bookings riders make will appear here." />;
  }
  return (
    <div className="card">
      <h2>Next two weeks</h2>
      {bookings.map((b) => (
        <div key={b.id} className="flex-between" style={{ padding: '10px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>{slotWhen(b.starts_at)}</strong>
              <span>{b.registration}</span>
              <Badge status={b.status}>{String(b.status).replace(/_/g, ' ')}</Badge>
              {b.open_flags > 0 && (
                <span className="text-xs" style={{ color: '#ca8a04', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <AlertTriangle size={12} /> {b.open_flags} note{b.open_flags === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="text-xs muted">
              {b.make} {b.model}{b.organization_name ? ` · ${b.organization_name}` : ''}
              {b.note ? ` · “${b.note}”` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const BLANK_LOCATION = { name: '', city: '', province: '', phone: '' };

function LocationsCard({ locations, selected, onSelect, onAdd, onToggle, onRename }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(BLANK_LOCATION);

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ marginBottom: 0, marginLeft: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <MapPin size={18} /> Workshops
        </h2>
        <button className="btn btn-secondary btn-sm" onClick={() => { setAdding((v) => !v); setEditing(null); }}>
          <Plus size={14} /> {adding ? 'Cancel' : 'Add a workshop'}
        </button>
      </div>
      <p className="muted text-sm" style={{ marginTop: 0 }}>
        Opening hours, closures and bookings all belong to one workshop. Pick the one you are editing.
      </p>

      <div className="row gap-2" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {locations.map((l) => (
          <button
            key={l.id}
            className={selected === l.id ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => onSelect(l.id)}
            style={{ opacity: l.active ? 1 : 0.5 }}
            title={[
              l.organization_name ? `Belongs to ${l.organization_name}` : 'Shared — every fleet can book it',
              l.active ? '' : 'Switched off — not offered to riders',
            ].filter(Boolean).join(' · ')}
          >
            {l.name} · {l.city}{l.active ? '' : ' (off)'}
            {/* Whose it is, on the button. A shared workshop and one fleet's
                look identical otherwise, and editing the wrong one is a
                mistake nobody notices until a fleet's diary changes. */}
            <span className="text-xs" style={{ marginLeft: 6, opacity: 0.7 }}>
              {l.organization_name ? `· ${l.organization_name}` : '· shared'}
            </span>
          </button>
        ))}
      </div>

      {locations.filter((l) => l.id === selected).map((l) => (
        <div key={l.id} style={{ paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="text-sm muted">
              {l.organization_name
                ? `Belongs to ${l.organization_name} — only their riders see it.`
                : 'Shared — every fleet on the platform can book it.'}
              <br />
              {l.province ? `Riders in ${l.province} are offered this one first.` : 'No province set, so this is never a rider’s default.'}
              {l.phone ? ` · ${l.phone}` : ''}
            </div>
            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setEditing(editing === l.id ? null : l.id);
                  setDraft({ name: l.name, city: l.city, province: l.province || '', phone: l.phone || '' });
                  setAdding(false);
                }}
              ><Pencil size={14} /> {editing === l.id ? 'Cancel' : 'Rename'}</button>
              <button className="btn btn-secondary btn-sm" onClick={() => onToggle(l)}>
                <Power size={14} /> {l.active ? 'Switch off' : 'Switch on'}
              </button>
            </div>
          </div>

          {editing === l.id && (
            <div style={{ marginTop: 12 }}>
              <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {FIELDS.map(([key, label, hint]) => (
                  <label key={key} style={{ flex: 1, minWidth: 150 }}>
                    <span className="text-sm">{label}</span>
                    <input
                      value={draft[key]} placeholder={hint}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                      style={{ display: 'block', marginTop: 4, width: '100%' }}
                    />
                  </label>
                ))}
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    if (await onRename(l, draft)) { setEditing(null); setDraft(BLANK_LOCATION); }
                  }}
                ><Save size={14} /> Save</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {adding && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div className="row gap-2" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {FIELDS.map(([key, label, hint]) => (
              <label key={key} style={{ flex: 1, minWidth: 150 }}>
                <span className="text-sm">{label}{key === 'province' || key === 'phone' ? <span className="muted"> (optional)</span> : ''}</span>
                <input
                  value={draft[key]} placeholder={hint}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  style={{ display: 'block', marginTop: 4, width: '100%' }}
                />
              </label>
            ))}
            <button
              className="btn btn-sm"
              onClick={async () => {
                if (await onAdd(draft)) { setDraft(BLANK_LOCATION); setAdding(false); }
              }}
            >Add</button>
          </div>
          <p className="text-xs muted" style={{ marginTop: 8, marginBottom: 0 }}>
            Province is matched against a rider’s own, to choose which workshop they see first.
          </p>
        </div>
      )}
    </div>
  );
}

export function BookingsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState({ rules: [], closures: [], settings: null, locations: [] });
  const [upcoming, setUpcoming] = useState([]);
  const [locationId, setLocationId] = useState(null);
  const [stranding, setStranding] = useState(null);

  const load = useCallback(async (forLocation) => {
    try {
      const today = todayInJohannesburg();
      const to = new Date(Date.now() + 14 * 86400000 + 2 * 3600000).toISOString().slice(0, 10);
      const scope = forLocation ? `?location_id=${forLocation}` : '';
      const [rules, day] = await Promise.all([
        api.get(`/bookings/rules${scope}`),
        api.get(`/bookings/day?from=${today}&to=${to}${forLocation ? `&location_id=${forLocation}` : ''}`),
      ]);
      setState(rules.data);
      setUpcoming(day.data.bookings || []);
      // First load: settle on a workshop so the week below is unambiguous.
      if (!forLocation && rules.data.locations?.length) setLocationId(rules.data.locations[0].id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load the calendar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(locationId); }, [locationId, load]);

  const saveRules = async (rules) => {
    setSaving(true);
    try {
      await api.put('/bookings/rules', { location_id: locationId, rules });
      toast.success('Opening hours saved');
      await load(locationId);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save those hours');
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async (settings) => {
    setSaving(true);
    try {
      await api.put('/bookings/settings', settings);
      toast.success('Booking rules saved');
      await load(locationId);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save those rules');
    } finally {
      setSaving(false);
    }
  };

  const addClosure = async (closed_on, reason) => {
    try {
      const { data } = await api.post('/bookings/closures', { location_id: locationId, closed_on, reason });
      toast.success('Day closed');
      await load(locationId);
      return data.affected_bookings;
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not close that day');
      return [];
    }
  };

  const removeClosure = async (id) => {
    try {
      await api.delete(`/bookings/closures/${id}`);
      toast.success('Day reopened');
      await load(locationId);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not reopen that day');
    }
  };

  const addLocation = async (draft) => {
    if (!draft.name.trim() || !draft.city.trim()) {
      toast.error('A workshop needs a name and a city');
      return false;
    }
    try {
      const { data } = await api.post('/bookings/locations', draft);
      toast.success(`${data.name} added`);
      setLocationId(data.id);
      return true;
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not add that workshop');
      return false;
    }
  };

  const renameLocation = async (location, draft) => {
    if (!draft.name.trim() || !draft.city.trim()) {
      toast.error('A workshop needs a name and a city');
      return false;
    }
    try {
      await api.put(`/bookings/locations/${location.id}`, draft);
      toast.success('Workshop updated');
      await load(locationId);
      return true;
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update that workshop');
      return false;
    }
  };

  const toggleLocation = async (location) => {
    try {
      await api.put(`/bookings/locations/${location.id}`, { active: !location.active });
      toast.success(`${location.name} switched ${location.active ? 'off' : 'on'}`);
      await load(locationId);
    } catch (err) {
      // 409 means bikes are still booked in there. Name them, then let the
      // admin decide rather than quietly stranding riders.
      const stranded = err.response?.data?.affected_bookings;
      if (stranded?.length) return setStranding({ location, bookings: stranded });
      toast.error(err.response?.data?.error || 'Could not change that workshop');
    }
  };

  if (loading) return <Loading />;

  const current = (state.locations || []).find((l) => l.id === locationId);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="row gap-2" style={{ alignItems: 'center' }}>
        <CalendarDays size={18} />
        <span className="muted text-sm">
          <Clock size={12} style={{ display: 'inline', verticalAlign: -2 }} /> All times are Johannesburg time.
        </span>
      </div>
      <LocationsCard
        locations={state.locations || []}
        selected={locationId}
        onSelect={setLocationId}
        onAdd={addLocation}
        onToggle={toggleLocation}
        onRename={renameLocation}
      />
      <WeekEditor rules={state.rules} onSave={saveRules} saving={saving} locationName={current?.name} />
      <div className="grid grid-2" style={{ gap: 16, alignItems: 'start' }}>
        <ClosuresCard closures={state.closures} onAdd={addClosure} onRemove={removeClosure} />
        <SettingsCard settings={state.settings} onSave={saveSettings} saving={saving} />
      </div>
      <UpcomingCard bookings={upcoming} />

      {stranding && (
        <ConfirmModal
          title={`Switch off ${stranding.location.name}?`}
          body={
            <div>
              <p>
                {stranding.bookings.length} {stranding.bookings.length === 1 ? 'bike is' : 'bikes are'} still
                booked in there. Riders will not be told automatically — they need phoning.
              </p>
              <ul style={{ margin: '8px 0 0 18px' }}>
                {stranding.bookings.map((b) => (
                  <li key={b.id}><strong>{b.registration}</strong> — {slotWhen(b.starts_at)}</li>
                ))}
              </ul>
            </div>
          }
          confirmLabel="Switch it off anyway"
          danger
          onConfirm={async () => {
            try {
              await api.put(`/bookings/locations/${stranding.location.id}`, { active: false, confirm: true });
              toast.success(`${stranding.location.name} switched off`);
              setStranding(null);
              await load(locationId);
            } catch (err) {
              toast.error(err.response?.data?.error || 'Could not switch that workshop off');
            }
          }}
          onClose={() => setStranding(null)}
        />
      )}
    </div>
  );
}

export default BookingsTab;

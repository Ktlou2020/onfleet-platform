import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, ConfirmModal, EmptyState, Loading } from '../../components/ui';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, AlertTriangle, CheckCircle2, Wrench, MapPin } from 'lucide-react';

// Booking a service, from the rider's side.
//
// This replaces two hardcoded Google Calendar links that lived on the
// agreement page. The thing it has to get right is that a rider on a phone,
// standing next to a bike that is making a noise, can find a time in under a
// minute — so the page opens on the first day with anything free rather than
// on today, which is usually full or shut.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const dayLabel = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${DAY_NAMES[at.getUTCDay()]} ${d} ${at.toLocaleString('en-ZA', { month: 'long', timeZone: 'UTC' })}`;
};

const shortDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return { dow: DAY_NAMES[at.getUTCDay()].slice(0, 3), day: d, month: at.toLocaleString('en-ZA', { month: 'short', timeZone: 'UTC' }) };
};

// Slot times come back as instants; the workshop is in Johannesburg and the
// rider is standing in it, so they are always shown in its time.
const slotTime = (iso) => new Date(iso).toLocaleTimeString('en-ZA', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg',
});
const slotWhen = (iso) => new Date(iso).toLocaleString('en-ZA', {
  weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'Africa/Johannesburg',
});

function DueBanner({ due, bike }) {
  if (!due || due.state === 'ok') return null;
  const overdue = due.state === 'overdue';
  return (
    <div className="card" style={{
      borderColor: overdue ? 'rgba(220,38,38,0.4)' : 'rgba(234,179,8,0.4)',
      background: overdue ? 'rgba(220,38,38,0.06)' : 'rgba(234,179,8,0.06)',
      display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16,
    }}>
      <AlertTriangle size={20} style={{ color: overdue ? 'var(--danger, #dc2626)' : '#ca8a04', flexShrink: 0, marginTop: 2 }} />
      <div>
        <strong>{overdue ? 'Your bike is overdue for a service' : 'Your bike is due for a service soon'}</strong>
        <div className="text-sm muted" style={{ marginTop: 4 }}>
          {bike?.registration}
          {due.km_remaining != null && (overdue && due.km_remaining <= 0
            ? ` — ${Math.abs(due.km_remaining).toLocaleString('en-ZA')} km past its service interval`
            : ` — ${Number(due.km_remaining).toLocaleString('en-ZA')} km to go`)}
        </div>
      </div>
    </div>
  );
}

function BookingCard({ item, settings, onCancel, onMove }) {
  const live = ['booked', 'arrived'].includes(item.status);
  const hoursAway = (new Date(item.starts_at) - Date.now()) / 3600000;
  const canChange = live && hoursAway > (settings?.change_cutoff_hours ?? 24);

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="flex-between gap-3" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{
            width: 42, height: 42, borderRadius: 12, flexShrink: 0,
            background: live ? 'rgba(34,197,94,0.12)' : 'var(--surface-2, rgba(127,127,127,0.1))',
            color: live ? '#16a34a' : 'var(--text-muted, #888)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {live ? <CheckCircle2 size={20} /> : <Wrench size={20} />}
          </div>
          <div>
            <h3 style={{ marginBottom: 2 }}>{slotWhen(item.starts_at)}</h3>
            <div className="text-sm muted">{item.registration} · {item.make} {item.model}</div>
            {item.location_name && (
              <div className="text-sm" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                <MapPin size={13} /> {item.location_name}, {item.location_city}
              </div>
            )}
            {item.note && <p className="text-sm muted" style={{ marginTop: 6, marginBottom: 0 }}>“{item.note}”</p>}
          </div>
        </div>
        <Badge status={item.status}>{String(item.status).replace(/_/g, ' ')}</Badge>
      </div>

      {live && (
        <div className="row gap-2" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          {canChange ? (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => onMove(item)}>Change time or workshop</button>
              <button className="btn btn-secondary btn-sm" onClick={() => onCancel(item)}>Cancel</button>
            </>
          ) : (
            <div className="text-xs muted">
              {item.status === 'arrived'
                ? 'Your bike is with the workshop.'
                : `Too close to change online — please phone the workshop.`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function BookService() {
  const [loading, setLoading] = useState(true);
  const [mine, setMine] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [chosen, setChosen] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [movingId, setMovingId] = useState(null);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState(null);

  // Which workshop, and the rider's own bookings. The server picks the first
  // workshop to show — their province, or wherever they last went.
  const loadMine = useCallback(async () => {
    try {
      const [locs, m] = await Promise.all([
        api.get('/bookings/locations'),
        api.get('/bookings/mine'),
      ]);
      setLocations(locs.data.locations || []);
      setMine(m.data);
      setLocationId((current) => current ?? locs.data.default_location_id ?? locs.data.locations?.[0]?.id ?? null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load the service calendar');
      setLoading(false);
    }
  }, []);

  // The calendar belongs to one workshop, so it reloads whenever that changes.
  const loadCalendar = useCallback(async (id) => {
    if (!id) return;
    try {
      const { data } = await api.get(`/bookings/availability?location_id=${id}`);
      setCalendar(data);
      // Open on the first day with something free rather than on today, which
      // is usually shut or already inside the lead time.
      const first = data.days.findIndex((d) => d.open_count > 0);
      setDayIndex(first === -1 ? 0 : first);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load that workshop\'s calendar');
    } finally {
      setLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    await loadMine();
    await loadCalendar(locationId);
  }, [loadMine, loadCalendar, locationId]);

  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => { setChosen(null); loadCalendar(locationId); }, [locationId, loadCalendar]);

  const days = useMemo(() => calendar?.days || [], [calendar]);
  const day = days[dayIndex];
  const liveBooking = useMemo(
    () => (mine?.bookings || []).find((b) => ['booked', 'arrived'].includes(b.status)),
    [mine]);

  // Days worth stepping through — a fortnight of shut Sundays between the
  // rider and the next free Tuesday is not a calendar, it is an obstacle.
  const openDays = useMemo(() => days.filter((d) => d.open_count > 0), [days]);
  const currentLocation = useMemo(
    () => locations.find((l) => l.id === locationId) || null, [locations, locationId]);

  const confirm = async () => {
    if (!chosen) return;
    setSaving(true);
    try {
      if (movingId) {
        await api.patch(`/bookings/${movingId}`, { starts_at: chosen, location_id: locationId });
        toast.success('Booking moved');
      } else {
        await api.post('/bookings', { starts_at: chosen, location_id: locationId, note: note.trim() || undefined });
        toast.success('Service booked');
      }
      setChosen(null); setNote(''); setMovingId(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save that booking');
      await load(); // somebody may have taken the slot while this was open
    } finally {
      setSaving(false);
    }
  };

  const doCancel = async () => {
    try {
      await api.delete(`/bookings/${cancelling.id}`);
      toast.success('Booking cancelled');
      setCancelling(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not cancel that booking');
    }
  };

  if (loading) return <Loading />;

  if (!mine?.bike) {
    return (
      <div>
        <h1>Book a service</h1>
        <EmptyState
          title="No bike on an active agreement"
          sub="Once your agreement is active you can book your bike in for a service here."
        />
      </div>
    );
  }

  return (
    <div>
      <h1>Book a service</h1>
      <p className="muted" style={{ marginTop: -8, marginBottom: 20 }}>
        {mine.bike.registration} · {mine.bike.make} {mine.bike.model}
      </p>

      <DueBanner due={mine.due} bike={mine.bike} />

      {(mine.bookings || []).filter((b) => ['booked', 'arrived'].includes(b.status)).map((b) => (
        <BookingCard
          key={b.id} item={b} settings={mine.settings}
          onCancel={setCancelling}
          onMove={(item) => {
            setMovingId(item.id);
            setChosen(null);
            // Start them at the workshop the booking is already at, not
            // wherever they happened to be browsing.
            if (item.location_id) setLocationId(item.location_id);
          }}
        />
      ))}

      {liveBooking && !movingId ? (
        <p className="text-sm muted">
          Your bike already has a booking. Change its time above to move it.
        </p>
      ) : (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            {/* marginLeft: the stylesheet gives h2 an auto left margin, which
                in a space-between flex row with nothing beside it shunts the
                heading to the right. */}
            <h2 style={{ marginBottom: 0, marginLeft: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CalendarDays size={18} /> {movingId ? 'Pick a new time' : 'Pick a time'}
            </h2>
            {movingId && (
              <button className="btn btn-secondary btn-sm" onClick={() => { setMovingId(null); setChosen(null); }}>
                Keep the current time
              </button>
            )}
          </div>

          {locations.length > 1 && (
            <div style={{ marginBottom: 16 }}>
              <span className="text-sm muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <MapPin size={14} /> Which workshop?
              </span>
              <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
                {locations.map((l) => (
                  <button
                    key={l.id}
                    className={locationId === l.id ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
                    onClick={() => setLocationId(l.id)}
                  >
                    {l.name} · {l.city}
                  </button>
                ))}
              </div>
            </div>
          )}

          {openDays.length === 0 ? (
            <EmptyState
              title={`Nothing free at ${currentLocation?.name || 'this workshop'}`}
              sub={locations.length > 1
                ? 'Every slot here is taken for now. Try the other workshop, or phone them.'
                : 'Every slot in the next few weeks is taken. Please phone the workshop.'}
            />
          ) : (
            <>
              {/* A strip of the days that actually have something free. */}
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 16 }}>
                {openDays.map((d) => {
                  const s = shortDay(d.date);
                  const active = days[dayIndex]?.date === d.date;
                  return (
                    <button
                      key={d.date}
                      onClick={() => setDayIndex(days.findIndex((x) => x.date === d.date))}
                      className={active ? 'btn' : 'btn btn-secondary'}
                      style={{
                        flexDirection: 'column', minWidth: 68, padding: '8px 10px', gap: 0, flexShrink: 0, lineHeight: 1.3,
                      }}
                    >
                      <span className="text-xs" style={{ opacity: 0.75 }}>{s.dow}</span>
                      <span style={{ fontSize: 18, fontWeight: 600 }}>{s.day}</span>
                      <span className="text-xs" style={{ opacity: 0.75 }}>{s.month}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex-between" style={{ marginBottom: 10 }}>
                <button
                  className="btn btn-secondary btn-sm" disabled={dayIndex === 0}
                  onClick={() => setDayIndex((i) => Math.max(0, i - 1))}
                  aria-label="Previous day"
                ><ChevronLeft size={16} /></button>
                <strong>{day ? dayLabel(day.date) : ''}</strong>
                <button
                  className="btn btn-secondary btn-sm" disabled={dayIndex >= days.length - 1}
                  onClick={() => setDayIndex((i) => Math.min(days.length - 1, i + 1))}
                  aria-label="Next day"
                ><ChevronRight size={16} /></button>
              </div>

              {!day || day.slots.length === 0 ? (
                <p className="muted text-sm" style={{ textAlign: 'center', padding: '20px 0' }}>
                  {day?.closure_reason ? `Closed — ${day.closure_reason}` : 'The workshop is closed on this day.'}
                </p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 8 }}>
                  {day.slots.map((s) => (
                    <button
                      key={s.starts_at}
                      disabled={!s.available}
                      onClick={() => setChosen(s.starts_at)}
                      className={chosen === s.starts_at ? 'btn' : 'btn btn-secondary'}
                      title={s.reason === 'taken' ? 'Already booked' : s.reason === 'closed' ? 'Workshop closed' : s.reason === 'too_soon' ? 'Too soon to book online' : ''}
                      style={{ opacity: s.available ? 1 : 0.35, justifyContent: 'center' }}
                    >
                      <Clock size={14} /> {slotTime(s.starts_at)}
                    </button>
                  ))}
                </div>
              )}

              {chosen && (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                  {!movingId && (
                    <label style={{ display: 'block', marginBottom: 12 }}>
                      <span className="text-sm">What should the workshop look at? <span className="muted">(optional)</span></span>
                      <textarea
                        rows={3} value={note} maxLength={1000}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="e.g. front brake squeals, and the indicator sticks"
                        style={{ width: '100%', marginTop: 6 }}
                      />
                    </label>
                  )}
                  <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn" onClick={confirm} disabled={saving}>
                      {saving ? 'Saving…'
                        : movingId ? `Move to ${slotWhen(chosen)}`
                          : `Book ${slotWhen(chosen)}`}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setChosen(null)} disabled={saving}>Clear</button>
                  </div>
                  <p className="text-xs muted" style={{ marginTop: 10, marginBottom: 0 }}>
                    {currentLocation && <>At {currentLocation.name}, {currentLocation.city}. </>}
                    Each slot is {calendar?.slot_minutes ?? 30} minutes. You can change it yourself up to{' '}
                    {mine.settings?.change_cutoff_hours ?? 24} hours beforehand.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {(mine.bookings || []).some((b) => !['booked', 'arrived'].includes(b.status)) && (
        <>
          <h2 style={{ marginTop: 28 }}>Past bookings</h2>
          {mine.bookings.filter((b) => !['booked', 'arrived'].includes(b.status)).map((b) => (
            <BookingCard key={b.id} item={b} settings={mine.settings} onCancel={setCancelling} onMove={() => {}} />
          ))}
        </>
      )}

      {cancelling && (
        <ConfirmModal
          title="Cancel this booking?"
          body={`${slotWhen(cancelling.starts_at)} for ${cancelling.registration}. The slot goes back to the workshop straight away.`}
          confirmLabel="Cancel booking"
          danger
          onConfirm={doCancel}
          onClose={() => setCancelling(null)}
        />
      )}
    </div>
  );
}

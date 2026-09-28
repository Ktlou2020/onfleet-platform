import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Badge, EmptyState, Loading } from '../../components/ui';
import { CalendarDays, ChevronLeft, ChevronRight, AlertTriangle, ArrowRight, UserX, Gauge } from 'lucide-react';

// The workshop's day.
//
// A booking is not a job card — a job card is work happening, and one gets
// opened here when the bike is actually wheeled in. Until then this is a
// diary: who is coming, when, and what they said is wrong with it.

const SAST = 'Africa/Johannesburg';
const todayInJohannesburg = () =>
  new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);

const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const longDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-ZA', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
};

const slotTime = (iso) => new Date(iso).toLocaleTimeString('en-ZA', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: SAST,
});

function BookingRow({ item, onArrive, onNoShow, busy }) {
  const nav = useNavigate();
  return (
    <div className="card" style={{ marginBottom: 10, borderColor: item.open_flags > 0 ? 'rgba(234,179,8,0.45)' : undefined }}>
      <div className="flex-between gap-3" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', minWidth: 0, flex: 1 }}>
          <div style={{
            minWidth: 62, textAlign: 'center', padding: '8px 6px', borderRadius: 10,
            background: 'var(--surface-2, rgba(127,127,127,0.1))', flexShrink: 0,
          }}>
            <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>{slotTime(item.starts_at)}</div>
            <div className="text-xs muted">30 min</div>
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
              <h3 style={{ marginBottom: 0 }}>{item.registration}</h3>
              <Badge status={item.status}>{String(item.status).replace(/_/g, ' ')}</Badge>
            </div>
            <div className="text-sm muted">
              {item.make} {item.model}
              {item.organization_name ? ` · ${item.organization_name}` : ''}
              {item.odometer_km != null && (
                <> · <Gauge size={12} style={{ display: 'inline', verticalAlign: -1 }} /> {Number(item.odometer_km).toLocaleString('en-ZA')} km</>
              )}
            </div>
            {item.note && (
              <p className="text-sm" style={{ marginTop: 8, marginBottom: 0 }}>
                <span className="muted">Rider says:</span> “{item.note}”
              </p>
            )}
            {item.open_flags > 0 && (
              <div className="row" style={{ gap: 6, alignItems: 'center', marginTop: 8, color: '#ca8a04' }}>
                <AlertTriangle size={14} />
                <span className="text-sm">
                  {item.open_flags} outstanding {item.open_flags === 1 ? 'note' : 'notes'} from the control room on this bike
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
          {item.status === 'booked' && (
            <>
              <button className="btn btn-sm" onClick={() => onArrive(item)} disabled={busy}>
                Bike arrived <ArrowRight size={14} />
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => onNoShow(item)} disabled={busy}>
                <UserX size={14} /> No-show
              </button>
            </>
          )}
          {item.job_card_id && (
            <button className="btn btn-secondary btn-sm" onClick={() => nav(`/workshop/app/job-cards/${item.job_card_id}`)}>
              Open job card
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function WorkshopCalendar() {
  const [date, setDate] = useState(todayInJohannesburg);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  const load = useCallback(async (forDate) => {
    setLoading(true);
    try {
      const { data: res } = await api.get(`/bookings/day?from=${forDate}`);
      setData(res);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load the day');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  const arrive = async (item) => {
    setBusy(true);
    try {
      const { data: res } = await api.post(`/bookings/${item.id}/arrive`);
      toast.success(`Job card opened for ${item.registration}`);
      nav(`/workshop/app/job-cards/${res.job_card_id}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not open a job card');
      load(date);
    } finally {
      setBusy(false);
    }
  };

  const noShow = async (item) => {
    setBusy(true);
    try {
      await api.post(`/bookings/${item.id}/no-show`);
      toast.success(`${item.registration} marked as a no-show`);
      await load(date);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not mark that');
    } finally {
      setBusy(false);
    }
  };

  const bookings = data?.bookings || [];
  const isToday = date === todayInJohannesburg();

  return (
    <div>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <h1 style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <CalendarDays size={22} /> Bookings
        </h1>
        {/* nowrap: the two arrows and the date are one control, and letting
            them stack turns the header into a column of buttons. */}
        <div className="row gap-2" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setDate((d) => addDays(d, -1))} aria-label="Previous day">
            <ChevronLeft size={16} />
          </button>
          <input
            type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)}
            style={{ width: 150, flexShrink: 0 }}
          />
          <button className="btn btn-secondary btn-sm" onClick={() => setDate((d) => addDays(d, 1))} aria-label="Next day">
            <ChevronRight size={16} />
          </button>
          {!isToday && (
            <button className="btn btn-secondary btn-sm" onClick={() => setDate(todayInJohannesburg())}>Today</button>
          )}
        </div>
      </div>

      <p className="muted" style={{ marginTop: -6, marginBottom: 18 }}>
        {longDay(date)} — {bookings.length} {bookings.length === 1 ? 'booking' : 'bookings'}
      </p>

      {loading ? <Loading /> : bookings.length === 0 ? (
        <EmptyState
          title="Nothing booked for this day"
          sub={isToday ? 'Walk-ins can still be registered from Job cards.' : 'Try another date.'}
        />
      ) : (
        bookings.map((b) => (
          <BookingRow key={b.id} item={b} onArrive={arrive} onNoShow={noShow} busy={busy} />
        ))
      )}
    </div>
  );
}

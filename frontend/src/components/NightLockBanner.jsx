import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { Lock, Unlock, Phone, Loader2 } from 'lucide-react';
import SupportContact from './SupportContact';

// A rider standing next to a bike that will not start.
//
// It is after midnight, they have finished a shift, and their motorcycle is
// immobilised because the overnight lock found it parked. Everything about
// this is written for that moment: it is at the top of every page rather than
// on the dashboard, because somebody in the dark does not scroll or navigate;
// the button says what it does in four words; and it is the only thing on the
// screen that is moving.
//
// It renders nothing at all the rest of the time, which is almost always.
//
// The other case it has to handle is the one where the rider cannot help
// themselves: a bike stopped for theft or arrears is not the overnight lock
// and the release will refuse it. Telling them to press a button that will
// say no is worse than telling them to call, so that case shows the number
// instead.

// Whether a rider is currently being shown something urgent. Read by the
// welcome tour so it does not cover the button that gets somebody home.
export function useNightLockUrgent() {
  const [urgent, setUrgent] = useState(() => urgentNow);
  useEffect(() => {
    listeners.add(setUrgent);
    return () => listeners.delete(setUrgent);
  }, []);
  return urgent;
}

let urgentNow = false;
const listeners = new Set();
function setUrgentState(value) {
  if (urgentNow === value) return;
  urgentNow = value;
  for (const listener of listeners) listener(value);
}

export default function NightLockBanner() {
  const [state, setState] = useState(null);
  const [releasing, setReleasing] = useState(false);

  const check = useCallback(async () => {
    try {
      const { data } = await api.get('/tracking/night-lock/mine');
      setState(data);
      setUrgentState(!!data?.bike && (!!data.night_locked || !!data.stopped_for_another_reason));
    } catch {
      // A rider with no bike, or an endpoint that is unhappy, gets a page
      // without a banner rather than an error about something they were not
      // asking about.
      setState(null);
      setUrgentState(false);
    }
  }, []);

  useEffect(() => {
    check();
    // Checked again when the phone comes back to the rider's hand. They will
    // have had the app open in a pocket while the clock passed midnight, and
    // the first they know of it is walking out to the bike.
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [check]);

  const release = async () => {
    setReleasing(true);
    try {
      const { data } = await api.post('/tracking/night-lock/release');
      toast.success(`${data.registration} unlocked — you are good to ride`);
      setState((s) => ({ ...s, night_locked: false, released_until: data.released_until }));
      setUrgentState(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not unlock it. Call the control room.');
      check();
    } finally {
      setReleasing(false);
    }
  };

  if (!state?.bike) return null;

  // Stopped for a reason a rider cannot undo. No button, because a button
  // that refuses is worse than a telephone number.
  if (state.stopped_for_another_reason) {
    return (
      <div className="card" style={{
        marginBottom: 16, borderColor: 'rgba(239,68,68,0.5)', background: 'rgba(239,68,68,0.06)',
      }}>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <Lock size={20} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1 }}>
            <strong>{state.bike.registration} has been stopped</strong>
            <p className="text-sm muted" style={{ margin: '4px 0 10px' }}>
              This is not the overnight lock, so it is not something you can undo from here.
              Call and somebody will help you now.
            </p>
            <SupportContact compact title="Call the control room" />
          </div>
        </div>
      </div>
    );
  }

  if (!state.night_locked) return null;

  return (
    <div className="card" style={{
      marginBottom: 16, borderColor: 'rgba(255,182,39,0.55)', background: 'rgba(255,182,39,0.07)',
    }}>
      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Lock size={22} style={{ color: 'var(--warn)', flexShrink: 0 }} />
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <strong style={{ fontSize: 16 }}>{state.bike.registration} is locked for the night</strong>
          <div className="text-sm muted">
            Bikes are locked between midnight and 4am. If you are working, unlock it here —
            it stays unlocked until the morning.
          </div>
        </div>
        <button
          className="btn"
          onClick={release}
          disabled={releasing}
          // Big enough to hit with cold hands in the dark, and the only thing
          // on the screen asking to be pressed.
          style={{ minHeight: 48, fontSize: 16, paddingInline: 22, flex: '0 0 auto' }}
        >
          {releasing
            ? <Loader2 size={17} style={{ animation: 'spin 0.7s linear infinite' }} />
            : <Unlock size={17} />}
          {releasing ? 'Unlocking…' : 'Unlock my bike'}
        </button>
      </div>
      <div className="text-xs muted" style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
        <Phone size={11} /> If it still will not start after unlocking, call the control room.
      </div>
    </div>
  );
}

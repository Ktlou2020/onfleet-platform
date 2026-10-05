'use strict';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Unlock, RefreshCw, Phone, Moon, ShieldCheck, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api';
import { EmptyState, formatPhoneDisplay } from './ui';

const SAST = { timeZone: 'Africa/Johannesburg' };
const fmtTime = (d) => d
  ? new Date(d).toLocaleString('en-ZA', { ...SAST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  : '—';
const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;

// Long enough not to hammer the endpoint, short enough that two people
// working the same list do not both ring the same rider.
const POLL_MS = 30_000;

/**
 * Tonight's locked bikes, with the one thing the control room needs at two in
 * the morning: a rider's name, a number to ring, and a button that puts the
 * bike back on the road.
 *
 * The same board serves the control room (its own screen) and the admin
 * dashboard (a panel), because the release flow should exist once. Admins
 * additionally get the on/off switch; the control room can let a bike out but
 * cannot decide to stop locking the fleet.
 */
export default function NightLockBoard({ variant = 'console', canToggle = false }) {
  const panel = variant === 'panel';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [releasing, setReleasing] = useState(new Set());
  const [toggling, setToggling] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const { data: body } = await api.get('/tracking/night-lock');
      if (alive.current) setData(body);
    } catch (err) {
      if (!quiet) toast.error(err.response?.data?.error || 'Could not load locked bikes');
    } finally {
      if (alive.current && !quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(() => load({ quiet: true }), POLL_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  // One click. The alerts queue taught us that anything needing typed text at
  // this hour simply does not get used, and releasing a bike is the safe
  // direction — it puts a stopped motorcycle back on the road. Who pressed it
  // is in the audit log either way.
  const release = useCallback(async (bike) => {
    setReleasing((prev) => new Set(prev).add(bike.bike_id));
    try {
      await api.post(`/tracking/night-lock/${bike.bike_id}/release`);
      toast.success(`${bike.registration || 'Bike'} released until ${fmtHour(data?.window?.end_hour ?? 4)}`);
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not release that bike');
      await load({ quiet: true });
    } finally {
      setReleasing((prev) => { const next = new Set(prev); next.delete(bike.bike_id); return next; });
    }
  }, [data, load]);

  const toggle = useCallback(async (enabled) => {
    setToggling(true);
    try {
      const { data: body } = await api.put('/tracking/night-lock', { enabled });
      setData((prev) => (prev ? { ...prev, enabled: body.enabled } : prev));
      toast.success(enabled
        ? 'Overnight lock on — bikes standing still are locked at midnight'
        : 'Overnight lock off — no bikes will be locked tonight');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not change that setting');
    } finally {
      setToggling(false);
    }
  }, []);

  const locked = data?.locked || [];
  const released = data?.released || [];
  const windowLabel = data?.window
    ? `${fmtHour(data.window.start_hour)}–${fmtHour(data.window.end_hour)}`
    : '00:00–04:00';

  // The lock reuses the curfew's rule for which bikes it may touch, and that
  // rule fails closed. Switched on with the curfew off, it locks nothing —
  // and a screen reading "Armed" over a fleet that will never be locked is
  // worse than one that says plainly that it is doing nothing.
  const blockedByCurfew = !!data?.enabled && data?.curfew_enabled === false;

  const statusChip = (() => {
    if (!data) return null;
    if (!data.enabled) return { text: 'Off', color: 'var(--muted)', note: 'No bikes are being locked' };
    if (blockedByCurfew) return { text: 'Not locking', color: 'var(--danger)', note: 'The night curfew is off' };
    if (data.in_window) return { text: 'Locking now', color: 'var(--warn)', note: `Window ${windowLabel} SAST` };
    return { text: 'Armed', color: 'var(--success)', note: `Locks again at ${fmtHour(data.window?.start_hour ?? 0)} SAST` };
  })();

  const curfewWarning = blockedByCurfew && (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8,
      border: '1px solid var(--danger)', background: 'rgba(229,57,53,0.08)', fontSize: 13,
    }}>
      <AlertTriangle size={15} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />
      <div>
        <strong>Switched on, but nothing will be locked.</strong>{' '}
        The overnight lock decides which bikes it may touch using the night curfew&apos;s rule, and the
        curfew is off. Turn the curfew on under GPS Tracking and this starts working at the next midnight.
      </div>
    </div>
  );

  const lockedTable = (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Bike</th>
            <th>Rider</th>
            <th>Phone</th>
            {!panel && <th>Fleet</th>}
            <th>Locked at</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {locked.map((bike) => (
            <tr key={bike.bike_id}>
              <td>
                <div style={{ fontWeight: 600 }}>{bike.registration || `Bike ${bike.bike_id}`}</div>
                <div className="muted text-xs">{[bike.make, bike.model].filter(Boolean).join(' ') || '—'}</div>
              </td>
              <td>{bike.rider_name || <span className="muted">No active agreement</span>}</td>
              <td>
                {bike.rider_phone ? (
                  <a href={`tel:${bike.rider_phone}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Phone size={12} /> {formatPhoneDisplay(bike.rider_phone)}
                  </a>
                ) : <span className="muted">—</span>}
              </td>
              {!panel && <td className="muted text-sm">{bike.fleet || '—'}</td>}
              <td className="text-sm">{fmtTime(bike.night_locked_at)}</td>
              <td style={{ textAlign: 'right' }}>
                <button
                  className="btn btn-sm"
                  disabled={releasing.has(bike.bike_id)}
                  onClick={() => release(bike)}
                >
                  <Unlock size={12} /> {releasing.has(bike.bike_id) ? 'Releasing…' : 'Release'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const releasedList = released.length > 0 && (
    <div className={panel ? 'mt-4' : 'card'} style={panel ? undefined : { margin: 16, marginTop: 0 }}>
      <h3 className="mb-2" style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ShieldCheck size={14} color="var(--success)" /> Let out tonight ({released.length})
      </h3>
      <div className="muted text-xs mb-2">
        These bikes have a pass until {fmtHour(data?.window?.end_hour ?? 4)} SAST. They will be covered again tomorrow night without anyone switching anything back.
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Bike</th><th>Rider</th><th>Phone</th><th>Pass until</th></tr></thead>
          <tbody>
            {released.map((bike) => (
              <tr key={bike.bike_id}>
                <td>{bike.registration || `Bike ${bike.bike_id}`}</td>
                <td>{bike.rider_name || <span className="muted">—</span>}</td>
                <td>
                  {bike.rider_phone
                    ? <a href={`tel:${bike.rider_phone}`}>{formatPhoneDisplay(bike.rider_phone)}</a>
                    : <span className="muted">—</span>}
                </td>
                <td className="text-sm">{fmtTime(bike.night_lock_released_until)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const emptyBody = (
    <EmptyState
      title={data?.enabled ? 'Nothing locked right now' : 'The overnight lock is off'}
      sub={data?.enabled
        ? `Bikes standing still at ${fmtHour(data?.window?.start_hour ?? 0)} SAST are locked until ${fmtHour(data?.window?.end_hour ?? 4)}. A rider who is out late can release their own bike from the app, or you can release it here.`
        : 'Nothing is being locked at midnight. Turn it on to immobilise parked bikes overnight.'}
    />
  );

  const toggleControl = canToggle && data && (
    <button
      className={`btn btn-sm ${data.enabled ? 'btn-secondary' : ''}`}
      disabled={toggling}
      onClick={() => toggle(!data.enabled)}
    >
      {data.enabled ? <><Unlock size={12} /> Turn off</> : <><Lock size={12} /> Turn on</>}
    </button>
  );

  // The dashboard panel. Sits in a card with the rest of the admin screens
  // rather than taking over the page, because most nights it says "none".
  if (panel) {
    return (
      <div className="card mb-4">
        <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Moon size={16} color="var(--accent)" /> Overnight lock
              {statusChip && (
                <span className="text-xs" style={{ color: statusChip.color, fontWeight: 700 }}>· {statusChip.text}</span>
              )}
            </h3>
            <div className="muted text-sm">
              {loading ? 'Loading…'
                : locked.length
                  ? `${locked.length} bike${locked.length === 1 ? '' : 's'} locked${released.length ? ` · ${released.length} let out tonight` : ''}`
                  : statusChip?.note || 'Parked bikes are immobilised between midnight and 04:00 SAST.'}
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {toggleControl}
            <button className="btn btn-sm btn-secondary" onClick={() => load()} disabled={loading}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>
        {curfewWarning && <div className="mt-3">{curfewWarning}</div>}
        {locked.length > 0 && <div className="mt-3">{lockedTable}</div>}
        {releasedList}
      </div>
    );
  }

  // The control room's own screen — a full pane inside the portal shell.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', flexShrink: 0,
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
          <Moon size={14} color="var(--accent)" /> Locked bikes
        </span>
        {statusChip && (
          <span style={{ fontSize: 11, color: statusChip.color, fontWeight: 700 }}>
            {statusChip.text}
            <span className="muted" style={{ fontWeight: 400 }}> · {statusChip.note}</span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span className="muted text-xs">
          {locked.length} locked{released.length ? ` · ${released.length} let out` : ''}
        </span>
        {toggleControl}
        <button className="btn btn-sm btn-secondary" onClick={() => load()} disabled={loading}>
          <RefreshCw size={11} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {curfewWarning && <div style={{ padding: '16px 16px 0' }}>{curfewWarning}</div>}
        {loading && !data ? (
          <div className="muted" style={{ padding: 24, fontSize: 13 }}>Loading…</div>
        ) : locked.length ? (
          <div style={{ padding: 16 }}>{lockedTable}</div>
        ) : (
          <div style={{ padding: 16 }}>{emptyBody}</div>
        )}
        {releasedList}
      </div>
    </div>
  );
}

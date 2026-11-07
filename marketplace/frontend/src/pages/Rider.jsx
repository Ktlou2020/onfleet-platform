import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { BRAND, Empty, Spinner, api, getToken, rand, useAuth, useMeta, useToast } from '../lib.jsx';
import { VerifyAge } from './Checkout.jsx';
import { MapTiles, pin } from './Address.jsx';
import '../rider.css';
import { InstallBanner, PushButton } from '../pwa.jsx';

// ---- Helpers ----------------------------------------------------------------

const googleNav = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;
const wazeNav = (p) => `https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes`;
const km = (n) => (n == null ? '–' : `${n < 10 ? n.toFixed(1) : Math.round(n)} km`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const mins = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);

const RETURN_REASONS = [
  ['no_answer', "Customer isn't answering", 'Wait 5 minutes after arriving and try calling first.'],
  ['id_failed', "Customer can't show a valid ID", 'No ID, no handover. Every time.'],
  ['underage', 'Customer is under 18', 'Do not hand over. Stay polite and leave.'],
  ['refused', 'Customer refused the order', ''],
  ['unsafe', "Drop-off doesn't feel safe", 'Your safety comes first. Leave and tell us.'],
  ['other', 'Something else', ''],
];

const PROBLEMS = [
  ['store_delay', 'Store is taking long'],
  ['accident', "I've been in an accident"],
  ['vehicle', 'Vehicle broke down'],
  ['customer_issue', 'Problem with the customer'],
  ['other', 'Something else'],
];

// One shared audio context, unlocked by the "Go online" tap so offers can
// make a sound later without another tap.
let audioCtx;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio */ }
}
function chime() {
  try {
    if (!audioCtx) return;
    [0, 0.18, 0.36].forEach((t, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = [660, 880, 1100][i];
      g.gain.setValueAtTime(0.25, audioCtx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t);
      o.stop(audioCtx.currentTime + t + 0.17);
    });
  } catch { /* no audio */ }
  try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch { /* no vibration */ }
}

// Keep the screen on while online, like a navigation app.
function useWakeLock(active) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return undefined;
    let lock;
    let gone = false;
    const take = () => navigator.wakeLock.request('screen').then((l) => { if (gone) l.release(); else lock = l; }).catch(() => {});
    take();
    const onVisible = () => document.visibilityState === 'visible' && take();
    document.addEventListener('visibilitychange', onVisible);
    return () => { gone = true; lock?.release?.(); document.removeEventListener('visibilitychange', onVisible); };
  }, [active]);
}

// Live Drive data: Server-Sent Events, with a poll as the fallback.
function useDrive() {
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/rider/jobs').then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
    let es;
    let poll;
    const startPoll = () => { clearInterval(poll); poll = setInterval(load, 5000); };
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(`/api/rider/stream?token=${encodeURIComponent(getToken() || '')}`);
      es.onmessage = (e) => setData(JSON.parse(e.data));
      es.onerror = () => { es.close(); startPoll(); };
    } else startPoll();
    // Belt and braces: a slow refresh even with the stream, for countdowns
    // that ran out while the phone was asleep.
    const slow = setInterval(load, 15000);
    return () => { es?.close(); clearInterval(poll); clearInterval(slow); };
  }, [load]);
  return { data, setData, load };
}

// ---- Map ----------------------------------------------------------------

function Follow({ point, bounds }) {
  const map = useMap();
  const key = bounds ? bounds.map((p) => p.join(',')).join('|') : point ? `${point.lat.toFixed(4)},${point.lng.toFixed(4)}` : '';
  useEffect(() => {
    if (bounds && bounds.length > 1) map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
    else if (point) map.setView([point.lat, point.lng], Math.max(map.getZoom(), 14));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function DriveMap({ me, job, offer, spots, showSpots }) {
  const target = job ? (job.status === 'picked_up' ? job.dropoff : job.store) : null;
  const bounds = useMemo(() => {
    const pts = [];
    if (me) pts.push([me.lat, me.lng]);
    if (job) { pts.push([job.store.lat, job.store.lng]); if (job.status === 'picked_up') pts.push([job.dropoff.lat, job.dropoff.lng]); }
    if (offer) { pts.push([offer.store.lat, offer.store.lng]); pts.push([offer.dropoffArea.lat, offer.dropoffArea.lng]); }
    return pts.length > 1 ? pts : null;
  }, [me, job, offer]);
  const center = me || job?.store || { lat: -26.1076, lng: 28.0567 };
  return (
    <MapContainer center={[center.lat, center.lng]} zoom={14} zoomControl={false} attributionControl style={{ height: '100%' }}>
      <MapTiles />
      {showSpots && spots.map((s) => (
        <CircleMarker key={s.id} center={[s.lat, s.lng]} radius={s.level === 'high' ? 26 : s.level === 'medium' ? 18 : 10}
          pathOptions={{ color: 'transparent', fillColor: s.level === 'high' ? '#e53e3e' : s.level === 'medium' ? '#dd6b20' : '#38a169', fillOpacity: 0.28 }}>
          <Tooltip direction="top">{s.name}{s.waiting ? ` · ${s.waiting} waiting` : ''}</Tooltip>
        </CircleMarker>
      ))}
      {job && <Marker position={[job.store.lat, job.store.lng]} icon={pin('🏪')} />}
      {job?.status === 'picked_up' && <Marker position={[job.dropoff.lat, job.dropoff.lng]} icon={pin('🏠', 'home')} />}
      {offer && <Marker position={[offer.store.lat, offer.store.lng]} icon={pin('🏪')} />}
      {offer && <CircleMarker center={[offer.dropoffArea.lat, offer.dropoffArea.lng]} radius={30} pathOptions={{ color: '#2f855a', fillOpacity: 0.12, dashArray: '4 6' }} />}
      {me && <Marker position={[me.lat, me.lng]} icon={pin('🛵', 'rider')} />}
      {me && target && <Polyline positions={[[me.lat, me.lng], [target.lat, target.lng]]} pathOptions={{ color: '#1a202c', weight: 5, opacity: 0.75, dashArray: '1 10', lineCap: 'round' }} />}
      <Follow point={me} bounds={bounds} />
    </MapContainer>
  );
}

// ---- Offer -----------------------------------------------------------------

function OfferCard({ offer, onAccept, onDecline, busy }) {
  const deadline = useRef(null);
  const [left, setLeft] = useState(offer.secondsLeft);
  useEffect(() => {
    deadline.current = Date.now() + offer.secondsLeft * 1000;
    chime();
    const t = setInterval(() => setLeft(Math.max(0, (deadline.current - Date.now()) / 1000)), 200);
    return () => clearInterval(t);
  }, [offer.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const frac = Math.max(0, Math.min(1, left / offer.offerSeconds));
  const R = 34;
  const C = 2 * Math.PI * R;
  return (
    <div className="r-offer" role="alertdialog" aria-label="New trip offer">
      <div className="r-offer-top">
        <div>
          <p className="r-eyebrow">New trip · {offer.storeReady ? 'ready now' : 'being packed'}</p>
          <p className="r-offer-pay">{rand(offer.totalCents)}</p>
          <p className="r-muted">{offer.tipCents ? <>includes {rand(offer.tipCents)} tip 🎉</> : 'tip may be added'}</p>
        </div>
        <svg className="r-ring" width="84" height="84" viewBox="0 0 84 84" aria-label={`${Math.ceil(left)} seconds left`}>
          <circle cx="42" cy="42" r={R} className="r-ring-bg" />
          <circle cx="42" cy="42" r={R} className={`r-ring-fg ${left < 8 ? 'low' : ''}`} strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 42 42)" />
          <text x="42" y="49" textAnchor="middle">{Math.ceil(left)}</text>
        </svg>
      </div>
      <div className="r-offer-facts">
        <div><strong>{mins(offer.estMinutes)}</strong><span>total time</span></div>
        <div><strong>{km(offer.totalKm)}</strong><span>total distance</span></div>
        <div><strong>{offer.itemCount}</strong><span>items</span></div>
      </div>
      <ol className="r-legs">
        <li><span className="dot store" /> <div><strong>{offer.store.name}</strong><p className="r-muted">{km(offer.pickupKm)} away · {offer.store.address}</p></div></li>
        <li><span className="dot drop" /> <div><strong>Drop-off</strong><p className="r-muted">{km(offer.dropoffKm)} from the store · exact address after you accept</p></div></li>
      </ol>
      <div className="r-offer-actions">
        <button className="r-btn ghost" onClick={onDecline} disabled={busy}>Decline</button>
        <button className="r-btn primary grow" onClick={onAccept} disabled={busy || left <= 0}>Accept trip</button>
      </div>
    </div>
  );
}

// ---- The trip ------------------------------------------------------------

function NavButtons({ to }) {
  return (
    <div className="r-nav">
      <a className="r-btn ghost" href={googleNav(to)} target="_blank" rel="noreferrer">🧭 Google Maps</a>
      <a className="r-btn ghost" href={wazeNav(to)} target="_blank" rel="noreferrer">🚙 Waze</a>
    </div>
  );
}

function Checklist({ items, ticked, setTicked }) {
  return (
    <ul className="r-checklist">
      {items.map((i) => {
        const on = ticked.includes(i.product_id);
        return (
          <li key={i.product_id}>
            <label className={on ? 'on' : ''}>
              <input type="checkbox" checked={on} onChange={() => setTicked((t) => (on ? t.filter((x) => x !== i.product_id) : [...t, i.product_id]))} />
              <span className="r-qty">{i.qty}×</span> {i.name}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function ReturnSheet({ job, onClose, run }) {
  const arrivedAt = job.milestones.arrivedCustomerAt ? new Date(job.milestones.arrivedCustomerAt.replace(' ', 'T') + 'Z').getTime() : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const waitLeft = arrivedAt ? Math.max(0, 300 - Math.floor((now - arrivedAt) / 1000)) : 300;
  return (
    <Sheet title="Can't deliver this order?" onClose={onClose}>
      <p className="r-muted">The order goes back to {job.store.name}. You're still paid for the trip.</p>
      {RETURN_REASONS.map(([key, label, hint]) => {
        const waiting = key === 'no_answer' && waitLeft > 0;
        return (
          <button key={key} className="r-option" disabled={waiting} onClick={() => run(`/rider/jobs/${job.id}/return`, { reason: key }).then(onClose)}>
            <strong>{label}</strong>
            {waiting ? <span className="r-muted">Available in {Math.floor(waitLeft / 60)}:{String(waitLeft % 60).padStart(2, '0')} — call the customer meanwhile</span> : hint && <span className="r-muted">{hint}</span>}
          </button>
        );
      })}
    </Sheet>
  );
}

// Reads the barcode on the bag's slip with the camera, where the phone's
// browser can (Chrome on Android). Otherwise the rider types the 4 characters.
function BagScanner({ onCode, onClose }) {
  const video = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stream;
    let stop = false;
    (async () => {
      try {
        const detector = new window.BarcodeDetector({ formats: ['code_128'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.current.srcObject = stream;
        await video.current.play();
        while (!stop) {
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) { onCode(found[0].rawValue); return; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch { setError("Couldn't open the camera — type the code instead"); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return (
    <Sheet title="Scan the bag" onClose={onClose}>
      {error ? <p className="r-muted">{error}</p> : <video ref={video} className="r-scan" playsInline muted />}
      <p className="r-muted small">Point the camera at the barcode on the slip.</p>
    </Sheet>
  );
}
const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

function TripPanel({ job, run, busy, onProblem }) {
  const [ticked, setTicked] = useState([]);
  const [code, setCode] = useState('');
  const [idChecked, setIdChecked] = useState(false);
  const [returning, setReturning] = useState(false);
  const [bagCode, setBagCode] = useState('');
  const [scanning, setScanning] = useState(false);
  useEffect(() => { setTicked([]); setCode(''); setIdChecked(false); setBagCode(''); }, [job.id]);
  const items = job.items.filter((i) => !i.unavailable);

  const m = job.milestones;
  const toStore = job.status !== 'picked_up';
  const allTicked = ticked.length === items.length;
  const step = toStore ? (m.arrivedStoreAt ? 2 : 1) : (m.arrivedCustomerAt ? 4 : 3);

  return (
    <div className="r-trip">
      <div className="r-steps">{['To store', 'Collect', 'To customer', 'Hand over'].map((s, i) => <span key={s} className={i + 1 < step ? 'done' : i + 1 === step ? 'on' : ''}>{s}</span>)}</div>
      <div className="r-trip-head">
        <div>
          <p className="r-eyebrow">#{job.code} · {rand(job.pay.totalCents)}{job.pay.tipCents ? ` incl. ${rand(job.pay.tipCents)} tip` : ''}</p>
          {step === 1 && <h2>Head to {job.store.name}</h2>}
          {step === 2 && <h2>{job.status === 'ready' ? 'Order is ready — collect it' : 'Store is packing your order'}</h2>}
          {step === 3 && <h2>Deliver to {job.customer.name}</h2>}
          {step === 4 && <h2>Hand over to {job.customer.name}</h2>}
          <p className="r-muted">{toStore ? job.store.address : job.dropoff.address}</p>
        </div>
        <button className="r-icon" onClick={onProblem} aria-label="Report a problem">⋯</button>
      </div>

      {step === 1 && (
        <>
          <NavButtons to={job.store} />
          <button className="r-btn primary full" disabled={busy} onClick={() => run(`/rider/jobs/${job.id}/arrived-store`)}>I've arrived at the store</button>
        </>
      )}

      {step === 2 && (
        <>
          <p className="r-hint">Tick each item as the store hands it over.</p>
          <Checklist items={items} ticked={ticked} setTicked={setTicked} />
          {job.sealed && <p className="r-note">🔒 Sealed 18+ bag — don't open it. Check the seal is intact.</p>}
          {job.status !== 'ready' && <p className="r-wait"><span className="r-pulse" /> Waiting for the store to mark it ready…</p>}
          {job.status === 'ready' && (
            <label className="r-field">
              <span>Bag code — last 4 characters on the slip</span>
              <div className="r-row bag-row">
                <input className="r-code small-code" value={bagCode} maxLength={4} autoCapitalize="characters" autoComplete="off" onChange={(e) => setBagCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} aria-label="Bag code" />
                {canScan && <button type="button" className="r-btn ghost" onClick={() => setScanning(true)}>📷 Scan</button>}
              </div>
            </label>
          )}
          <button className="r-btn primary full" disabled={busy || job.status !== 'ready' || !allTicked || bagCode.length < 4} onClick={() => run(`/rider/jobs/${job.id}/pickup`, { bagCode })}>
            {job.status !== 'ready' ? 'Waiting for the store' : !allTicked ? `Tick all ${items.length} items` : bagCode.length < 4 ? 'Enter the bag code' : 'I have everything — start delivery'}
          </button>
          {scanning && <BagScanner onClose={() => setScanning(false)} onCode={(v) => { setBagCode(v.slice(-4).toUpperCase()); setScanning(false); }} />}
        </>
      )}

      {step === 3 && (
        <>
          {job.notes && <p className="r-note">📝 {job.notes}</p>}
          <NavButtons to={job.dropoff} />
          <div className="r-row">
            {job.customer.phone && <a className="r-btn ghost grow" href={`tel:${job.customer.phone}`}>📞 Call {job.customer.name}</a>}
            {job.customer.phone && <a className="r-btn ghost grow" href={`sms:${job.customer.phone}?body=${encodeURIComponent(`Hi, it's your ${BRAND.name} rider — I'm nearly there.`)}`}>💬 Text</a>}
          </div>
          <button className="r-btn primary full" disabled={busy} onClick={() => run(`/rider/jobs/${job.id}/arrived`)}>I've arrived</button>
        </>
      )}

      {step === 4 && (
        <>
          {job.notes && <p className="r-note">📝 {job.notes}</p>}
          <label className="r-idcheck">
            <input type="checkbox" checked={idChecked} onChange={(e) => setIdChecked(e.target.checked)} />
            <span>I've seen a valid ID: the customer is <strong>18 or older</strong> and the name matches <strong>{job.customer.name}</strong>.</span>
          </label>
          <label className="r-field">
            <span>4-digit code from the customer's app</span>
            <input className="r-code" inputMode="numeric" autoComplete="one-time-code" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <button className="r-btn primary full" disabled={busy || !idChecked || code.length !== 4} onClick={() => run(`/rider/jobs/${job.id}/deliver`, { handoverCode: code, idChecked })}>Complete delivery</button>
          <div className="r-row">
            {job.customer.phone && <a className="r-btn ghost grow" href={`tel:${job.customer.phone}`}>📞 Call</a>}
            <button className="r-btn ghost grow" onClick={() => setReturning(true)}>Can't deliver?</button>
          </div>
        </>
      )}
      {returning && <ReturnSheet job={job} onClose={() => setReturning(false)} run={run} />}
    </div>
  );
}

function TripDone({ trip, onClose }) {
  const returned = trip.status === 'returned';
  return (
    <div className="r-done">
      <div className="r-done-burst">{returned ? '↩️' : '✅'}</div>
      <h2>{returned ? 'Returned to store' : 'Delivered!'}</h2>
      <p className="r-done-pay">+{rand(trip.pay.totalCents)}</p>
      <div className="r-done-split">
        <div><span>Trip pay</span><strong>{rand(trip.pay.payoutCents)}</strong></div>
        <div><span>Tip</span><strong>{trip.pay.tipCents ? rand(trip.pay.tipCents) : '–'}</strong></div>
        <div><span>Distance</span><strong>{km((trip.pay.pickupKm || 0) + trip.distanceKm)}</strong></div>
      </div>
      {returned && <p className="r-muted">Take the order back to {trip.store.name}. Thanks for keeping it safe and legal.</p>}
      <button className="r-btn primary full" onClick={onClose}>{returned ? 'Done' : 'Find next trip'}</button>
    </div>
  );
}

// ---- Sheets ---------------------------------------------------------------

function Sheet({ title, children, onClose }) {
  return (
    <div className="r-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="r-sheet" role="dialog" aria-label={title}>
        <div className="r-sheet-handle" />
        <div className="r-row between"><h3>{title}</h3><button className="r-icon" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

function SafetySheet({ onClose, job, me }) {
  const notify = useToast();
  const [sent, setSent] = useState(false);
  const report = async (type, note) => {
    try {
      await api('/rider/incidents', { method: 'POST', body: { type, note, orderId: job?.id, lat: me?.lat, lng: me?.lng } });
      notify(type === 'sos' ? 'SOS sent — our team has your location' : 'Reported — thanks', 'ok');
      if (type === 'sos') setSent(true); else onClose();
    } catch (e) { notify(e.message, 'bad'); }
  };
  return (
    <Sheet title="Safety & help" onClose={onClose}>
      <div className="r-sos-grid">
        <a className="r-sos police" href="tel:10111"><strong>10111</strong><span>Police (SAPS)</span></a>
        <a className="r-sos medic" href="tel:10177"><strong>10177</strong><span>Ambulance</span></a>
      </div>
      <button className={`r-btn danger full ${sent ? 'sent' : ''}`} onClick={() => report('sos', 'Rider pressed SOS')} disabled={sent}>
        {sent ? '✓ SOS sent with your location' : `🚨 Send SOS to ${BRAND.name}`}
      </button>
      <h4 className="r-sub">Report a problem</h4>
      {PROBLEMS.map(([type, label]) => <button key={type} className="r-option" onClick={() => report(type, label)}><strong>{label}</strong></button>)}
      <p className="r-muted small">Support: {BRAND.support}</p>
    </Sheet>
  );
}

// ---- Drive tab ---------------------------------------------------------------

function Drive({ drive, me, setMe, demo }) {
  const { data, setData, load } = drive;
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [safety, setSafety] = useState(false);
  const [spots, setSpots] = useState([]);
  const [boardOpen, setBoardOpen] = useState(false);

  const online = !!data?.rider.online;
  const paused = !!data?.rider.paused;
  const job = data?.current[0] || null;
  const offer = !job ? data?.offer : null;
  useWakeLock(online);

  useEffect(() => {
    if (job || offer) return undefined;
    const get = () => api('/rider/demand').then((d) => setSpots(d.spots)).catch(() => {});
    get();
    const t = setInterval(get, 30000);
    return () => clearInterval(t);
  }, [job, offer, online]);

  const run = useCallback(async (path, body) => {
    setBusy(true);
    try {
      const d = await api(path, { method: 'POST', body: body || {} });
      if (d.completed) setDone(d.completed);
      setData(d);
      return d;
    } catch (e) {
      notify(e.message, 'bad');
      load();
      throw e;
    } finally {
      setBusy(false);
    }
  }, [notify, setData, load]);

  const goOnline = () => {
    unlockAudio();
    run('/rider/status', { online: true, ...(me || {}) }).then(() => notify("You're online — trips will come to you", 'ok')).catch(() => {});
  };

  // Demo only: step 35% of the way to the next stop.
  const simulate = async () => {
    const target = job ? (job.status === 'picked_up' ? job.dropoff : job.store) : spots[0];
    if (!target) return;
    const from = me || target;
    const next = { lat: from.lat + (target.lat - from.lat) * 0.35, lng: from.lng + (target.lng - from.lng) * 0.35 };
    setMe(next);
    await api('/rider/location', { method: 'POST', body: next }).catch(() => {});
  };

  if (!data) return <div className="r-center"><Spinner /></div>;

  return (
    <div className="r-drive">
      <div className="r-map">
        <DriveMap me={me} job={job} offer={offer} spots={spots} showSpots={!job && !offer} />
        <div className="r-topbar">
          <span className={`r-status ${online ? (paused ? 'paused' : 'on') : ''}`}>{online ? (paused ? '⏸ Paused' : '● Online') : 'Offline'}</span>
          <span className="r-chip">Today {rand(data.today.earningsCents)}</span>
        </div>
        <div className="r-fabs">
          <button className="r-fab safety" onClick={() => setSafety(true)} aria-label="Safety and help">🛡️</button>
          {demo && online && <button className="r-fab" onClick={simulate} title="Demo: move the rider">▶</button>}
        </div>
      </div>

      <div className="r-panel">
        {done ? <TripDone trip={done} onClose={() => setDone(null)} />
          : job ? <TripPanel job={job} run={run} busy={busy} onProblem={() => setSafety(true)} />
            : offer ? <OfferCard offer={offer} busy={busy} onAccept={() => run(`/rider/offers/${offer.id}/accept`).catch(() => {})} onDecline={() => run(`/rider/offers/${offer.id}/decline`).catch(() => {})} />
              : !online ? (
                <div className="r-offline">
                  <button className="r-go" onClick={goOnline} disabled={busy}>GO</button>
                  <h2>You're offline</h2>
                  <p className="r-muted">Go online to start getting trips. {spots.filter((s) => s.level !== 'low').length ? `${spots.filter((s) => s.level !== 'low').length} busy area${spots.filter((s) => s.level !== 'low').length > 1 ? 's' : ''} near you right now.` : ''}</p>
                  <TodayStrip today={data.today} />
                  <PushButton why="get trip offers with your screen off" className="r-push" />
                </div>
              ) : (
                <div className="r-waiting">
                  <div className="r-row between">
                    <div>
                      <h2>{paused ? 'New trips paused' : 'Finding trips'}{!paused && <span className="r-dots"><i /><i /><i /></span>}</h2>
                      <p className="r-muted">{paused ? "You're online but won't get offers." : 'Stay near the red areas for more offers.'}</p>
                    </div>
                  </div>
                  <TodayStrip today={data.today} />
                  <PushButton why="get trip offers with your screen off" className="r-push" />
                  {data.board.length > 0 && (
                    <div className="r-board">
                      <button className="r-board-toggle" onClick={() => setBoardOpen((x) => !x)}>
                        {data.board.length} trip{data.board.length > 1 ? 's' : ''} available nearby {boardOpen ? '▴' : '▾'}
                      </button>
                      {boardOpen && data.board.map((b) => (
                        <div key={b.id} className="r-board-item">
                          <div className="grow">
                            <strong>{b.storeName}</strong>
                            <p className="r-muted">{km(b.pickupKm)} to store · {km(b.dropoffKm)} to drop · {b.itemCount} items{b.storeReady ? ' · ready' : ''}</p>
                          </div>
                          <div className="r-board-pay"><strong>{rand(b.totalCents)}</strong><button className="r-btn primary sm" disabled={busy} onClick={() => run(`/rider/jobs/${b.id}/claim`).catch(() => {})}>Take</button></div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="r-row">
                    <button className="r-btn ghost grow" disabled={busy} onClick={() => run('/rider/status', { paused: !paused }).catch(() => {})}>{paused ? '▶ Resume trips' : '⏸ Pause new trips'}</button>
                    <button className="r-btn ghost grow" disabled={busy} onClick={() => run('/rider/status', { online: false }).catch(() => {})}>Go offline</button>
                  </div>
                </div>
              )}
      </div>
      {safety && <SafetySheet onClose={() => setSafety(false)} job={job} me={me} />}
    </div>
  );
}

function TodayStrip({ today }) {
  return (
    <div className="r-today">
      <div><strong>{rand(today.earningsCents)}</strong><span>earned today</span></div>
      <div><strong>{today.trips}</strong><span>trips</span></div>
      <div><strong>{mins(today.onlineMinutes)}</strong><span>online</span></div>
    </div>
  );
}

// ---- Earnings tab -------------------------------------------------------

function Earnings() {
  const [e, setE] = useState(null);
  useEffect(() => { api('/rider/earnings').then(setE).catch(() => setE(false)); }, []);
  if (e === null) return <div className="r-center"><Spinner /></div>;
  if (!e) return <Empty icon="📉" title="Couldn't load earnings" />;
  const max = Math.max(1, ...e.week.map((d) => d.payCents + d.tipsCents));
  const dayName = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-ZA', { weekday: 'short' });
  const perHour = e.today.onlineMinutes >= 10 ? Math.round(e.today.earningsCents / (e.today.onlineMinutes / 60)) : null;
  return (
    <div className="r-page">
      <p className="r-eyebrow">Last 7 days</p>
      <p className="r-big">{rand(e.weekTotalCents)}</p>
      <div className="r-bars">
        {e.week.map((d, i) => {
          const v = d.payCents + d.tipsCents;
          return (
            <div key={d.day} className={`r-bar ${i === 6 ? 'today' : ''}`} title={`${rand(v)} · ${plural(d.trips, 'trip')}`}>
              <span className="r-bar-val">{v ? rand(v).replace(/\.\d+$/, '') : ''}</span>
              <span className="r-bar-fill" style={{ height: `${(v / max) * 100}%` }}><i style={{ height: v ? `${(d.tipsCents / v) * 100}%` : 0 }} /></span>
              <span className="r-bar-day">{i === 6 ? 'Today' : dayName(d.day)}</span>
            </div>
          );
        })}
      </div>
      <p className="r-muted small"><span className="r-key pay" /> Trip pay <span className="r-key tip" /> Tips</p>

      <div className="r-tiles">
        <div><span>Today</span><strong>{rand(e.today.earningsCents)}</strong><em>{plural(e.today.trips, 'trip')}</em></div>
        <div><span>Per online hour</span><strong>{perHour ? rand(perHour) : '–'}</strong><em>{mins(e.today.onlineMinutes)} online</em></div>
        <div><span>Tips today</span><strong>{rand(e.today.tipsCents)}</strong><em>100% yours</em></div>
        <div><span>Rating</span><strong>{e.stats.rating ? `★ ${e.stats.rating.toFixed(1)}` : 'New'}</strong><em>{plural(e.stats.ratingCount, 'rating')}</em></div>
        <div><span>Acceptance</span><strong>{e.stats.acceptanceRate != null ? `${e.stats.acceptanceRate}%` : '–'}</strong><em>last 30 days</em></div>
        <div><span>Completion</span><strong>{e.stats.completionRate != null ? `${e.stats.completionRate}%` : '–'}</strong><em>{e.stats.lifetimeTrips} delivered</em></div>
      </div>

      <div className="r-card">
        <h3>How you're paid</h3>
        <p className="r-muted">{rand(e.payRates.baseCents)} per trip + {rand(e.payRates.perKmCents)} per km (to the store and on to the customer), at least {rand(e.payRates.minimumCents)}. Customer tips are added on top and are 100% yours. You see the full amount before you accept.</p>
      </div>

      <h3 className="r-sub">Recent trips</h3>
      {e.trips.length === 0 ? <Empty icon="🛵" title="No trips yet">Your completed trips will show here.</Empty> : (
        <div className="r-trips">
          {e.trips.map((t) => (
            <div key={t.id} className="r-trip-row">
              <div className="grow">
                <strong>{t.storeName}</strong>
                <p className="r-muted">{new Date(t.at.replace(' ', 'T') + 'Z').toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · {km(t.km)}{t.minutes != null ? ` · ${t.minutes} min` : ''}{t.status === 'returned' ? ' · returned' : ''}{t.rating ? ` · ★${t.rating}` : ''}</p>
              </div>
              <div className="r-right">
                <strong>{rand(t.totalCents)}</strong>
                {t.tipCents > 0 && <span className="r-tip">+{rand(t.tipCents)} tip</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Account tab ---------------------------------------------------------

function Account({ rider, onSaved }) {
  const { user, signOut } = useAuth();
  const notify = useToast();
  const [f, setF] = useState({ vehicle: rider.vehicle, plate: rider.plate || '', phone: user.phone || '' });
  const save = async (e) => {
    e.preventDefault();
    try {
      await api('/rider/profile', { method: 'PATCH', body: f });
      notify('Saved', 'ok');
      onSaved();
    } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <div className="r-page">
      <div className="r-profile">
        <div className="r-avatar">{user.name[0]}</div>
        <div>
          <h2>{user.name}</h2>
          <p className="r-muted">{rider.rating ? `★ ${rider.rating.toFixed(1)} · ${plural(rider.ratingCount, 'rating')}` : 'New rider'} · ID verified ✓</p>
        </div>
      </div>
      <form className="r-card" onSubmit={save}>
        <h3>Vehicle & contact</h3>
        <label className="r-field"><span>Vehicle</span>
          <select value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })}>
            {['motorbike', 'scooter', 'e-bike', 'bicycle', 'car'].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
          </select>
        </label>
        <label className="r-field"><span>Number plate</span><input value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} placeholder="e.g. CA 123-456" /></label>
        <label className="r-field"><span>Mobile number (customers see it only during a delivery)</span><input value={f.phone} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        <button className="r-btn primary full">Save</button>
      </form>
      <div className="r-card">
        <h3>App & alerts</h3>
        <InstallBanner audience="rider" />
        <PushButton why="trip offers" className="r-push" />
        <p className="r-muted small">Tip: keep ClickNPuff open on a phone mount while you ride — your location only updates while the app is on screen.</p>
      </div>
      <div className="r-card">
        <h3>Riding safely</h3>
        <ul className="r-tips-list">
          <li>Check ID on every delivery. No ID, no handover — you're still paid.</li>
          <li>Never hand over to someone under 18, or someone other than the customer.</li>
          <li>Feel unsafe? Leave, then tap 🛡️ on the map. Police: 10111 · Ambulance: 10177.</li>
          <li>Don't use your phone while riding. Accept trips when stopped.</li>
        </ul>
      </div>
      <button className="r-btn ghost full" onClick={signOut}>Sign out</button>
    </div>
  );
}

// ---- Shell -----------------------------------------------------------------

export default function Rider() {
  const { user } = useAuth();
  const meta = useMeta();
  const [tab, setTab] = useState('drive');
  const drive = useDrive();
  const [me, setMe] = useState(null);
  const lastSent = useRef(0);
  const online = !!drive.data?.rider.online;

  // Start from the last known position the server has.
  useEffect(() => {
    if (!me && drive.data?.rider.lat != null) setMe({ lat: drive.data.rider.lat, lng: drive.data.rider.lng });
  }, [drive.data, me]);

  // Share GPS while online, at most every 6 seconds.
  useEffect(() => {
    if (!online || !navigator.geolocation) return undefined;
    const id = navigator.geolocation.watchPosition((p) => {
      const fix = { lat: p.coords.latitude, lng: p.coords.longitude };
      setMe(fix);
      if (Date.now() - lastSent.current < 6000) return;
      lastSent.current = Date.now();
      api('/rider/location', { method: 'POST', body: fix }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [online]);

  if (!user.ageVerified) return <div className="page narrow"><h1>Rider setup</h1><VerifyAge /></div>;

  return (
    <div className="r-app">
      <div className="r-body">
        {tab === 'drive' && <Drive drive={drive} me={me} setMe={setMe} demo={!!meta?.demo} />}
        {tab === 'earnings' && <Earnings />}
        {tab === 'account' && drive.data && <Account rider={drive.data.rider} onSaved={drive.load} />}
      </div>
      <nav className="r-tabs">
        {[['drive', '🛵', 'Drive'], ['earnings', '💰', 'Earnings'], ['account', '👤', 'Account']].map(([k, icon, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{icon}<span>{label}</span></button>
        ))}
      </nav>
    </div>
  );
}

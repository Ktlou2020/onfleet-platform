import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, STATUS, Spinner, api, rand, useAuth, useMeta, useToast } from '../lib.jsx';
import { VerifyAge } from './Checkout.jsx';

const maps = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

function CurrentJob({ o, onChange, lastFix }) {
  const notify = useToast();
  const [code, setCode] = useState('');
  const [idChecked, setIdChecked] = useState(false);
  const meta = useMeta();
  const run = async (path, body) => {
    try { await api(`/rider/jobs/${o.id}/${path}`, { method: 'POST', body }); onChange(); } catch (e) { notify(e.message, 'bad'); }
  };
  const toDoor = o.status === 'picked_up';
  const target = toDoor ? o.dropoff : o.store;

  // Demo helper: step 30% of the way towards the next stop.
  const simulate = async () => {
    const from = lastFix.current || o.store;
    const lat = from.lat + (target.lat - from.lat) * 0.3;
    const lng = from.lng + (target.lng - from.lng) * 0.3;
    lastFix.current = { lat, lng };
    await api('/rider/location', { method: 'POST', body: { lat, lng } });
  };

  return (
    <div className="card job current">
      <div className="row-between">
        <span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span>
        <strong>#{o.code}</strong>
      </div>
      <div className="leg">
        <div className={!toDoor ? 'on' : 'done'}><span>1</span><div><strong>Collect at {o.store.name}</strong><p className="muted small">{o.store.address}</p></div></div>
        <div className={toDoor ? 'on' : ''}><span>2</span><div><strong>Deliver to {o.customer.name}</strong><p className="muted small">{o.dropoff.address}</p>{o.notes && <p className="small">📝 {o.notes}</p>}</div></div>
      </div>
      <ul className="pick-list">{o.items.map((i) => <li key={i.product_id}><strong>{i.qty}×</strong> {i.name}</li>)}</ul>
      <div className="actions">
        <a className="btn btn-ghost" href={maps(target.lat, target.lng)} target="_blank" rel="noreferrer">🧭 Navigate</a>
        {toDoor && o.customer.phone && <a className="btn btn-ghost" href={`tel:${o.customer.phone}`}>📞 Call</a>}
        {meta?.demo && <button className="btn btn-ghost" onClick={simulate}>▶ Simulate move</button>}
      </div>

      {['accepted', 'preparing'].includes(o.status) && <p className="banner">The store is packing — head over. You can collect once it's marked ready.</p>}
      {o.status === 'ready' && <button className="btn btn-lg full" onClick={() => run('pickup')}>I've collected the order</button>}
      {toDoor && (
        <div className="handover-form">
          <label className="check">
            <input type="checkbox" checked={idChecked} onChange={(e) => setIdChecked(e.target.checked)} />
            <span>I have checked an ID showing the customer is <strong>18 or older</strong> and the name matches <strong>{o.customer.name}</strong></span>
          </label>
          <label className="field">
            <span>Customer's 4-digit handover code</span>
            <input inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="code-input" />
          </label>
          <button className="btn btn-lg full" disabled={!idChecked || code.length !== 4} onClick={() => run('deliver', { handoverCode: code, idChecked })}>Complete delivery</button>
          <p className="muted small">No valid ID or code? Don't hand over. Call support and return the order to the store.</p>
        </div>
      )}
    </div>
  );
}

export default function Rider() {
  const { user } = useAuth();
  const notify = useToast();
  const [data, setData] = useState(null);
  const watch = useRef(null);
  const lastSent = useRef(0);
  const lastFix = useRef(null);

  const load = useCallback(() => api('/rider/jobs').then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const online = !!data?.rider?.online;

  // Share GPS while online, at most every 8 seconds.
  useEffect(() => {
    if (!online || !navigator.geolocation) return undefined;
    watch.current = navigator.geolocation.watchPosition((p) => {
      lastFix.current = { lat: p.coords.latitude, lng: p.coords.longitude };
      if (Date.now() - lastSent.current < 8000) return;
      lastSent.current = Date.now();
      api('/rider/location', { method: 'POST', body: lastFix.current }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
    return () => navigator.geolocation.clearWatch(watch.current);
  }, [online]);

  if (!user.ageVerified) return <div className="page narrow"><h1>Rider setup</h1><VerifyAge /></div>;
  if (!data) return <div className="page center pad"><Spinner /></div>;

  const toggle = async () => {
    const body = { online: !online, ...(lastFix.current || (data.rider?.lat != null ? { lat: data.rider.lat, lng: data.rider.lng } : {})) };
    try { await api('/rider/status', { method: 'POST', body }); load(); } catch (e) { notify(e.message, 'bad'); }
  };
  const claim = async (id) => {
    try { await api(`/rider/jobs/${id}/claim`, { method: 'POST' }); load(); notify('Job is yours — head to the store', 'ok'); } catch (e) { notify(e.message, 'bad'); load(); }
  };

  return (
    <div className="page narrow">
      <div className="console-head">
        <div>
          <p className="eyebrow">Rider</p>
          <h1>Hi {user.name.split(' ')[0]}</h1>
        </div>
        <button className={`go-btn ${online ? 'on' : ''}`} onClick={toggle}>{online ? 'Online' : 'Go online'}</button>
      </div>
      <div className="stats">
        <div><span>Trips today</span><strong>{data.today.trips}</strong></div>
        <div><span>Delivery fees today</span><strong>{rand(data.today.earningsCents)}</strong></div>
      </div>

      {data.current.map((o) => <CurrentJob key={o.id} o={o} onChange={load} lastFix={lastFix} />)}

      {!data.current.length && (
        <>
          <h2 className="section-title">Open jobs near you</h2>
          {!online ? <Empty icon="🛵" title="You're offline">Go online to get jobs sent to you automatically.</Empty>
            : data.open.length === 0 ? <Empty icon="⏳" title="Waiting for orders">We'll assign you the nearest job as soon as one comes in.</Empty>
              : data.open.map((o) => (
                <div key={o.id} className="card job">
                  <div className="row-between"><strong>{o.store.name}</strong><strong>{rand(o.totals.deliveryFeeCents)}</strong></div>
                  <p className="muted small">{o.pickupKm != null && `${o.pickupKm} km to store · `}{o.distanceKm} km to drop-off · {o.items.reduce((n, i) => n + i.qty, 0)} items</p>
                  <button className="btn full" onClick={() => claim(o.id)}>Accept job</button>
                </div>
              ))}
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MapContainer, Marker, Polyline, useMap } from 'react-leaflet';
import { Empty, STATUS, Spinner, api, deliveryTimeLabel, kmBetween, rand, reorderInto, useCart, useLiveOrder, useToast } from '../lib.jsx';
import { MapTiles, pin } from './Address.jsx';
import { PushButton } from '../pwa.jsx';

function OrderAgain({ order, small }) {
  const cart = useCart();
  const notify = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await reorderInto(order.id, cart);
      notify(r.missing.length ? `Added what's available — ${r.missing.map((m) => m.name).join(', ')} unavailable` : 'Added to your basket', r.missing.length ? 'bad' : 'ok');
      navigate('/checkout');
    } catch (e) { notify(e.message, 'bad'); } finally { setBusy(false); }
  };
  return <button className={`btn ${small ? 'btn-sm btn-ghost' : 'full'}`} disabled={busy} onClick={go}>↻ Order again</button>;
}

const HELP_TYPES = [
  ['missing_item', 'Something was missing'], ['wrong_item', 'I got the wrong item'], ['damaged', 'Something arrived damaged'],
  ['late', 'My order was very late'], ['not_received', "I didn't receive my order"], ['rider', 'A problem with the rider'], ['other', 'Something else'],
];

function Help({ order }) {
  const notify = useToast();
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState(null);
  const [type, setType] = useState('missing_item');
  const [note, setNote] = useState('');
  const load = () => api(`/orders/${order.id}/help`).then((d) => setRequests(d.requests)).catch(() => setRequests([]));
  useEffect(() => { load(); }, [order.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    try {
      await api(`/orders/${order.id}/help`, { method: 'POST', body: { type, note } });
      notify("Thanks — our team will get back to you shortly", 'ok');
      setOpen(false);
      load();
    } catch (e) { notify(e.message, 'bad'); }
  };
  const live = requests?.find((r) => r.status === 'open');
  return (
    <div className="card help-card">
      <h3>Need help with this order?</h3>
      {requests?.map((r) => (
        <div key={r.id} className={`help-req ${r.status}`}>
          <strong>{r.typeLabel}</strong> <span className={`status ${r.status === 'open' ? 's-placed' : 's-approved'}`}>{r.status === 'open' ? 'We\'re on it' : 'Resolved'}</span>
          {r.note && <p className="small muted">{r.note}</p>}
          {r.resolution && <p className="small"><b>Our reply:</b> {r.resolution}</p>}
        </div>
      ))}
      {!live && !open && <button className="btn btn-ghost full" onClick={() => setOpen(true)}>Report a problem</button>}
      {open && (
        <div className="help-form">
          {HELP_TYPES.map(([k, l]) => <label key={k} className={`help-opt ${type === k ? 'on' : ''}`}><input type="radio" name="help" checked={type === k} onChange={() => setType(k)} /> {l}</label>)}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell us what happened (optional)" maxLength={600} />
          <div className="actions"><button className="btn" onClick={send}>Send</button><button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}

// Something in the order sold out: the customer chooses what happens.
function SoldOutDecision({ order, onDone }) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const gone = order.items.filter((i) => i.unavailable);
  const back = gone.reduce((n, i) => n + i.qty * i.price_cents, 0);
  const left = Math.max(0, Math.round((new Date(order.awaitingUntil).getTime() - Date.now()) / 1000));
  const decide = async (decision) => {
    setBusy(true);
    try {
      const d = await api(`/orders/${order.id}/item-decision`, { method: 'POST', body: { decision } });
      onDone(d.order);
      notify(decision === 'continue' ? `Going ahead — ${rand(back)} refunded` : 'Cancelled and refunded in full', 'ok');
    } catch (e) { notify(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <div className="card decision-card" role="alert">
      <h3>😕 {order.store.name} is out of something</h3>
      <ul className="decision-items">{gone.map((i) => <li key={i.product_id}><s>{i.qty}× {i.name}</s> <span>{rand(i.qty * i.price_cents)}</span></li>)}</ul>
      <p className="small">Go ahead without {gone.length === 1 ? 'it' : 'them'} and we'll refund <b>{rand(back)}</b>, or cancel the whole order for a full refund.</p>
      <div className="actions">
        <button className="btn grow" disabled={busy} onClick={() => decide('continue')}>Continue without · get {rand(back)} back</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => decide('cancel')}>Cancel order</button>
      </div>
      <p className="muted small">If you don't choose in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}, we'll go ahead without {gone.length === 1 ? 'it' : 'them'}.</p>
    </div>
  );
}

export function Orders() {
  const [orders, setOrders] = useState(null);
  useEffect(() => { api('/orders').then((d) => setOrders(d.orders)).catch(() => setOrders([])); }, []);
  if (!orders) return <div className="page center pad"><Spinner /></div>;
  if (!orders.length) return <div className="page"><Empty icon="📦" title="No orders yet"><Link className="btn" to="/">Start shopping</Link></Empty></div>;
  return (
    <div className="page narrow">
      <h1>Your orders</h1>
      {orders.map((o) => (
        <div key={o.id} className="card order-row">
          <Link to={`/orders/${o.id}`} className="order-row-main">
            <strong>{o.store.name}</strong>
            <p className="muted small">#{o.code} · {new Date(o.createdAt + 'Z').toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}</p>
            <p className="small">{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</p>
          </Link>
          <div className="right">
            <span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span>
            <strong>{rand(o.totals.totalCents)}</strong>
            {['delivered', 'cancelled', 'rejected', 'returned'].includes(o.status) && <OrderAgain order={o} small />}
          </div>
        </div>
      ))}
    </div>
  );
}

function FitBounds({ points }) {
  const map = useMap();
  const key = points.map((p) => p.join(',')).join('|');
  useEffect(() => {
    if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const STEPS = ['Placed', 'Accepted', 'Packed', 'On the way', 'Delivered'];

function Review({ order, onDone }) {
  const [rating, setRating] = useState(0);
  const [riderRating, setRiderRating] = useState(0);
  const [comment, setComment] = useState('');
  const notify = useToast();
  const send = async () => {
    try {
      const d = await api(`/orders/${order.id}/review`, { method: 'POST', body: { rating, comment, riderRating: riderRating || undefined } });
      onDone(d.order);
      notify('Thanks for the review!', 'ok');
    } catch (e) { notify(e.message, 'bad'); }
  };
  return (
    <div className="card">
      <h3>How was it?</h3>
      <p className="muted small">The store: {order.store.name}</p>
      <div className="stars" role="radiogroup" aria-label="Store rating">
        {[1, 2, 3, 4, 5].map((n) => <button key={n} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)} aria-label={`${n} stars for the store`}>★</button>)}
      </div>
      {order.rider && (
        <>
          <p className="muted small">Your rider: {order.rider.name}</p>
          <div className="stars" role="radiogroup" aria-label="Rider rating">
            {[1, 2, 3, 4, 5].map((n) => <button key={n} className={n <= riderRating ? 'on' : ''} onClick={() => setRiderRating(n)} aria-label={`${n} stars for the rider`}>★</button>)}
          </div>
        </>
      )}
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Tell other customers (optional)" maxLength={500} />
      <button className="btn full" disabled={!rating} onClick={send}>Send review</button>
    </div>
  );
}

export function Track() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { order, setOrder, error } = useLiveOrder(id);
  const notify = useToast();

  // Back from Paystack: confirm the payment straight away rather than
  // waiting for the webhook.
  useEffect(() => {
    if (params.get('ref')) api(`/orders/${id}/verify-payment`, { method: 'POST' }).then((d) => setOrder(d.order)).catch(() => {});
  }, [id, params, setOrder]);

  if (error) return <div className="page"><Empty icon="📦" title={error} /></div>;
  if (!order) return <div className="page center pad"><Spinner /></div>;

  const step = STATUS[order.status]?.step ?? 0;
  const m = order.milestones || {};
  const headline = order.status === 'scheduled' ? `Scheduled for ${deliveryTimeLabel(order.scheduledFor)}`
    : order.status === 'picked_up' && m.arrivedCustomerAt ? 'Your rider is outside 👋'
    : ['accepted', 'preparing', 'ready'].includes(order.status) && m.arrivedStoreAt ? 'Rider is at the store'
      : ['accepted', 'preparing'].includes(order.status) && order.rider ? `${order.rider.name} is heading to the store`
        : STATUS[order.status]?.label;
  const ended = step < 0;
  const rider = order.rider?.location;
  const points = [[order.store.lat, order.store.lng], [order.dropoff.lat, order.dropoff.lng], ...(rider ? [[rider.lat, rider.lng]] : [])];
  const eta = new Date(new Date(order.createdAt + 'Z').getTime() + order.etaMinutes * 60000);

  // Once the rider has the order, count down from where they actually are.
  const riderLoc = order.rider?.location;
  const liveMinutes = order.status === 'picked_up' && riderLoc
    ? Math.max(1, Math.round((kmBetween(riderLoc, order.dropoff) * 1.3 / 25) * 60 + 1))
    : null;

  const cancel = async () => {
    if (!window.confirm('Cancel this order? You will be refunded in full.')) return;
    try {
      const d = await api(`/orders/${order.id}/cancel`, { method: 'POST', body: { reason: 'Cancelled by customer' } });
      setOrder(d.order);
    } catch (e) { notify(e.message, 'bad'); }
  };

  return (
    <div className="page narrow">
      <Link to="/orders" className="link">← All orders</Link>
      <div className="track-head">
        <div>
          <p className="eyebrow">Order #{order.code} · {order.store.name}</p>
          <h1>{headline}</h1>
          {order.status === 'scheduled' && <p className="muted">We'll send your order to {order.store.name} when deliveries start, then it arrives about {order.etaMinutes} min later. You can cancel for a full refund until then.</p>}
          {!ended && order.status !== 'delivered' && order.status !== 'scheduled' && (liveMinutes && !m.arrivedCustomerAt
            ? <p className="arriving">Arriving in <strong>~{liveMinutes} min</strong></p>
            : <p className="muted">Arriving around <strong>{eta.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</strong></p>)}
          {!ended && order.status !== 'delivered' && <PushButton compact className="track-push" />}
          {ended && order.cancelReason && <p className="muted">{order.cancelReason}{order.paymentStatus === 'refunded' && ' · Refunded in full'}</p>}
        </div>
        {order.status === 'picked_up' && <div className="live-dot">LIVE</div>}
      </div>

      {order.awaitingCustomer === 'item_unavailable' && <SoldOutDecision order={order} onDone={setOrder} />}
      {!ended && (
        <ol className="progress">
          {STEPS.map((label, i) => <li key={label} className={i + 1 <= step ? 'done' : i + 1 === step + 1 ? 'next' : ''}><span />{label}</li>)}
        </ol>
      )}

      {!ended && order.status !== 'delivered' && (
        <div className="handover">
          <div>
            <p className="eyebrow">Your handover code</p>
            <p className="code">{order.handoverCode}</p>
          </div>
          <p className="small">Give this code to the rider at the door, and have your ID ready. No code and ID, no handover.</p>
        </div>
      )}

      <div className="map-box">
        <MapContainer center={[order.dropoff.lat, order.dropoff.lng]} zoom={14} style={{ height: '100%' }}>
          <MapTiles />
          <Marker position={[order.store.lat, order.store.lng]} icon={pin('🏪')} />
          <Marker position={[order.dropoff.lat, order.dropoff.lng]} icon={pin('🏠', 'home')} />
          {rider && <Marker position={[rider.lat, rider.lng]} icon={pin('🛵', 'rider')} />}
          {rider && <Polyline positions={[[rider.lat, rider.lng], [order.dropoff.lat, order.dropoff.lng]]} pathOptions={{ color: '#2f855a', dashArray: '6 8' }} />}
          <FitBounds points={points} />
        </MapContainer>
      </div>

      {order.rider && (
        <div className="card rider-card">
          <div className="avatar">🛵</div>
          <div>
            <strong>{order.rider.name}</strong>
            <p className="muted small">{order.rider.rating ? `★ ${order.rider.rating.toFixed(1)} · ` : ''}{order.rider.vehicle} · {order.rider.plate}</p>
          </div>
          {order.rider.phone && <a className="btn btn-sm" href={`tel:${order.rider.phone}`}>Call</a>}
        </div>
      )}

      {order.status === 'delivered' && !order.review && <Review order={order} onDone={setOrder} />}
      {['delivered', 'cancelled', 'rejected', 'returned'].includes(order.status) && <OrderAgain order={order} />}

      <div className="card">
        <h3>Receipt</h3>
        {order.items.map((i) => <div key={i.product_id} className={`sum ${i.unavailable ? 'gone' : ''}`}><span>{i.qty}× {i.name}{i.unavailable ? ' — sold out' : ''}</span><span>{i.unavailable ? '—' : rand(i.qty * i.price_cents)}</span></div>)}
        {order.totals.refundedCents > 0 && <div className="sum discount"><span>Refunded (sold-out items)</span><span>{rand(order.totals.refundedCents)}</span></div>}
        <div className="sum"><span>Delivery</span><span>{order.totals.deliveryFeeCents ? rand(order.totals.deliveryFeeCents) : 'Free'}</span></div>
        <div className="sum"><span>Service fee</span><span>{rand(order.totals.serviceFeeCents)}</span></div>
        {order.totals.discountCents > 0 && <div className="sum discount"><span>🏷️ {order.totals.promoCode}</span><span>−{rand(order.totals.discountCents)}</span></div>}
        {order.totals.tipCents > 0 && <div className="sum"><span>Rider tip</span><span>{rand(order.totals.tipCents)}</span></div>}
        <div className="sum total"><span>Total</span><span>{rand(order.totals.totalCents)}</span></div>
        <p className="muted small">Incl. VAT {rand(order.totals.vatCents)} · Paid: {order.paymentStatus}</p>
      </div>

      <div className="card">
        <h3>Timeline</h3>
        <ul className="timeline">
          {order.events.map((e, i) => (
            <li key={i}><span>{new Date(e.at + 'Z').toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</span> {STATUS[e.status]?.label || e.status.replace('_', ' ')}{e.note ? ` — ${e.note}` : ''}</li>
          ))}
        </ul>
      </div>

      {['pending_payment', 'scheduled', 'placed'].includes(order.status) && <button className="btn btn-ghost full" onClick={cancel}>Cancel order</button>}
      {order.status !== 'pending_payment' && <Help order={order} />}
    </div>
  );
}

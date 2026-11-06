import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet';
import { Empty, STATUS, Spinner, api, rand, useLiveOrder, useToast } from '../lib.jsx';
import { TILE_ATTR, TILE_URL, pin } from './Address.jsx';

export function Orders() {
  const [orders, setOrders] = useState(null);
  useEffect(() => { api('/orders').then((d) => setOrders(d.orders)).catch(() => setOrders([])); }, []);
  if (!orders) return <div className="page center pad"><Spinner /></div>;
  if (!orders.length) return <div className="page"><Empty icon="📦" title="No orders yet"><Link className="btn" to="/">Start shopping</Link></Empty></div>;
  return (
    <div className="page narrow">
      <h1>Your orders</h1>
      {orders.map((o) => (
        <Link key={o.id} to={`/orders/${o.id}`} className="card order-row">
          <div>
            <strong>{o.store.name}</strong>
            <p className="muted small">#{o.code} · {new Date(o.createdAt + 'Z').toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}</p>
            <p className="small">{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</p>
          </div>
          <div className="right">
            <span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span>
            <strong>{rand(o.totals.totalCents)}</strong>
          </div>
        </Link>
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
  const headline = order.status === 'picked_up' && m.arrivedCustomerAt ? 'Your rider is outside 👋'
    : ['accepted', 'preparing', 'ready'].includes(order.status) && m.arrivedStoreAt ? 'Rider is at the store'
      : ['accepted', 'preparing'].includes(order.status) && order.rider ? `${order.rider.name} is heading to the store`
        : STATUS[order.status]?.label;
  const ended = step < 0;
  const rider = order.rider?.location;
  const points = [[order.store.lat, order.store.lng], [order.dropoff.lat, order.dropoff.lng], ...(rider ? [[rider.lat, rider.lng]] : [])];
  const eta = new Date(new Date(order.createdAt + 'Z').getTime() + order.etaMinutes * 60000);

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
          {!ended && order.status !== 'delivered' && <p className="muted">Arriving around <strong>{eta.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</strong></p>}
          {ended && order.cancelReason && <p className="muted">{order.cancelReason}{order.paymentStatus === 'refunded' && ' · Refunded in full'}</p>}
        </div>
        {order.status === 'picked_up' && <div className="live-dot">LIVE</div>}
      </div>

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
          <TileLayer url={TILE_URL} attribution={TILE_ATTR} />
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

      <div className="card">
        <h3>Receipt</h3>
        {order.items.map((i) => <div key={i.product_id} className="sum"><span>{i.qty}× {i.name}</span><span>{rand(i.qty * i.price_cents)}</span></div>)}
        <div className="sum"><span>Delivery</span><span>{order.totals.deliveryFeeCents ? rand(order.totals.deliveryFeeCents) : 'Free'}</span></div>
        <div className="sum"><span>Service fee</span><span>{rand(order.totals.serviceFeeCents)}</span></div>
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

      {['pending_payment', 'placed'].includes(order.status) && <button className="btn btn-ghost full" onClick={cancel}>Cancel order</button>}
    </div>
  );
}

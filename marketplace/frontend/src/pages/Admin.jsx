import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import { BRAND, STATUS, Spinner, api, download, rand, useAuth, useToast } from '../lib.jsx';
import { MapTiles, pin } from './Address.jsx';
import '../admin.css';
import { Columns } from '../charts.jsx';

const REGULATED = ['flower', 'pre-rolls', 'edibles', 'extracts'];
const when = (s, opts = { dateStyle: 'medium', timeStyle: 'short' }) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-ZA', opts) : '—');
const ago = (s) => {
  if (!s) return 'never';
  const m = Math.round((Date.now() - new Date(s.replace(' ', 'T') + 'Z').getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};
const compactRand = (c) => (c >= 1e6 ? `R${(c / 1e8).toFixed(1)}M` : c >= 1e5 ? `R${(c / 1e5).toFixed(1)}K` : rand(c));

const SECTIONS = [
  ['dashboard', '📊', 'Dashboard'],
  ['live', '🗺️', 'Live map'],
  ['orders', '🧾', 'Orders'],
  ['stores', '🏪', 'Stores'],
  ['payouts', '💸', 'Payouts'],
  ['riders', '🛵', 'Riders'],
  ['customers', '👥', 'Customers'],
  ['incidents', '🚨', 'Incidents'],
  ['settings', '⚙️', 'Settings'],
  ['profile', '👤', 'Profile & team'],
  ['audit', '📜', 'Audit log'],
];

function Stat({ label, value, now, before, format = (v) => v, upIsGood = true, hint }) {
  let delta = null;
  if (now != null && before != null && (now !== 0 || before !== 0)) {
    const diff = now - before;
    const good = diff === 0 ? null : (diff > 0) === upIsGood;
    delta = (
      <span className={`adm-delta ${good === null ? '' : good ? 'good' : 'bad'}`}>
        {diff > 0 ? '▲' : diff < 0 ? '▼' : '●'} {diff === 0 ? 'same as' : `${format(Math.abs(diff))} vs`} yesterday
      </span>
    );
  }
  return (
    <div className="adm-stat">
      <span className="adm-stat-label">{label}</span>
      <strong className="adm-stat-value">{value}</strong>
      {delta || <span className="adm-delta">{hint || ' '}</span>}
    </div>
  );
}

// ---- Dashboard ------------------------------------------------------------

const SEVERITY = { critical: ['⛔', 'Critical'], serious: ['⚠️', 'Urgent'], warning: ['⚠️', 'Check'], info: ['ℹ️', 'To do'] };

function Dashboard({ go, openOrder }) {
  const [d, setD] = useState(null);
  const [metric, setMetric] = useState('orders');
  useEffect(() => {
    const load = () => api('/admin/dashboard').then(setD).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  if (!d) return <div className="center pad"><Spinner /></div>;
  const t = d.today;
  const y = d.yesterday;
  const dayLabel = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
  const daySeries = d.days.map((x, i) => ({
    key: x.day, label: dayLabel(x.day), short: i === d.days.length - 1 ? 'Today' : new Date(x.day + 'T12:00:00Z').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
    value: metric === 'orders' ? x.placed : x.gmvCents, extra: metric === 'orders' ? `${x.delivered} delivered` : `${x.delivered} orders`,
  }));
  const nowHour = (new Date().getUTCHours() + 2) % 24;
  const hourly = d.hourly.map((h) => ({ key: h.hour, label: `${String(h.hour).padStart(2, '0')}:00–${String((h.hour + 1) % 24).padStart(2, '0')}:00`, tick: h.hour % 3 === 0 ? `${h.hour}h` : '', value: h.orders }));

  return (
    <>
      <div className="adm-live-strip">
        <span><i className="dot-live" /> {d.live.activeOrders} live order{d.live.activeOrders === 1 ? '' : 's'}</span>
        <span>🛵 {d.live.ridersOnline} rider{d.live.ridersOnline === 1 ? '' : 's'} online · {d.live.ridersBusy} on a trip</span>
        <span>🏪 {d.live.storesOpen} store{d.live.storesOpen === 1 ? '' : 's'} open</span>
      </div>

      <div className="adm-stats">
        <Stat label="Orders today" value={t.ordersPlaced} now={t.ordersPlaced} before={y.ordersPlaced} />
        <Stat label="Sales (delivered)" value={compactRand(t.gmvCents)} now={t.gmvCents} before={y.gmvCents} format={compactRand} />
        <Stat label="Net revenue" value={compactRand(t.netRevenueCents)} now={t.netRevenueCents} before={y.netRevenueCents} format={compactRand} hint="fees less rider pay" />
        <Stat label="Avg order to door" value={t.avgDeliveryMinutes != null ? `${t.avgDeliveryMinutes} min` : '—'} now={t.avgDeliveryMinutes} before={y.avgDeliveryMinutes} format={(v) => `${v} min`} upIsGood={false} />
        <Stat label="Cancelled or failed" value={t.cancellationRate != null ? `${t.cancellationRate}%` : '—'} now={t.cancellationRate} before={y.cancellationRate} format={(v) => `${Math.round(v * 10) / 10} pts`} upIsGood={false} />
        <Stat label="New customers" value={t.newCustomers} now={t.newCustomers} before={y.newCustomers} />
      </div>

      <div className="adm-two">
        <section className="adm-card">
          <div className="row-between"><h3>Needs attention</h3><span className="muted small">{d.actions.length || 'nothing'} open</span></div>
          {d.actions.length === 0 ? <p className="muted">✅ All clear — nothing needs you right now.</p> : (
            <ul className="adm-actions">
              {d.actions.slice(0, 12).map((a, i) => (
                <li key={i} className={`sev-${a.severity}`}>
                  <span className="adm-sev">{SEVERITY[a.severity][0]} {SEVERITY[a.severity][1]}</span>
                  <div className="grow"><strong>{a.title}</strong><p className="muted small">{a.detail}</p></div>
                  {a.ref.orderId && <button className="link" onClick={() => openOrder(a.ref.orderId)}>Open</button>}
                  {a.ref.incidentId && <button className="link" onClick={() => go('incidents')}>View</button>}
                  {a.ref.section && <button className="link" onClick={() => go(a.ref.section)}>Review</button>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="adm-card">
          <h3>Top stores · last 7 days</h3>
          {d.topStores.length === 0 ? <p className="muted">No deliveries yet this week.</p> : (
            <table className="adm-table">
              <thead><tr><th>Store</th><th>Orders</th><th>Sales</th><th>Rating</th></tr></thead>
              <tbody>{d.topStores.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.orders}</td><td>{rand(s.gmvCents)}</td><td>{s.rating ? `★ ${s.rating}` : '—'}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      </div>

      <div className="adm-two">
        <section className="adm-card">
          <div className="row-between">
            <h3>{metric === 'orders' ? 'Orders per day' : 'Sales per day'} · last 14 days</h3>
            <div className="adm-seg">
              <button className={metric === 'orders' ? 'on' : ''} onClick={() => setMetric('orders')}>Orders</button>
              <button className={metric === 'sales' ? 'on' : ''} onClick={() => setMetric('sales')}>Sales</button>
            </div>
          </div>
          <Columns data={daySeries} format={metric === 'orders' ? (v) => String(Math.round(v)) : (v, axis) => (axis ? compactRand(v) : rand(v))} label="Daily trend" highlightLast />
        </section>
        <section className="adm-card">
          <h3>Orders by hour · today</h3>
          <Columns data={hourly} format={(v) => String(Math.round(v))} label="Orders by hour today" />
          <p className="muted small">It's {nowHour}:00 now. Deliveries run in the window set under Settings.</p>
        </section>
      </div>
    </>
  );
}

// ---- Live map ---------------------------------------------------------------

function FitAll({ points }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || points.length < 2) return;
    map.fitBounds(points, { padding: [40, 40], maxZoom: 14, animate: false });
    done.current = true;
  }, [points, map]);
  return null;
}

function LiveMap({ openOrder }) {
  const [d, setD] = useState(null);
  const [city, setCity] = useState(null);
  useEffect(() => {
    const load = () => api('/admin/live').then(setD).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  // Frame what is moving; fall back to the stores when nothing is.
  const points = useMemo(() => {
    if (!d) return [];
    const moving = [...d.orders.flatMap((o) => [[o.store.lat, o.store.lng], [o.dropoff.lat, o.dropoff.lng]]), ...d.riders.map((r) => [r.lat, r.lng])];
    return moving.length > 1 ? moving : d.stores.map((s) => [s.lat, s.lng]);
  }, [d]);
  if (!d) return <div className="center pad"><Spinner /></div>;
  const CITIES = [['Johannesburg', -26.12, 28.05], ['Pretoria', -25.76, 28.25], ['Durban', -29.80, 31.03], ['Cape Town', -33.93, 18.43]];
  return (
    <div className="adm-live">
      <div className="adm-live-map">
        <MapContainer center={[-26.12, 28.05]} zoom={11} style={{ height: '100%' }}>
          <MapTiles />
          {d.stores.map((s) => <Marker key={`s${s.id}`} position={[s.lat, s.lng]} icon={pin('🏪', s.open ? '' : 'closed')}><Tooltip>{s.name}{s.open ? '' : ' (closed)'}</Tooltip></Marker>)}
          {d.orders.map((o) => (
            <span key={`o${o.id}`}>
              <Polyline positions={[[o.store.lat, o.store.lng], [o.dropoff.lat, o.dropoff.lng]]} pathOptions={{ color: o.late ? '#c53030' : '#2f855a', weight: 2, dashArray: '4 6' }} />
              <Marker position={[o.dropoff.lat, o.dropoff.lng]} icon={pin(o.late ? '⏰' : '🏠', 'home')} eventHandlers={{ click: () => openOrder(o.id) }}>
                <Tooltip>#{o.code} · {STATUS[o.status]?.label} · {o.ageMinutes} min{o.late ? ' · LATE' : ''}</Tooltip>
              </Marker>
            </span>
          ))}
          {d.riders.map((r) => <Marker key={`r${r.id}`} position={[r.lat, r.lng]} icon={pin('🛵', 'rider')}><Tooltip>{r.name}{r.currentOrder ? ` · #${r.currentOrder}` : r.paused ? ' · paused' : ' · free'}</Tooltip></Marker>)}
          <FitAll points={points} />
          {city && <Recenter to={city} />}
        </MapContainer>
        <div className="adm-map-cities">{CITIES.map(([n, la, ln]) => <button key={n} className="chip" onClick={() => setCity({ lat: la, lng: ln, at: Date.now() })}>{n}</button>)}</div>
      </div>
      <div className="adm-live-list">
        <h3>{d.orders.length} live order{d.orders.length === 1 ? '' : 's'}</h3>
        {d.orders.length === 0 && <p className="muted">No orders in progress.</p>}
        {d.orders.map((o) => (
          <button key={o.id} className={`adm-live-item ${o.late ? 'late' : ''}`} onClick={() => openOrder(o.id)}>
            <div className="row-between"><strong>#{o.code}</strong><span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span></div>
            <p className="muted small">{o.store.name} → {o.dropoff.address}</p>
            <p className="small">{o.rider ? `🛵 ${o.rider.name}` : '⏳ no rider yet'} · {o.ageMinutes} min{o.late ? ' · ⏰ late' : ''}</p>
          </button>
        ))}
        <h3 className="adm-gap">{d.riders.length} rider{d.riders.length === 1 ? '' : 's'} online</h3>
        {d.riders.map((r) => <p key={r.id} className="small">🛵 <strong>{r.name}</strong> · {r.currentOrder ? `on #${r.currentOrder}` : r.paused ? 'paused' : 'free'} · seen {ago(r.at)}</p>)}
      </div>
    </div>
  );
}

function Recenter({ to }) {
  const map = useMap();
  useEffect(() => { map.setView([to.lat, to.lng], 12); }, [to.at]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ---- Orders ---------------------------------------------------------------

const ORDER_FILTERS = [['active', 'Live'], ['scheduled', 'Scheduled'], ['needs_rider', 'Needs a rider'], ['delivered', 'Delivered'], ['problems', 'Cancelled & returned'], ['', 'All']];

function Orders({ openOrder, refreshKey }) {
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => api(`/admin/orders?status=${status}&q=${encodeURIComponent(q)}`).then((d) => setList(d.orders)).catch(() => setList([])), 200);
    return () => clearTimeout(t);
  }, [status, q, refreshKey]);
  return (
    <>
      <div className="adm-toolbar">
        <div className="chips">{ORDER_FILTERS.map(([k, l]) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{l}</button>)}</div>
        <input className="adm-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, customer or store" aria-label="Search orders" />
      </div>
      {!list ? <Spinner /> : list.length === 0 ? <p className="muted">No orders match.</p> : (
        <table className="adm-table hover">
          <thead><tr><th>Order</th><th>Placed</th><th>Store → customer</th><th>Rider</th><th>Status</th><th className="num">Total</th></tr></thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id} onClick={() => openOrder(o.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openOrder(o.id)}>
                <td><strong>#{o.code}</strong></td>
                <td className="muted">{when(o.createdAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{o.store.name} → {o.customer.name}</td>
                <td>{o.rider ? o.rider.name : <span className="muted">—</span>}</td>
                <td><span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span></td>
                <td className="num">{rand(o.totals.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function OrderDrawer({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [refunding, setRefunding] = useState(false);
  const notify = useToast();
  const load = useCallback(() => api(`/admin/orders/${id}`).then(setD).catch((e) => notify(e.message, 'bad')), [id, notify]);
  useEffect(() => { load(); }, [load]);
  const act = async (path, body, done) => {
    try { await api(path, { method: 'POST', body }); notify(done, 'ok'); load(); onChanged(); } catch (e) { notify(e.message, 'bad'); }
  };
  const o = d?.order;
  return (
    <div className="adm-drawer-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="adm-drawer" role="dialog" aria-label="Order details">
        <div className="row-between"><h2>{o ? `#${o.code}` : 'Order'}</h2><button className="nav-link" onClick={onClose} aria-label="Close">✕</button></div>
        {!o ? <Spinner /> : (
          <>
            <p><span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span> <span className="muted small">placed {when(o.createdAt)} · {o.paymentStatus}</span></p>
            {o.cancelReason && <p className="banner warn small">{o.cancelReason}</p>}
            <div className="adm-drawer-grid">
              <div><span>Store</span><strong>{o.store.name}</strong><em>{o.store.address}</em></div>
              <div><span>Customer</span><strong>{o.customer.name}</strong><em>{d.customer.email}{o.customer.phone ? ` · ${o.customer.phone}` : ''}</em><em>{d.customer.delivered} past deliveries</em></div>
              <div><span>Drop-off</span><strong>{o.dropoff.address}</strong><em>{o.distanceKm} km · promised {o.etaMinutes} min</em></div>
              <div><span>Rider</span><strong>{o.rider ? o.rider.name : 'Not assigned'}</strong><em>{o.rider ? `${o.rider.vehicle} ${o.rider.plate || ''}` : ''}</em>{o.pay && o.rider && <em>Pay {rand(o.pay.payoutCents)}{o.pay.tipCents ? ` + ${rand(o.pay.tipCents)} tip` : ''}</em>}</div>
            </div>
            <div className="actions">
              {o.customer.phone && <a className="btn btn-sm btn-ghost" href={`tel:${o.customer.phone}`}>Call customer</a>}
              {o.rider && ['accepted', 'preparing', 'ready'].includes(o.status) && (
                <button className="btn btn-sm btn-ghost" onClick={() => act(`/admin/orders/${o.id}/reassign`, { reason: 'Reassigned by support' }, 'Taken off the rider and offered again')}>Reassign rider</button>
              )}
              {!['delivered', 'cancelled', 'rejected', 'returned'].includes(o.status) && (
                <button className="btn btn-sm" onClick={() => {
                  const reason = window.prompt('Why are you cancelling? The customer sees this, and is refunded in full.');
                  if (reason) act(`/orders/${o.id}/cancel`, { reason }, 'Cancelled and refunded');
                }}>Cancel & refund</button>
              )}
              {o.status === 'delivered' && o.totals.refundedCents < o.totals.totalCents && !refunding && <button className="btn btn-sm btn-ghost" onClick={() => setRefunding(true)}>Refund…</button>}
              {o.status === 'delivered' && <a className="btn btn-sm btn-ghost" href={`/orders/${o.id}/invoice`} target="_blank" rel="noreferrer">Invoice</a>}
            </div>
            {refunding && <RefundForm o={o} onDone={() => { setRefunding(false); load(); onChanged(); }} onCancel={() => setRefunding(false)} />}
            <h4>Items</h4>
            {o.items.map((i) => <div key={i.product_id} className="sum"><span>{i.qty}× {i.name}</span><span>{rand(i.qty * i.price_cents)}</span></div>)}
            <div className="sum"><span>Delivery</span><span>{rand(o.totals.deliveryFeeCents)}</span></div>
            <div className="sum"><span>Service fee</span><span>{rand(o.totals.serviceFeeCents)}</span></div>
            {o.totals.discountCents > 0 && <div className="sum discount"><span>🏷️ {o.totals.promoCode}</span><span>−{rand(o.totals.discountCents)}</span></div>}
            {o.totals.tipCents > 0 && <div className="sum"><span>Tip</span><span>{rand(o.totals.tipCents)}</span></div>}
            <div className="sum total"><span>Total</span><span>{rand(o.totals.totalCents)}</span></div>
            {o.totals.refundedCents > 0 && <div className="sum discount"><span>Refunded</span><span>{rand(o.totals.refundedCents)}</span></div>}
            <p className="muted small">Handover code {o.handoverCode} · ID checked at door: {d.idChecked ? 'yes' : 'no'}{d.paymentRef ? ` · ref ${d.paymentRef}` : ''}</p>
            <h4>Timeline</h4>
            <ul className="timeline">{o.events.map((e, i) => <li key={i}><span>{when(e.at, { hour: '2-digit', minute: '2-digit' })}</span> {STATUS[e.status]?.label || e.status.replace(/_/g, ' ')}{e.note ? ` — ${e.note}` : ''}</li>)}</ul>
            {d.offers.length > 0 && (
              <>
                <h4>Rider offers</h4>
                <ul className="timeline">{d.offers.map((f, i) => <li key={i}><span>{when(f.at, { hour: '2-digit', minute: '2-digit' })}</span> {f.name} — {f.outcome}</li>)}</ul>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

// ---- Payouts ------------------------------------------------------------

function PayoutForm({ s, onDone, onCancel }) {
  const notify = useToast();
  const [amount, setAmount] = useState((Math.max(0, s.balanceCents) / 100).toFixed(2));
  const [reference, setReference] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('/admin/payouts', { method: 'POST', body: { storeId: s.storeId, amountCents: Math.round(Number(amount) * 100), reference } });
      notify(`Payout to ${s.name} recorded`, 'ok');
      onDone();
    } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form className="adm-inline-form" onSubmit={submit}>
      <label className="field"><span>Amount paid (R)</span><input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
      <label className="field"><span>Bank reference</span><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="From your banking app" required /></label>
      <div className="actions"><button className="btn btn-sm">Record payout</button><button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function Payouts() {
  const notify = useToast();
  const [d, setD] = useState(null);
  const [paying, setPaying] = useState(null);
  const load = useCallback(() => api('/admin/payouts').then(setD), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <Spinner />;
  const due = d.stores.filter((s) => s.balanceCents > 0);
  return (
    <>
      <div className="adm-toolbar">
        <div><strong>{rand(d.totalOwedCents)}</strong> owed to {due.length} store{due.length === 1 ? '' : 's'}</div>
        <button className="btn btn-ghost" onClick={() => download('/admin/payouts/batch.csv', `payouts-${new Date().toISOString().slice(0, 10)}.csv`).catch((e) => notify(e.message, 'bad'))}>⬇ Payment list (CSV)</button>
      </div>
      <p className="muted small">Pay each store by EFT from the company account, then record it here with the bank's reference so it shows on their statement. Stores whose bank details changed in the last 7 days are flagged — call them on the number you already have before paying.</p>
      <table className="adm-table">
        <thead><tr><th>Store</th><th>Bank account</th><th className="num">Earned</th><th className="num">Paid</th><th className="num">Owed</th><th>Last payout</th><th /></tr></thead>
        <tbody>{d.stores.map((s) => (
          <tr key={s.storeId} className={s.bankChangedRecently ? 'adm-flag' : ''}>
            <td><strong>{s.name}</strong></td>
            <td>{s.bank ? <>{s.bank.bankName} {s.bank.accountNumber} <span className="muted small">· {s.bank.branchCode} · {s.bank.accountHolder}</span>{s.bankChangedRecently && <><br /><b className="m-bad small">⚠ Changed {ago(s.bank.updatedAt)} — confirm by phone</b></>}</> : <span className="muted">No bank details</span>}</td>
            <td className="num">{rand(s.earnedCents)}</td><td className="num">{rand(s.paidCents)}</td><td className="num"><strong>{rand(s.balanceCents)}</strong></td>
            <td>{s.lastPayout ? <>{rand(s.lastPayout.amountCents)} <span className="muted small">{ago(s.lastPayout.paidAt)}</span></> : <span className="muted">—</span>}</td>
            <td>{paying === s.storeId ? null : s.balanceCents > 0 && s.bank && <button className="btn btn-sm" onClick={() => setPaying(s.storeId)}>Record payout</button>}</td>
          </tr>
        )).flatMap((row, i) => (paying === d.stores[i].storeId ? [row, <tr key={`pay-${paying}`}><td colSpan={7}><PayoutForm s={d.stores[i]} onDone={() => { setPaying(null); load(); }} onCancel={() => setPaying(null)} /></td></tr>] : [row]))}</tbody>
      </table>
      {d.recent.length > 0 && (
        <>
          <h3 className="adm-gap">Recent payouts</h3>
          <table className="adm-table">
            <thead><tr><th>Paid</th><th>Store</th><th>Reference</th><th className="num">Amount</th></tr></thead>
            <tbody>{d.recent.map((p) => <tr key={p.id}><td>{when(p.paidAt)}</td><td>{p.store}</td><td>{p.reference}</td><td className="num">{rand(p.amountCents)}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </>
  );
}

function RefundForm({ o, onDone, onCancel }) {
  const notify = useToast();
  const left = o.totals.totalCents - o.totals.refundedCents;
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [borneBy, setBorneBy] = useState('store');
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/admin/orders/${o.id}/refund`, { method: 'POST', body: { amountCents: Math.round(Number(amount) * 100), reason, borneBy } });
      notify(r.platformCents && borneBy === 'store' ? `Refunded — the store covers ${rand(r.storeCents)}, the platform ${rand(r.platformCents)}` : 'Refunded', 'ok');
      onDone();
    } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form className="card adm-gap" onSubmit={submit}>
      <h4>Refund after delivery</h4>
      <div className="grid-2">
        <label className="field"><span>Amount (R) — up to {rand(left)}</span><input type="number" step="0.01" min="0.01" max={left / 100} value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
        <label className="field"><span>Who pays for it</span>
          <select value={borneBy} onChange={(e) => setBorneBy(e.target.value)}>
            <option value="store">The store (wrong, damaged or missing item)</option>
            <option value="platform">{BRAND.name} (late delivery, goodwill)</option>
          </select>
        </label>
      </div>
      <label className="field"><span>Reason (the customer and store see this)</span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} required /></label>
      {borneBy === 'store' && <p className="muted small">Comes off the store's next payout, up to what they earned on this order; anything above that is on {BRAND.name}.</p>}
      <div className="actions"><button className="btn btn-sm">Refund {amount ? rand(Math.round(Number(amount) * 100)) : ''}</button><button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function CompanyDetails() {
  const notify = useToast();
  const [c, setC] = useState(null);
  useEffect(() => { api('/admin/company').then((d) => setC(d.company)); }, []);
  if (!c) return null;
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try { const d = await api('/admin/company', { method: 'PUT', body: c }); setC(d.company); notify('Company details saved', 'ok'); } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form className="adm-card narrow-card adm-gap" onSubmit={save}>
      <h3>Company details for invoices</h3>
      <p className="muted small">Shown on customer invoices for delivery and service fees, and on store statements. Add the VAT number once {BRAND.name} is VAT-registered — invoices then become tax invoices.</p>
      <div className="grid-2">
        <label className="field"><span>Registered name</span><input value={c.name} onChange={set('name')} /></label>
        <label className="field"><span>Company registration no.</span><input value={c.companyReg} onChange={set('companyReg')} /></label>
        <label className="field"><span>VAT number</span><input value={c.vatNumber} onChange={set('vatNumber')} inputMode="numeric" placeholder="10 digits, starts with 4" /></label>
        <label className="field"><span>Address</span><input value={c.address} onChange={set('address')} /></label>
      </div>
      <div className="actions"><button className="btn">Save</button></div>
    </form>
  );
}

// ---- Stores, riders, customers, incidents -------------------------------

function StoreRow({ s, onChange }) {
  const notify = useToast();
  const [cats, setCats] = useState(s.licenceCategories);
  const update = async (body) => {
    try { await api(`/admin/stores/${s.id}`, { method: 'POST', body }); onChange(); notify('Updated', 'ok'); } catch (e) { notify(e.message, 'bad'); }
  };
  return (
    <div className="card">
      <div className="row-between">
        <div>
          <strong>{s.name}</strong> <span className={`status s-${s.status}`}>{s.status}</span> {!s.isOpen && <span className="status s-pending_payment">closed</span>}
          <p className="muted small">{s.city} · {s.address} · {s.owner.name} ({s.owner.email}){s.rating ? ` · ★ ${s.rating}` : ''}</p>
        </div>
        <div className="actions">
          {s.status !== 'approved' && <button className="btn btn-sm" onClick={() => update({ status: 'approved' })}>Approve</button>}
          {s.status === 'approved' && <button className="btn btn-sm btn-ghost" onClick={() => update({ status: 'suspended' })}>Suspend</button>}
        </div>
      </div>
      <div className="licence">
        <p className="small">Licence: <strong>{s.licenceNumber || 'none given'}</strong> {s.licenceVerified ? '✅ verified' : s.licenceNumber ? '⏳ unverified' : ''}</p>
        {s.licenceNumber && (
          <>
            <div className="chips">
              {REGULATED.map((c) => (
                <button key={c} className={`chip ${cats.includes(c) ? 'on' : ''}`} onClick={() => setCats((x) => (x.includes(c) ? x.filter((v) => v !== c) : [...x, c]))}>{c}</button>
              ))}
            </div>
            <div className="actions">
              <button className="btn btn-sm" onClick={() => update({ licenceVerified: true, licenceCategories: cats })}>Verify licence for selected</button>
              {s.licenceVerified && <button className="btn btn-sm btn-ghost" onClick={() => update({ licenceVerified: false })}>Revoke</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stores() {
  const [stores, setStores] = useState(null);
  const [filter, setFilter] = useState('all');
  const load = useCallback(() => api('/admin/stores').then((d) => setStores(d.stores)), []);
  useEffect(() => { load(); }, [load]);
  if (!stores) return <Spinner />;
  const shown = stores.filter((s) => filter === 'all' || (filter === 'review' ? s.status === 'pending' || (s.licenceNumber && !s.licenceVerified) : s.status === filter));
  return (
    <>
      <div className="chips">
        {[['all', 'All'], ['review', 'Needs review'], ['approved', 'Approved'], ['suspended', 'Suspended']].map(([k, l]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
      </div>
      {shown.length === 0 ? <p className="muted">Nothing here.</p> : shown.map((s) => <StoreRow key={s.id} s={s} onChange={load} />)}
    </>
  );
}

function suspendPrompt(name, suspend) {
  return suspend ? window.prompt(`Suspend ${name}? They will be signed out and can't use ${BRAND.name} until reinstated. Reason:`) : window.confirm(`Reinstate ${name}?`) && 'reinstated';
}

function Riders() {
  const [riders, setRiders] = useState(null);
  const notify = useToast();
  const load = useCallback(() => api('/admin/riders').then((d) => setRiders(d.riders)), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  const suspend = async (r) => {
    const reason = suspendPrompt(r.name, !r.suspended);
    if (!reason) return;
    try { await api(`/admin/users/${r.id}/suspend`, { method: 'POST', body: { suspended: !r.suspended, reason } }); load(); } catch (e) { notify(e.message, 'bad'); }
  };
  if (!riders) return <Spinner />;
  return (
    <table className="adm-table">
      <thead><tr><th>Rider</th><th>Status</th><th>Now</th><th>Today</th><th>Rating</th><th>Acceptance</th><th /></tr></thead>
      <tbody>
        {riders.map((r) => (
          <tr key={r.id} className={r.suspended ? 'dim' : ''}>
            <td><strong>{r.name}</strong><br /><span className="muted small">{r.vehicle}{r.plate ? ` · ${r.plate}` : ''}{r.phone ? ` · ${r.phone}` : ''}</span></td>
            <td><span className={`status ${r.suspended ? 's-cancelled' : r.online ? (r.paused ? 's-placed' : 's-approved') : 's-pending_payment'}`}>{r.suspended ? 'Suspended' : r.online ? (r.paused ? 'Paused' : 'Online') : 'Offline'}</span></td>
            <td className="small">{r.currentOrder ? `#${r.currentOrder}` : '—'}{r.location ? <><br /><span className="muted">seen {ago(r.location.at)}</span></> : null}</td>
            <td>{r.tripsToday}</td>
            <td>{r.rating ? `★ ${r.rating}` : '—'}</td>
            <td>{r.acceptanceRate != null ? `${r.acceptanceRate}%` : '—'}</td>
            <td><button className="link" onClick={() => suspend(r)}>{r.suspended ? 'Reinstate' : 'Suspend'}</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Customers() {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const notify = useToast();
  const load = useCallback(() => api(`/admin/customers?q=${encodeURIComponent(q)}`).then((d) => setList(d.customers)), [q]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  const suspend = async (c) => {
    const reason = suspendPrompt(c.name, !c.suspended);
    if (!reason) return;
    try { await api(`/admin/users/${c.id}/suspend`, { method: 'POST', body: { suspended: !c.suspended, reason } }); load(); } catch (e) { notify(e.message, 'bad'); }
  };
  return (
    <>
      <div className="adm-toolbar"><input className="adm-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or phone" aria-label="Search customers" /></div>
      {!list ? <Spinner /> : list.length === 0 ? <p className="muted">No customers match.</p> : (
        <table className="adm-table">
          <thead><tr><th>Customer</th><th>Joined</th><th>Orders</th><th className="num">Spend</th><th>Last order</th><th>ID</th><th /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className={c.suspended ? 'dim' : ''}>
                <td><strong>{c.name}</strong>{c.suspended && <span className="status s-cancelled"> suspended</span>}<br /><span className="muted small">{c.email}{c.phone ? ` · ${c.phone}` : ''}</span></td>
                <td className="muted small">{when(c.joinedAt, { dateStyle: 'medium' })}</td>
                <td>{c.orders}</td>
                <td className="num">{rand(c.spendCents)}</td>
                <td className="muted small">{c.lastOrderAt ? ago(c.lastOrderAt) : '—'}</td>
                <td>{c.ageVerified ? '✓ 18+' : <span className="muted">not yet</span>}</td>
                <td><button className="link" onClick={() => suspend(c)}>{c.suspended ? 'Reinstate' : 'Suspend'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function HelpRequests() {
  const [list, setList] = useState(null);
  const notify = useToast();
  const load = useCallback(() => api('/admin/help').then((d) => setList(d.requests)), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const resolve = async (r) => {
    const resolution = window.prompt(`How did you resolve #${r.orderCode}? ${r.customer.name} will see this.`);
    if (!resolution) return;
    try { await api(`/admin/help/${r.id}/resolve`, { method: 'POST', body: { resolution } }); load(); } catch (e) { notify(e.message, 'bad'); }
  };
  if (!list) return <Spinner />;
  if (list.length === 0) return <p className="muted">No customer help requests.</p>;
  return (
    <div className="table">
      {list.map((r) => (
        <div key={r.id} className={`trow ${r.status === 'resolved' ? 'dim' : ''}`}>
          <span className={`status ${r.status === 'open' ? 's-placed' : 's-approved'}`}>{r.status === 'open' ? 'Open' : 'Resolved'}</span>
          <span className="grow small"><strong>{r.typeLabel}</strong> · #{r.orderCode} · {r.storeName} · {when(r.createdAt)}<br />
            <span className="muted">{r.customer.name} ({r.customer.email}){r.note ? ` — “${r.note}”` : ''}</span>
            {r.resolution && <><br /><span>↳ {r.resolution}</span></>}
          </span>
          {r.customer.phone && <a className="link" href={`tel:${r.customer.phone}`}>Call</a>}
          {r.status === 'open' && <button className="link" onClick={() => resolve(r)}>Reply & resolve</button>}
        </div>
      ))}
    </div>
  );
}

function Incidents() {
  return (
    <>
      <h3>Rider safety & incidents</h3>
      <RiderIncidents />
      <h3 className="adm-gap">Customer help requests</h3>
      <HelpRequests />
    </>
  );
}

function RiderIncidents() {
  const [list, setList] = useState(null);
  const load = useCallback(() => api('/admin/incidents').then((d) => setList(d.incidents)), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  if (!list) return <Spinner />;
  if (list.length === 0) return <p className="muted">✅ No incidents reported.</p>;
  return (
    <div className="table">
      {list.map((i) => (
        <div key={i.id} className={`trow ${i.resolved ? 'dim' : ''} ${i.type === 'sos' && !i.resolved ? 'adm-sos' : ''}`}>
          <span className={`status ${i.type === 'sos' ? 's-cancelled' : 's-placed'}`}>{i.type === 'sos' ? '🚨 SOS' : i.type.replace('_', ' ')}</span>
          <span className="grow small"><strong>{i.rider.name}</strong>{i.orderCode ? ` · #${i.orderCode}` : ''} · {when(i.at)}<br /><span className="muted">{i.note}</span></span>
          {i.rider.phone && <a className="link" href={`tel:${i.rider.phone}`}>Call</a>}
          {i.location && <a className="link" href={`https://www.google.com/maps?q=${i.location.lat},${i.location.lng}`} target="_blank" rel="noreferrer">Map</a>}
          {i.resolved ? <span className="muted small">resolved</span> : <button className="link" onClick={() => api(`/admin/incidents/${i.id}/resolve`, { method: 'POST' }).then(load)}>Resolve</button>}
        </div>
      ))}
    </div>
  );
}

function Settings() {
  const [ov, setOv] = useState(null);
  const notify = useToast();
  const load = useCallback(() => api('/admin/overview').then(setOv), []);
  useEffect(() => { load(); }, [load]);
  const set = async (body) => {
    try { await api('/admin/settings', { method: 'PUT', body }); notify('Saved', 'ok'); load(); } catch (e) { notify(e.message, 'bad'); }
  };
  if (!ov) return <Spinner />;
  return (
    <section className="adm-card narrow-card">
      <h3>Compliance</h3>
      <label className="switch-row">
        <div>
          <strong>Regulated categories</strong>
          <p className="muted small">Flower, pre-rolls, edibles and extracts. Keep this OFF unless commercial sale is lawful and your legal counsel has signed off. Even when ON, each store also needs a verified licence covering the category.</p>
        </div>
        <span className="switch"><input type="checkbox" checked={ov.settings.regulatedSalesEnabled} onChange={(e) => set({ regulatedSalesEnabled: e.target.checked })} /><span /></span>
      </label>
      <h3 className="adm-gap">Delivery hours (SAST)</h3>
      <div className="grid-2">
        <label className="field"><span>Open from (hour)</span><input type="number" min="0" max="23" defaultValue={ov.settings.deliveryOpenHour} onBlur={(e) => set({ deliveryOpenHour: Number(e.target.value) })} /></label>
        <label className="field"><span>Close at (hour)</span><input type="number" min="1" max="24" defaultValue={ov.settings.deliveryCloseHour} onBlur={(e) => set({ deliveryCloseHour: Number(e.target.value) })} /></label>
      </div>
      <p className="muted small">Customers can't place orders outside these hours. Changes apply straight away and are recorded in the audit log.</p>
    </section>
  );
}

// ---- Profile & team -----------------------------------------------------

function Profile() {
  const { user, setUser } = useAuth();
  const notify = useToast();
  const [f, setF] = useState({ name: user.name, phone: user.phone || '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [team, setTeam] = useState(null);
  const [invite, setInvite] = useState({ name: '', email: '' });
  const [created, setCreated] = useState(null);
  const [activity, setActivity] = useState(null);

  const loadTeam = useCallback(() => api('/admin/team').then((d) => setTeam(d.team)), []);
  useEffect(() => {
    loadTeam();
    api('/admin/audit?mine=1&limit=12').then((d) => setActivity(d.entries));
  }, [loadTeam]);

  const saveProfile = async (e) => {
    e.preventDefault();
    try { const d = await api('/me', { method: 'PATCH', body: f }); setUser(d.user); notify('Profile saved', 'ok'); } catch (err) { notify(err.message, 'bad'); }
  };
  const savePassword = async (e) => {
    e.preventDefault();
    if (pw.newPassword !== pw.confirm) return notify("The new passwords don't match", 'bad');
    try {
      const d = await api('/me/password', { method: 'POST', body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword } });
      setUser(d.user);
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      notify('Password changed', 'ok');
    } catch (err) { notify(err.message, 'bad'); }
  };
  const addAdmin = async (e) => {
    e.preventDefault();
    try {
      const d = await api('/admin/team', { method: 'POST', body: invite });
      setCreated(d);
      setInvite({ name: '', email: '' });
      loadTeam();
    } catch (err) { notify(err.message, 'bad'); }
  };
  const setAccess = async (m, active) => {
    if (!active && !window.confirm(`Remove ${m.name}'s admin access?`)) return;
    try { await api(`/admin/team/${m.id}/access`, { method: 'POST', body: { active } }); loadTeam(); } catch (err) { notify(err.message, 'bad'); }
  };

  return (
    <div className="adm-profile">
      <section className="adm-card adm-me">
        <div className="adm-avatar">{user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</div>
        <div className="grow">
          <h2>{user.name}</h2>
          <p className="muted">{user.email} · Administrator</p>
          <p className="muted small">Admin since {when(user.createdAt, { dateStyle: 'long' })} · last signed in {user.lastLoginAt ? ago(user.lastLoginAt) : 'this is your first sign-in'}</p>
        </div>
      </section>

      {user.mustChangePassword && <p className="banner warn">🔐 You're using a temporary password. Choose your own below before you do anything else.</p>}

      <div className="adm-two">
        <form className="adm-card" onSubmit={saveProfile}>
          <h3>Your details</h3>
          <label className="field"><span>Full name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" /></label>
          <label className="field"><span>Email (used to sign in)</span><input value={user.email} disabled /></label>
          <label className="field"><span>Mobile number</span><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" placeholder="082 123 4567" autoComplete="tel" /></label>
          <button className="btn">Save details</button>
        </form>
        <form className="adm-card" onSubmit={savePassword}>
          <h3>Password</h3>
          <label className="field"><span>Current password</span><input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required autoComplete="current-password" /></label>
          <label className="field"><span>New password (at least 10 characters)</span><input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required minLength={10} autoComplete="new-password" /></label>
          <label className="field"><span>Repeat new password</span><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required autoComplete="new-password" /></label>
          <button className="btn">Change password</button>
        </form>
      </div>

      <section className="adm-card">
        <div className="row-between"><h3>Admin team</h3><span className="muted small">{team ? `${team.filter((m) => m.active).length} active` : ''}</span></div>
        {!team ? <Spinner /> : (
          <table className="adm-table">
            <thead><tr><th>Name</th><th>Last sign-in</th><th>Actions this week</th><th /></tr></thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.id} className={m.active ? '' : 'dim'}>
                  <td><strong>{m.name}</strong>{m.you && <span className="tag"> you</span>}<br /><span className="muted small">{m.email}</span></td>
                  <td className="muted small">{ago(m.lastLoginAt)}</td>
                  <td>{m.actionsThisWeek}</td>
                  <td>{!m.you && <button className="link" onClick={() => setAccess(m, !m.active)}>{m.active ? 'Remove access' : 'Restore access'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="adm-invite" onSubmit={addAdmin}>
          <h4>Add an admin</h4>
          <div className="adm-invite-row">
            <input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} placeholder="Full name" required aria-label="New admin name" />
            <input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} placeholder="Email" required aria-label="New admin email" />
            <button className="btn">Add</button>
          </div>
          {created && (
            <div className="banner">
              <strong>{created.email}</strong> can sign in now with this one-time password: <code className="adm-code">{created.temporaryPassword}</code>
              <p className="small muted">Share it privately. It won't be shown again, and they'll be asked to change it.</p>
              <button type="button" className="link" onClick={() => { navigator.clipboard?.writeText(created.temporaryPassword); notify('Copied', 'ok'); }}>Copy password</button>
            </div>
          )}
        </form>
      </section>

      <section className="adm-card">
        <h3>Your recent activity</h3>
        {!activity ? <Spinner /> : activity.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <ul className="timeline">{activity.map((a) => <li key={a.id}><span>{when(a.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span> {a.action.replace(/_/g, ' ')}</li>)}</ul>
        )}
      </section>
    </div>
  );
}

function Audit() {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => api(`/admin/audit?q=${encodeURIComponent(q)}&limit=200`).then((d) => setList(d.entries)), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <div className="adm-toolbar"><input className="adm-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search action, person or detail" aria-label="Search audit log" /></div>
      {!list ? <Spinner /> : (
        <table className="adm-table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="muted small nowrap">{when(a.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{a.by ? <>{a.by.name} <span className="muted small">{a.by.role}</span></> : <span className="muted">system</span>}</td>
                <td>{a.action.replace(/_/g, ' ')}</td>
                <td className="muted small adm-detail">{a.detail ? Object.entries(a.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---- Shell -----------------------------------------------------------------

export default function Admin() {
  const { user } = useAuth();
  const [section, setSection] = useState(() => (user.mustChangePassword ? 'profile' : 'dashboard'));
  const [orderId, setOrderId] = useState(null);
  const [badges, setBadges] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const load = () => api('/admin/overview').then((o) => setBadges({ incidents: o.openIncidents, stores: o.pendingStores + o.unverifiedLicences, orders: o.unassigned })).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const title = SECTIONS.find(([k]) => k === section)[2];
  return (
    <div className="adm">
      <nav className="adm-nav" aria-label="Admin sections">
        <div className="adm-nav-head"><strong>Control room</strong><span className="muted small">{user.name}</span></div>
        {SECTIONS.map(([k, icon, label]) => (
          <button key={k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>
            <span>{icon}</span> {label}{badges[k] ? <b className={`adm-badge ${k === 'incidents' ? 'hot' : ''}`}>{badges[k]}</b> : null}
          </button>
        ))}
      </nav>
      <div className="adm-main">
        <h1>{title}</h1>
        {section === 'dashboard' && <Dashboard go={setSection} openOrder={setOrderId} />}
        {section === 'live' && <LiveMap openOrder={setOrderId} />}
        {section === 'orders' && <Orders openOrder={setOrderId} refreshKey={refreshKey} />}
        {section === 'stores' && <Stores />}
        {section === 'payouts' && <Payouts />}
        {section === 'riders' && <Riders />}
        {section === 'customers' && <Customers />}
        {section === 'incidents' && <Incidents />}
        {section === 'settings' && <><Settings /><CompanyDetails /></>}
        {section === 'profile' && <Profile />}
        {section === 'audit' && <Audit />}
      </div>
      {orderId && <OrderDrawer id={orderId} onClose={() => setOrderId(null)} onChanged={() => setRefreshKey((k) => k + 1)} />}
    </div>
  );
}

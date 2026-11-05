import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, STATUS, Spinner, api, rand, useAuth, useMeta, useToast } from '../lib.jsx';
import { VerifyAge } from './Checkout.jsx';

const NEXT_ACTION = {
  placed: [['accepted', 'Accept'], ['rejected', 'Decline']],
  accepted: [['preparing', 'Start packing'], ['ready', 'Ready for pickup']],
  preparing: [['ready', 'Ready for pickup']],
};

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    o.frequency.value = 880;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
  } catch { /* no audio */ }
}

function Setup({ onCreated }) {
  const meta = useMeta();
  const { user } = useAuth();
  const notify = useToast();
  const [f, setF] = useState({ name: '', city: 'johannesburg', address: '', description: '', licenceNumber: '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  if (!user.ageVerified) return <div className="page narrow"><h1>Open your store</h1><VerifyAge /></div>;
  const submit = async (e) => {
    e.preventDefault();
    try {
      const d = await api('/merchant/store', { method: 'POST', body: f });
      onCreated(d.store);
      notify('Application sent — we review stores within one working day', 'ok');
    } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <div className="page narrow">
      <h1>Open your store</h1>
      <p className="muted">List with us and reach customers across your city, with riders, payments and tracking handled for you.</p>
      <form className="card" onSubmit={submit}>
        <label className="field"><span>Store name</span><input value={f.name} onChange={set('name')} required /></label>
        <label className="field"><span>City</span>
          <select value={f.city} onChange={set('city')}>{meta?.cities.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
        </label>
        <label className="field"><span>Street address (riders collect here)</span><input value={f.address} onChange={set('address')} required /></label>
        <label className="field"><span>Short description</span><textarea value={f.description} onChange={set('description')} maxLength={400} /></label>
        <label className="field"><span>Licence or permit number (if you hold one)</span><input value={f.licenceNumber} onChange={set('licenceNumber')} /></label>
        <button className="btn btn-lg full">Apply</button>
      </form>
    </div>
  );
}

function OrderCard({ o, onChange }) {
  const notify = useToast();
  const act = async (status) => {
    let reason;
    if (status === 'rejected') {
      reason = window.prompt('Why are you declining? The customer will see this.', 'Out of stock');
      if (reason === null) return;
    }
    try {
      await api(`/merchant/orders/${o.id}/status`, { method: 'POST', body: { status, reason } });
      onChange();
    } catch (e) { notify(e.message, 'bad'); }
  };
  const age = Math.round((Date.now() - new Date(o.createdAt + 'Z').getTime()) / 60000);
  return (
    <div className={`card order-card s-${o.status}`}>
      <div className="row-between">
        <strong>#{o.code}</strong>
        <span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span>
      </div>
      <p className="muted small">{o.customer.name} · {o.distanceKm} km · {age} min ago</p>
      <ul className="pick-list">{o.items.map((i) => <li key={i.product_id}><strong>{i.qty}×</strong> {i.name}</li>)}</ul>
      {o.notes && <p className="small">📝 {o.notes}</p>}
      <p className="small">{o.rider ? `🛵 ${o.rider.name} assigned` : ['accepted', 'preparing', 'ready'].includes(o.status) ? '⏳ Finding a rider…' : ''}</p>
      <div className="row-between">
        <strong>{rand(o.totals.subtotalCents)}</strong>
        <div className="actions">
          {(NEXT_ACTION[o.status] || []).map(([s, label]) => (
            <button key={s} className={`btn btn-sm ${s === 'rejected' ? 'btn-ghost' : ''}`} onClick={() => act(s)}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProductForm({ categories, initial, onSaved, onCancel }) {
  const notify = useToast();
  const [f, setF] = useState(initial || { name: '', category: categories.find((c) => !c.regulated)?.slug, price: '', stock: 10, unit: 'each', description: '', thcPct: '', cbdPct: '', strainType: '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const cat = categories.find((c) => c.slug === f.category);
  const submit = async (e) => {
    e.preventDefault();
    const body = { ...f, priceCents: Math.round(Number(f.price) * 100), stock: Number(f.stock) };
    try {
      if (initial?.id) await api(`/merchant/products/${initial.id}`, { method: 'PATCH', body });
      else await api('/merchant/products', { method: 'POST', body });
      onSaved();
    } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>{initial?.id ? 'Edit product' : 'New product'}</h3>
      <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} required /></label>
      <div className="grid-2">
        <label className="field"><span>Category</span>
          <select value={f.category} onChange={set('category')}>{categories.map((c) => <option key={c.slug} value={c.slug}>{c.icon} {c.name}{c.regulated ? ' (licence needed)' : ''}</option>)}</select>
        </label>
        <label className="field"><span>Unit</span><input value={f.unit} onChange={set('unit')} /></label>
        <label className="field"><span>Price (R, incl. VAT)</span><input type="number" step="0.01" min="0.01" value={f.price} onChange={set('price')} required /></label>
        <label className="field"><span>Stock</span><input type="number" min="0" value={f.stock} onChange={set('stock')} required /></label>
      </div>
      {cat?.regulated ? (
        <div className="grid-2">
          <label className="field"><span>THC %</span><input type="number" step="0.1" value={f.thcPct ?? ''} onChange={set('thcPct')} /></label>
          <label className="field"><span>CBD %</span><input type="number" step="0.1" value={f.cbdPct ?? ''} onChange={set('cbdPct')} /></label>
        </div>
      ) : null}
      <label className="field"><span>Description</span><textarea value={f.description} onChange={set('description')} maxLength={600} /></label>
      {cat?.regulated ? <p className="banner warn small">This category only goes live once your licence is verified and covers it.</p> : null}
      <div className="actions">
        <button className="btn">Save</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Products() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const notify = useToast();
  const load = useCallback(() => api('/merchant/products').then(setData), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Spinner />;
  const patch = async (p, body) => {
    try { await api(`/merchant/products/${p.id}`, { method: 'PATCH', body }); load(); } catch (e) { notify(e.message, 'bad'); }
  };
  return (
    <div>
      {editing ? (
        <ProductForm categories={data.categories} initial={editing === 'new' ? null : editing} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
      ) : (
        <button className="btn" onClick={() => setEditing('new')}>+ Add product</button>
      )}
      <div className="table">
        {data.products.map((p) => (
          <div key={p.id} className={`trow ${!p.live ? 'dim' : ''}`}>
            <span className="product-icon sm">{p.category.icon}</span>
            <div className="grow">
              <strong>{p.name}</strong>
              <p className="muted small">{rand(p.priceCents)} / {p.unit} · {p.live ? 'Live' : p.active ? `Hidden — ${p.blockedReason}` : 'Switched off'}</p>
            </div>
            <div className="stepper">
              <button onClick={() => patch(p, { stock: Math.max(0, p.stock - 1) })} aria-label="Less stock">−</button>
              <span>{p.stock}</span>
              <button onClick={() => patch(p, { stock: p.stock + 1 })} aria-label="More stock">+</button>
            </div>
            <button className="link" onClick={() => setEditing({ ...p, category: p.category.slug, price: (p.priceCents / 100).toFixed(2) })}>Edit</button>
            <label className="switch" title="Listed">
              <input type="checkbox" checked={p.active} onChange={(e) => patch(p, { active: e.target.checked })} />
              <span />
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Merchant() {
  const [store, setStore] = useState(undefined);
  const [tab, setTab] = useState('orders');
  const [data, setData] = useState(null);
  const notify = useToast();
  const seen = useRef(new Set());

  useEffect(() => { api('/merchant/store').then((d) => setStore(d.store)); }, []);

  const loadOrders = useCallback(() => api('/merchant/orders').then((d) => {
    const fresh = d.orders.filter((o) => o.status === 'placed' && !seen.current.has(o.id));
    if (fresh.length && seen.current.size) { beep(); notify(`New order #${fresh[0].code}`, 'ok'); }
    d.orders.forEach((o) => seen.current.add(o.id));
    if (!seen.current.size) seen.current.add(-1);
    setData(d);
  }), [notify]);

  useEffect(() => {
    if (!store) return undefined;
    loadOrders();
    const t = setInterval(loadOrders, 5000);
    return () => clearInterval(t);
  }, [store, loadOrders]);

  if (store === undefined) return <div className="page center pad"><Spinner /></div>;
  if (!store) return <Setup onCreated={setStore} />;

  const toggleOpen = async () => {
    const d = await api('/merchant/store', { method: 'PATCH', body: { isOpen: !store.isOpen } });
    setStore(d.store);
  };

  const live = data?.orders.filter((o) => ['placed', 'accepted', 'preparing', 'ready', 'picked_up'].includes(o.status)) || [];
  const past = data?.orders.filter((o) => !live.includes(o)) || [];

  return (
    <div className="page">
      <div className="console-head">
        <div>
          <p className="eyebrow">Store console</p>
          <h1>{store.name}</h1>
          {store.status !== 'approved' && <p className="banner warn">Your store is {store.status}. You can add products now; customers will see you once approved.</p>}
        </div>
        <button className={`btn ${store.isOpen ? '' : 'btn-ghost'}`} onClick={toggleOpen}>{store.isOpen ? '🟢 Open — tap to close' : '🔴 Closed — tap to open'}</button>
      </div>

      <div className="stats">
        <div><span>Orders today</span><strong>{data?.stats?.todayOrders ?? '–'}</strong></div>
        <div><span>Sales today</span><strong>{data?.stats ? rand(data.stats.todaySalesCents) : '–'}</strong></div>
        <div><span>Live now</span><strong>{live.length}</strong></div>
        <div><span>Rating</span><strong>{store.rating ? `★ ${store.rating}` : 'New'}</strong></div>
      </div>

      <div className="tabs">
        {['orders', 'products', 'settings'].map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>

      {tab === 'orders' && (!data ? <Spinner /> : (
        <>
          {live.length === 0 ? <Empty icon="🧾" title="No live orders">New orders appear here with a sound.</Empty> : (
            <div className="board">{live.map((o) => <OrderCard key={o.id} o={o} onChange={loadOrders} />)}</div>
          )}
          {past.length > 0 && (
            <>
              <h2 className="section-title">Earlier</h2>
              <div className="table">{past.slice(0, 20).map((o) => (
                <div key={o.id} className="trow"><strong>#{o.code}</strong><span className="grow muted small">{o.items.length} items · {o.customer.name}</span><span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span><strong>{rand(o.totals.subtotalCents)}</strong></div>
              ))}</div>
            </>
          )}
        </>
      ))}
      {tab === 'products' && <Products />}
      {tab === 'settings' && <StoreSettings store={store} onSaved={setStore} />}
    </div>
  );
}

function StoreSettings({ store, onSaved }) {
  const notify = useToast();
  const [f, setF] = useState({ description: store.description, prepMinutes: store.prepMinutes, deliveryRadiusKm: store.deliveryRadiusKm, licenceNumber: store.licenceNumber || '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try {
      const d = await api('/merchant/store', { method: 'PATCH', body: f });
      onSaved(d.store);
      notify('Saved', 'ok');
    } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form className="card narrow-card" onSubmit={save}>
      <label className="field"><span>Description</span><textarea value={f.description} onChange={set('description')} /></label>
      <div className="grid-2">
        <label className="field"><span>Packing time (min)</span><input type="number" min="3" max="60" value={f.prepMinutes} onChange={set('prepMinutes')} /></label>
        <label className="field"><span>Delivery radius (km)</span><input type="number" min="1" max="25" value={f.deliveryRadiusKm} onChange={set('deliveryRadiusKm')} /></label>
      </div>
      <label className="field"><span>Licence number</span><input value={f.licenceNumber} onChange={set('licenceNumber')} /></label>
      <p className="small muted">Licence: {store.licenceVerified ? `✅ verified for ${store.licenceCategories.join(', ') || 'no categories yet'}` : store.licenceNumber ? '⏳ awaiting verification' : 'none on file'}. Changing the number sends it back for review.</p>
      <button className="btn">Save settings</button>
    </form>
  );
}

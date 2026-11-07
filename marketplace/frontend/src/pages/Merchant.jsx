import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND, Empty, STATUS, Spinner, api, deliveryTimeLabel, download, rand, setStoreId, useAuth, useMeta, useToast } from '../lib.jsx';
import { resizeToDataUrl } from '../image.js';
import { VerifyAge } from './Checkout.jsx';
import { Columns } from '../charts.jsx';
import '../admin.css';
import '../merchant.css';
import { PushButton } from '../pwa.jsx';
import { Barcode } from '../barcode.jsx';

const clock = (secs) => {
  const s = Math.abs(Math.round(secs));
  return `${secs < 0 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const when = (s, opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-ZA', opts) : '—');
const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
// [key, icon, label, who can see it]
const SECTIONS = [['orders', '🧾', 'Orders', 'packer'], ['menu', '📦', 'Menu', 'packer'], ['insights', '📈', 'Insights', 'manager'], ['promos', '🏷️', 'Promotions', 'manager'],
  ['payouts', '💳', 'Money', 'owner'], ['reviews', '⭐', 'Reviews', 'manager'], ['team', '👥', 'Team', 'manager'], ['store', '🏪', 'Store settings', 'manager']];
const RANK = { packer: 1, manager: 2, owner: 3 };

// A repeating chime while orders are waiting to be accepted, the way a
// kitchen printer keeps beeping until someone deals with the ticket.
let ctx;
function unlockAudio() {
  try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { /* no audio */ }
}
function ding() {
  try {
    if (!ctx) return;
    [0, 0.22].forEach((t, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i ? 1320 : 990;
      g.gain.setValueAtTime(0.3, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.21);
    });
  } catch { /* no audio */ }
}

// ---- Setup (no store yet) ---------------------------------------------------

function Setup({ onCreated, onCancel, branch }) {
  const meta = useMeta();
  const { user } = useAuth();
  const notify = useToast();
  const [f, setF] = useState({ name: '', city: 'johannesburg', address: '', phone: '', description: '', licenceNumber: '', licenceExpiresOn: '' });
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
      {onCancel && <button className="link" onClick={onCancel}>← Back to my store</button>}
      <h1>{branch ? 'Add a branch' : `Open your store on ${BRAND.name}`}</h1>
      <p className="muted">{branch ? 'Each branch has its own menu, orders and team, and is approved separately. You run them all from one login. ' : ''}Reach customers across your city. Riders, payments, tracking and ID checks are handled for you — you pack, we deliver.</p>
      <form className="card" onSubmit={submit}>
        <label className="field"><span>Store name</span><input value={f.name} onChange={set('name')} required /></label>
        <label className="field"><span>City</span>
          <select value={f.city} onChange={set('city')}>{meta?.cities.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
        </label>
        <label className="field"><span>Street address (riders collect here)</span><input value={f.address} onChange={set('address')} required /></label>
        <label className="field"><span>Store phone (for riders and support)</span><input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
        <label className="field"><span>Short description</span><textarea value={f.description} onChange={set('description')} maxLength={400} /></label>
        <div className="grid-2">
          <label className="field"><span>Licence or permit number (if you hold one)</span><input value={f.licenceNumber} onChange={set('licenceNumber')} /></label>
          <label className="field"><span>Licence expiry date</span><input type="date" value={f.licenceExpiresOn} onChange={set('licenceExpiresOn')} /></label>
        </div>
        <button className="btn btn-lg full">Apply</button>
      </form>
    </div>
  );
}

// ---- Orders board --------------------------------------------------------

function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t); }, [ms]);
}

const PRINT_KEY = 'clicknpuff.printer';
function printerSettings() {
  try { return { width: '80', autoPrint: false, ...JSON.parse(localStorage.getItem(PRINT_KEY) || '{}') }; } catch { return { width: '80', autoPrint: false }; }
}
function savePrinter(p) { try { localStorage.setItem(PRINT_KEY, JSON.stringify(p)); } catch { /* private mode */ } }

function Slip({ o, store }) {
  const { width } = printerSettings();
  const live = o.items.filter((i) => !i.unavailable);
  return (
    <div className={`m-slip w-${width}`} id="m-slip">
      <h2>{store.name}</h2>
      <p>Order <strong>#{o.code}</strong> · {when(o.createdAt)}</p>
      <p>For: <strong>{o.customer.name}</strong></p>
      <table><tbody>{live.map((i) => <tr key={i.product_id}><td>☐ {i.qty}×</td><td>{i.name}</td></tr>)}</tbody></table>
      {o.notes && <p>Note: {o.notes}</p>}
      <div className="m-slip-code"><span>Bag code</span><strong>{o.code.slice(-4)}</strong></div>
      <Barcode value={o.code} height={52} module={2} />
      {o.regulated && <p className="m-slip-sealed">SEALED · 18+ ONLY</p>}
      <p className="m-slip-foot">18+ only — rider checks ID at the door</p>
    </div>
  );
}

function OrderCard({ o, onAccept, onDecline, act, onPrint, onSoldOut, onSeal }) {
  useTick();
  const startedAt = useRef(Date.now());
  useEffect(() => { startedAt.current = Date.now(); }, [o.waitingSeconds, o.prepSecondsLeft]);
  const drift = (Date.now() - startedAt.current) / 1000;
  const waited = o.waitingSeconds + drift;
  const prepLeft = o.prepSecondsLeft != null ? o.prepSecondsLeft - drift : null;
  const items = o.items.reduce((n, i) => n + i.qty, 0);
  const waitLeft = o.awaitingUntil ? Math.max(0, (new Date(o.awaitingUntil).getTime() - Date.now()) / 1000) : null;
  return (
    <article className={`m-order lane-${o.lane} ${o.lane === 'new' && waited > 180 ? 'urgent' : ''}`}>
      <header>
        <div><strong className="m-code">#{o.code}</strong> <span className="muted small">{o.customer.name}</span></div>
        {o.lane === 'new' && <span className={`m-timer ${waited > 180 ? 'bad' : ''}`}>{clock(waited)}</span>}
        {o.lane === 'preparing' && prepLeft != null && <span className={`m-timer ${prepLeft < 0 ? 'bad' : prepLeft < 120 ? 'warn' : ''}`}>{prepLeft < 0 ? `${clock(-prepLeft)} late` : `${clock(prepLeft)} left`}</span>}
      </header>
      {o.regulated && <span className="m-badge">🔞 Regulated — seal the bag</span>}
      <ul className="m-items">{o.items.map((i) => <li key={i.product_id} className={i.unavailable ? 'gone' : ''}><b>{i.qty}×</b> {i.name}{i.unavailable && <em> sold out</em>}</li>)}</ul>
      {o.notes && <p className="m-note">📝 {o.notes}</p>}
      {o.awaitingCustomer && <p className="m-await">⏳ Waiting for the customer to decide about the sold-out item{waitLeft != null ? ` (${clock(waitLeft)})` : ''}</p>}
      <p className="m-rider">
        {o.riderAtStore ? <span className="m-here">🛵 {o.rider.name} is at the counter</span>
          : o.rider ? <>🛵 {o.rider.name}{o.lane === 'out' ? ' — on the way to the customer' : o.riderEtaMinutes ? ` arrives in ~${o.riderEtaMinutes} min` : ' — heading to you'}</>
            : o.lane === 'new' ? <>{items} item{items === 1 ? '' : 's'} · {rand(o.totals.subtotalCents)}</>
              : <span className="muted">⏳ Finding a rider…</span>}
      </p>
      <footer>
        {o.lane === 'new' && !o.awaitingCustomer && <>
          <button className="btn btn-ghost" onClick={() => onDecline(o)}>Decline</button>
          <button className="btn grow" onClick={() => onAccept(o)}>Accept</button>
        </>}
        {o.lane === 'new' && o.awaitingCustomer && <button className="btn btn-ghost grow" onClick={() => onDecline(o)}>Decline instead</button>}
        {o.lane === 'preparing' && <>
          <button className="btn btn-ghost" onClick={() => onPrint(o)} aria-label="Print packing slip">🖨️</button>
          <button className="btn grow" onClick={() => (o.regulated ? onSeal(o) : act(o, 'ready'))}>Mark ready</button>
        </>}
        {o.lane === 'ready' && <p className="muted small">{o.riderAtStore ? 'Hand the bag to the rider and check it against the list.' : 'Packed — waiting for the rider.'}</p>}
        {o.lane === 'out' && <p className="muted small">Collected {when(o.milestones.pickedUpAt, { hour: '2-digit', minute: '2-digit' })}</p>}
      </footer>
      {o.lane === 'new' && !o.awaitingCustomer && o.items.length > 0 && <button className="link small m-soldout" onClick={() => onSoldOut(o)}>Something sold out?</button>}
    </article>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="m-modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="m-modal" role="dialog" aria-label={title}>
        <div className="row-between"><h3>{title}</h3><button className="nav-link" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

function Board({ data, reload, setStore }) {
  const notify = useToast();
  const [accepting, setAccepting] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [soldOut, setSoldOut] = useState(null);
  const [soldIds, setSoldIds] = useState([]);
  const [sealing, setSealing] = useState(null);
  const [sealed, setSealed] = useState(false);
  const [lane, setLane] = useState('new');
  const [reason, setReason] = useState('out_of_stock');
  const [note, setNote] = useState('');
  const [meta, setMeta] = useState({ prepChoices: [5, 10, 15, 20, 30], declineReasons: {} });
  useEffect(() => { api('/merchant/store').then((d) => setMeta({ prepChoices: d.prepChoices, declineReasons: d.declineReasons })); }, []);

  const act = async (o, status, extra = {}) => {
    try {
      const d = await api(`/merchant/orders/${o.id}/status`, { method: 'POST', body: { status, ...extra } });
      reload();
      if (status === 'accepted' && printerSettings().autoPrint) print(d.order);
    } catch (e) { notify(e.message, 'bad'); }
  };
  const markSoldOut = async () => {
    try {
      const d = await api(`/merchant/orders/${soldOut.id}/unavailable`, { method: 'POST', body: { productIds: soldIds } });
      notify(d.declined ? 'Nothing left on that order — declined and refunded' : 'Asked the customer — they have 5 minutes to choose', d.declined ? 'bad' : 'ok');
      setSoldOut(null);
      reload();
    } catch (e) { notify(e.message, 'bad'); }
  };
  // While the board is open, printing prints the slip (as before); the
  // class comes off when leaving it so statements print normally.
  useEffect(() => {
    document.body.classList.add('print-slip');
    return () => document.body.classList.remove('print-slip');
  }, []);
  const print = (o) => { setPrinting(o); setTimeout(() => window.print(), 50); };

  const lanes = [['new', 'New'], ['preparing', 'Preparing'], ['ready', 'Ready'], ['out', 'With rider']];
  const byLane = Object.fromEntries(lanes.map(([k]) => [k, data.live.filter((o) => o.lane === k)]));
  const s = data.store;
  const defaultPrep = s.prepMinutes;

  return (
    <>
      {data.lowStock.length > 0 && (() => {
        const out = data.lowStock.filter((p) => p.stock === 0);
        const low = data.lowStock.filter((p) => p.stock > 0);
        return (
          <p className="banner warn small">
            📦 {out.length > 0 && <>Sold out: {out.map((p) => p.name).join(', ')}{low.length ? ' · ' : ''}</>}
            {low.length > 0 && <>Running low: {low.map((p) => `${p.name} (${p.stock} left)`).join(', ')}</>}
          </p>
        );
      })()}
      <div className="m-lane-tabs">
        {lanes.map(([k, l]) => <button key={k} className={lane === k ? 'on' : ''} onClick={() => setLane(k)}>{l}{byLane[k].length ? <b>{byLane[k].length}</b> : null}</button>)}
      </div>
      <div className="m-board">
        {lanes.map(([k, l]) => (
          <section key={k} className={`m-lane ${lane === k ? 'shown' : ''}`}>
            <h3>{l} <span>{byLane[k].length}</span></h3>
            {byLane[k].length === 0 ? <p className="m-empty">{k === 'new' ? 'New orders appear here with a chime.' : 'Nothing here.'}</p>
              : byLane[k].map((o) => <OrderCard key={o.id} o={o} act={act} onPrint={print}
                onSoldOut={(x) => { setSoldIds([]); setSoldOut(x); }} onSeal={(x) => { setSealed(false); setSealing(x); }}
                onAccept={(x) => { unlockAudio(); setAccepting(x); }} onDecline={(x) => { setReason('out_of_stock'); setNote(''); setDeclining(x); }} />)}
          </section>
        ))}
      </div>

      {data.scheduled?.length > 0 && (
        <details className="m-recent" open>
          <summary>🕘 Pre-orders for later ({data.scheduled.length})</summary>
          <p className="muted small">These come to your board as new orders when delivery starts. Check you have the stock.</p>
          <table className="adm-table">
            <tbody>{data.scheduled.map((o) => (
              <tr key={o.id}><td><strong>#{o.code}</strong></td><td>{deliveryTimeLabel(o.scheduledFor)}</td><td>{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</td><td className="num">{rand(o.totals.subtotalCents)}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}
      {data.recent.length > 0 && (
        <details className="m-recent">
          <summary>Finished today ({data.recent.length})</summary>
          <table className="adm-table">
            <tbody>{data.recent.map((o) => (
              <tr key={o.id}><td><strong>#{o.code}</strong></td><td>{o.customer.name}</td><td><span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span></td><td className="muted small">{o.cancelReason || ''}</td><td className="num">{rand(o.totals.subtotalCents)}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}

      {accepting && (
        <Modal title={`Accept #${accepting.code}`} onClose={() => setAccepting(null)}>
          <p className="muted">How long until it's packed? The customer's arrival time updates to match.</p>
          <div className="m-prep">
            {meta.prepChoices.map((m) => (
              <button key={m} className={m === defaultPrep ? 'suggested' : ''} onClick={() => { act(accepting, 'accepted', { prepMinutes: m }); setAccepting(null); }}>
                <strong>{m}</strong><span>min</span>
              </button>
            ))}
          </div>
          <p className="muted small">Suggested: {defaultPrep} min{s.busyExtraMinutes ? ` (includes +${s.busyExtraMinutes} busy time)` : ''}.</p>
        </Modal>
      )}

      {declining && (
        <Modal title={`Decline #${declining.code}?`} onClose={() => setDeclining(null)}>
          <p className="muted">The customer is refunded in full and sees your reason. Declining often lowers your ranking — consider pausing instead if you're swamped.</p>
          {Object.entries(meta.declineReasons).map(([k, l]) => (
            <label key={k} className={`m-reason ${reason === k ? 'on' : ''}`}><input type="radio" name="reason" checked={reason === k} onChange={() => setReason(k)} /> {l}</label>
          ))}
          <label className="field"><span>Add a note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={160} placeholder="e.g. Grinders sold out" /></label>
          <div className="actions">
            <button className="btn btn-ghost" onClick={() => { setDeclining(null); api('/merchant/store', { method: 'PATCH', body: { pauseMinutes: 30 } }).then((d) => setStore(d.store)); }}>Pause 30 min instead</button>
            <button className="btn" onClick={() => { act(declining, 'rejected', { reasonCode: reason, reason: note }); setDeclining(null); }}>Decline order</button>
          </div>
        </Modal>
      )}
      {soldOut && (
        <Modal title={`What's sold out on #${soldOut.code}?`} onClose={() => setSoldOut(null)}>
          <p className="muted">We'll ask the customer to continue without it (refunded for that item) or cancel. They have 5 minutes, then it goes ahead without it. The item is also marked sold out on your menu.</p>
          {soldOut.items.map((i) => (
            <label key={i.product_id} className={`m-reason ${soldIds.includes(i.product_id) ? 'on' : ''}`}>
              <input type="checkbox" checked={soldIds.includes(i.product_id)} onChange={() => setSoldIds((x) => (x.includes(i.product_id) ? x.filter((v) => v !== i.product_id) : [...x, i.product_id]))} />
              {i.qty}× {i.name} <span className="muted small">· {rand(i.qty * i.price_cents)}</span>
            </label>
          ))}
          <div className="actions"><button className="btn" disabled={!soldIds.length} onClick={markSoldOut}>{soldIds.length === soldOut.items.length ? 'All sold out — decline order' : 'Ask the customer'}</button></div>
        </Modal>
      )}

      {sealing && (
        <Modal title={`Seal #${sealing.code}`} onClose={() => setSealing(null)}>
          <p className="muted">This order has regulated items. Before it goes:</p>
          <label className={`m-reason ${sealed ? 'on' : ''}`}><input type="checkbox" checked={sealed} onChange={(e) => setSealed(e.target.checked)} /> The bag is sealed and labelled 18+, with the slip attached</label>
          <div className="actions"><button className="btn" disabled={!sealed} onClick={() => { act(sealing, 'ready', { sealed: true }); setSealing(null); }}>Mark ready</button></div>
        </Modal>
      )}
      {printing && <Slip o={printing} store={s} />}
    </>
  );
}

// ---- Menu ---------------------------------------------------------------------

const WEEK = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

function ProductForm({ categories, mains, initial, onSaved, onCancel }) {
  const notify = useToast();
  const [f, setF] = useState(() => ({
    name: '', category: categories.find((c) => !c.regulated)?.slug, price: '', stock: 10, unit: 'each', description: '', thcPct: '', cbdPct: '', strainType: '',
    variantOf: '', variantLabel: '', featured: false, lowStockAt: 3, availableDays: [], availableFrom: '', availableTo: '',
    ...(initial || {}),
    variantOf: initial?.variantOf || '', variantLabel: initial?.variantLabel || '', availableFrom: initial?.availableFrom || '', availableTo: initial?.availableTo || '',
  }));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const cat = categories.find((c) => c.slug === f.category);
  const parentChoices = mains.filter((m) => m.id !== initial?.id);
  const submit = async (e) => {
    e.preventDefault();
    const body = { ...f, priceCents: Math.round(Number(f.price) * 100), stock: Number(f.stock), lowStockAt: Number(f.lowStockAt), variantOf: f.variantOf ? Number(f.variantOf) : null };
    try {
      if (initial?.id) await api(`/merchant/products/${initial.id}`, { method: 'PATCH', body });
      else await api('/merchant/products', { method: 'POST', body });
      notify('Saved', 'ok');
      onSaved();
    } catch (err) { notify(err.message, 'bad'); }
  };
  const toggleDay = (d) => setF((x) => ({ ...x, availableDays: x.availableDays.includes(d) ? x.availableDays.filter((v) => v !== d) : [...x.availableDays, d] }));
  return (
    <form className="card" onSubmit={submit}>
      <h3>{initial?.id ? `Edit ${initial.name}` : 'New product'}</h3>
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

      <fieldset className="m-fieldset">
        <legend>Sizes & options</legend>
        <p className="muted small">Selling the same thing in sizes or flavours? Make one the main product and add the others as its options — customers pick on one card.</p>
        <div className="grid-2">
          <label className="field"><span>This is an option of</span>
            <select value={f.variantOf} onChange={set('variantOf')}>
              <option value="">— none, it's a main product —</option>
              {parentChoices.map((m) => <option key={m.id} value={m.id}>{m.name}{m.variantLabel ? ` (${m.variantLabel})` : ''}</option>)}
            </select>
          </label>
          <label className="field"><span>Option name</span><input value={f.variantLabel} onChange={set('variantLabel')} placeholder="e.g. Small, 3.5 g, Mint" maxLength={30} /></label>
        </div>
      </fieldset>

      <fieldset className="m-fieldset">
        <legend>When it's on sale</legend>
        <div className="chips">{WEEK.map(([d, l]) => <button key={d} type="button" className={`chip ${f.availableDays.includes(d) ? 'on' : ''}`} onClick={() => toggleDay(d)}>{l}</button>)}</div>
        <p className="muted small">{f.availableDays.length ? 'Only on the days picked.' : 'Every day (pick days to limit it).'}</p>
        <div className="grid-2">
          <label className="field"><span>From (optional)</span><input type="time" value={f.availableFrom} onChange={set('availableFrom')} /></label>
          <label className="field"><span>Until (optional)</span><input type="time" value={f.availableTo} onChange={set('availableTo')} /></label>
        </div>
      </fieldset>

      <div className="grid-2">
        <label className="field"><span>Warn me when stock is at or below</span><input type="number" min="0" max="1000" value={f.lowStockAt} onChange={set('lowStockAt')} /></label>
        <label className="m-check"><input type="checkbox" checked={!!f.featured} onChange={(e) => setF((x) => ({ ...x, featured: e.target.checked }))} /> ⭐ Store pick — show at the top of your store</label>
      </div>
      {cat?.regulated ? <p className="banner warn small">This category only goes live once your licence is verified and covers it.</p> : null}
      <div className="actions"><button className="btn">Save</button><button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function PhotoButton({ p, onDone }) {
  const notify = useToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file) => {
    setBusy(true);
    try {
      const dataUrl = await resizeToDataUrl(file);
      await api(`/merchant/products/${p.id}/photo`, { method: 'POST', body: { dataUrl } });
      notify('Photo saved', 'ok');
      onDone();
    } catch (e) { notify(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <button type="button" className={`m-thumb ${busy ? 'busy' : ''}`} onClick={() => input.current?.click()} title={p.photoUrl ? 'Change photo' : 'Add a photo'} aria-label={p.photoUrl ? `Change photo of ${p.name}` : `Add a photo of ${p.name}`}>
      {p.photoUrl ? <img src={p.photoUrl} alt="" /> : <span>{busy ? '…' : '📷'}</span>}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && pick(e.target.files[0])} />
    </button>
  );
}

function Restock({ onClose }) {
  const [items, setItems] = useState(null);
  const notify = useToast();
  useEffect(() => { api('/merchant/restock').then((d) => setItems(d.items)); }, []);
  return (
    <div className="adm-card">
      <div className="row-between"><h3>Restock list</h3><button className="nav-link" onClick={onClose} aria-label="Close">✕</button></div>
      <p className="muted small">Enough to cover the next 7 days at your last 2 weeks' sales, plus anything at or below its low-stock line.</p>
      {!items ? <Spinner /> : items.length === 0 ? <p className="muted">✅ Nothing to reorder right now.</p> : (
        <>
          <table className="adm-table">
            <thead><tr><th>Product</th><th className="num">In stock</th><th className="num">Sold (14 days)</th><th className="num">Order</th></tr></thead>
            <tbody>{items.map((r) => <tr key={r.id}><td>{r.name}</td><td className="num">{r.stock}</td><td className="num">{r.soldLast14Days}</td><td className="num"><strong>{r.suggestedOrder}</strong></td></tr>)}</tbody>
          </table>
          <button className="btn btn-ghost adm-gap" onClick={() => download('/merchant/restock?format=csv', 'restock-list.csv').catch((e) => notify(e.message, 'bad'))}>⬇ Download for your supplier</button>
        </>
      )}
    </div>
  );
}

function ImportExport({ onClose, onDone }) {
  const notify = useToast();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (apply) => {
    setBusy(true);
    try {
      const d = await api('/merchant/products/import', { method: 'POST', body: { csv: text, apply } });
      setPreview(d);
      if (d.applied) { notify(`Menu updated — ${d.created} added, ${d.updated} changed`, 'ok'); onDone(); }
    } catch (e) { notify(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <div className="adm-card">
      <div className="row-between"><h3>Spreadsheet import / export</h3><button className="nav-link" onClick={onClose} aria-label="Close">✕</button></div>
      <ol className="m-steps">
        <li><button className="link" onClick={() => download('/merchant/products.csv', 'menu.csv').catch((e) => notify(e.message, 'bad'))}>⬇ Download your menu</button> as a spreadsheet (opens in Excel or Google Sheets).</li>
        <li>Change prices, stock or anything else; add new rows at the bottom (leave <code>id</code> empty for new products).</li>
        <li>Save it as CSV and upload it here. You'll see what will change before anything does.</li>
      </ol>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files[0]; if (f) { setText(await f.text()); setPreview(null); } }} aria-label="Choose a CSV file" />
      {text && !preview && <button className="btn adm-gap" disabled={busy} onClick={() => run(false)}>Check the file</button>}
      {preview && (
        <div className="adm-gap">
          <p><strong>{preview.created}</strong> new · <strong>{preview.updated}</strong> changed · {preview.unchanged || 0} the same · <strong className={preview.errors ? 'm-bad' : ''}>{preview.errors}</strong> with problems</p>
          {preview.errors > 0 && (
            <ul className="m-errors">{preview.rows.filter((r) => r.action === 'error').map((r) => <li key={r.row}>Row {r.row}{r.name ? ` (${r.name})` : ''}: {r.error}</li>)}</ul>
          )}
          {!preview.applied && (preview.errors
            ? <p className="muted small">Fix those rows and upload again — nothing has been changed.</p>
            : preview.created + preview.updated === 0 ? <p className="muted small">Nothing to change — the file matches your menu.</p>
            : <button className="btn" disabled={busy} onClick={() => run(true)}>Apply {preview.created + preview.updated} change{preview.created + preview.updated === 1 ? '' : 's'}</button>)}
        </div>
      )}
    </div>
  );
}

function Menu({ role }) {
  const canEdit = role !== 'packer';
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [panel, setPanel] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const notify = useToast();
  const load = useCallback(() => api('/merchant/products').then(setData), []);
  useEffect(() => { load(); }, [load]);
  const shown = useMemo(() => (data?.products || []).filter((p) => (!q || `${p.name} ${p.variantLabel || ''}`.toLowerCase().includes(q.toLowerCase()))
    && (filter === 'all' || (filter === 'low' && p.lowStock) || (filter === 'out' && p.active && !p.inStock) || (filter === 'hidden' && (!p.active || p.blockedReason || !p.availableNow)) || (filter === 'picks' && p.featured) || (filter === 'nophoto' && !p.photoUrl) || filter === p.category.slug)), [data, q, filter]);
  if (!data) return <Spinner />;
  const patch = async (p, body, msg) => {
    try { await api(`/merchant/products/${p.id}`, { method: 'PATCH', body }); if (msg) notify(msg, 'ok'); load(); } catch (e) { notify(e.message, 'bad'); }
  };
  const counts = { low: data.products.filter((p) => p.lowStock).length, out: data.products.filter((p) => p.active && !p.inStock).length, nophoto: data.products.filter((p) => !p.photoUrl).length };
  const cats = [...new Map(data.products.map((p) => [p.category.slug, p.category])).values()];
  const mains = data.products.filter((p) => !p.variantOf);
  const nameOf = (id) => data.products.find((x) => x.id === id)?.name;
  if (editing) return <ProductForm categories={data.categories} mains={mains} initial={editing === 'new' ? null : editing} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />;
  return (
    <>
      <div className="adm-toolbar">
        <input className="adm-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your menu" aria-label="Search menu" />
        <div className="actions">
          {canEdit && <>
            <button className="btn btn-ghost" onClick={() => setPanel(panel === 'restock' ? null : 'restock')}>📋 Restock list</button>
            <button className="btn btn-ghost" onClick={() => setPanel(panel === 'import' ? null : 'import')}>⇅ Import / export</button>
            <button className="btn" onClick={() => setEditing('new')}>+ Add product</button>
          </>}
        </div>
      </div>
      {panel === 'restock' && <Restock onClose={() => setPanel(null)} />}
      {panel === 'import' && <ImportExport onClose={() => setPanel(null)} onDone={load} />}
      <div className="chips">
        <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All {data.products.length}</button>
        <button className={`chip ${filter === 'low' ? 'on' : ''}`} onClick={() => setFilter('low')}>Low stock {counts.low}</button>
        <button className={`chip ${filter === 'out' ? 'on' : ''}`} onClick={() => setFilter('out')}>Sold out {counts.out}</button>
        <button className={`chip ${filter === 'nophoto' ? 'on' : ''}`} onClick={() => setFilter('nophoto')}>No photo {counts.nophoto}</button>
        <button className={`chip ${filter === 'picks' ? 'on' : ''}`} onClick={() => setFilter('picks')}>⭐ Picks</button>
        <button className={`chip ${filter === 'hidden' ? 'on' : ''}`} onClick={() => setFilter('hidden')}>Hidden</button>
        {cats.map((c) => <button key={c.slug} className={`chip ${filter === c.slug ? 'on' : ''}`} onClick={() => setFilter(c.slug)}>{c.icon} {c.name}</button>)}
      </div>
      {canEdit && counts.nophoto > 0 && filter === 'all' && <p className="muted small">📷 Products with photos sell noticeably better — tap the camera on any product to add one.</p>}
      <div className="m-menu">
        {shown.length === 0 && <p className="muted">Nothing matches.</p>}
        {shown.map((p) => (
          <div key={p.id} className={`m-product ${!p.live ? 'dim' : ''} ${p.variantOf ? 'is-option' : ''}`}>
            {canEdit ? <PhotoButton p={p} onDone={load} /> : <span className="m-thumb">{p.photoUrl ? <img src={p.photoUrl} alt="" /> : '📦'}</span>}
            <div className="grow">
              <strong>{p.name}{p.variantLabel && <span className="muted"> · {p.variantLabel}</span>}</strong>
              <p className="muted small">
                {p.variantOf && <>Option of {nameOf(p.variantOf)} · </>}
                {rand(p.priceCents)} / {p.unit} · {p.soldThisWeek} sold this week ·{' '}
                {!p.active ? 'switched off' : p.blockedReason ? `hidden — ${p.blockedReason}` : !p.availableNow ? <b className="m-warn">{p.availabilityNote}</b> : !p.inStock ? <b className="m-bad">sold out</b> : p.lowStock ? <b className="m-warn">only {p.stock} left</b> : 'live'}
              </p>
            </div>
            {canEdit && <button className={`m-star ${p.featured ? 'on' : ''}`} onClick={() => patch(p, { featured: !p.featured }, p.featured ? 'Removed from store picks' : 'Added to store picks')} aria-pressed={p.featured} aria-label={`${p.featured ? 'Remove' : 'Make'} ${p.name} a store pick`}>{p.featured ? '⭐' : '☆'}</button>}
            <div className="stepper">
              <button onClick={() => patch(p, { stock: Math.max(0, p.stock - 1) })} aria-label={`Less ${p.name}`}>−</button>
              <span>{p.stock}</span>
              <button onClick={() => patch(p, { stock: p.stock + 1 })} aria-label={`More ${p.name}`}>+</button>
            </div>
            {p.inStock
              ? <button className="btn btn-sm btn-ghost" onClick={() => patch(p, { stock: 0 }, `${p.name} marked sold out`)}>Sold out</button>
              : <button className="btn btn-sm" onClick={() => patch(p, { stock: Math.max(10, p.lowStockAt * 2) }, `${p.name} back in stock`)}>Restock</button>}
            {canEdit && <button className="link" onClick={() => setEditing({ ...p, category: p.category.slug, price: (p.priceCents / 100).toFixed(2) })}>Edit</button>}
            <label className="switch" title={p.active ? 'Listed' : 'Not listed'}>
              <input type="checkbox" checked={p.active} onChange={(e) => patch(p, { active: e.target.checked })} aria-label={`List ${p.name}`} />
              <span />
            </label>
          </div>
        ))}
      </div>
    </>
  );
}

// ---- Insights -------------------------------------------------------------------

function Insights() {
  const [days, setDays] = useState(7);
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api(`/merchant/insights?days=${days}`).then(setD); }, [days]);
  if (!d) return <Spinner />;
  const t = d.totals;
  const label = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
  const series = d.series.map((x, i) => ({ key: x.day, label: label(x.day), short: i === d.series.length - 1 ? 'Today' : new Date(x.day + 'T12:00:00Z').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }), value: x.salesCents, extra: `${x.orders} order${x.orders === 1 ? '' : 's'}` }));
  const hourly = d.hourly.map((h) => ({ key: h.hour, label: `${String(h.hour).padStart(2, '0')}:00`, tick: h.hour % 3 === 0 ? `${h.hour}h` : '', value: h.orders }));
  const busiest = d.hourly.reduce((a, b) => (b.orders > a.orders ? b : a), { hour: null, orders: 0 });
  return (
    <>
      <div className="adm-seg m-range">
        <button className={days === 7 ? 'on' : ''} onClick={() => setDays(7)}>Last 7 days</button>
        <button className={days === 30 ? 'on' : ''} onClick={() => setDays(30)}>Last 30 days</button>
      </div>
      <div className="m-stats">
        <div><span>Sales</span><strong>{rand(t.salesCents)}</strong><em>item totals, delivered</em></div>
        <div><span>Orders</span><strong>{t.orders}</strong><em>delivered</em></div>
        <div><span>Average order</span><strong>{rand(t.avgOrderCents)}</strong><em>per delivery</em></div>
        <div><span>Prep time</span><strong>{t.avgPrepMinutes != null ? `${t.avgPrepMinutes} min` : '—'}</strong><em>accept → ready</em></div>
        <div><span>Acceptance</span><strong>{t.acceptanceRate != null ? `${t.acceptanceRate}%` : '—'}</strong><em>orders you took</em></div>
        <div><span>Rating</span><strong>{t.rating ? `★ ${t.rating}` : 'New'}</strong><em>{t.ratingCount} review{t.ratingCount === 1 ? '' : 's'}</em></div>
      </div>
      <div className="adm-two">
        <section className="adm-card">
          <h3>Sales per day</h3>
          <Columns data={series} format={(v, axis) => (axis && v >= 100000 ? `R${Math.round(v / 100000)}K` : rand(v))} label="Sales per day" highlightLast />
        </section>
        <section className="adm-card">
          <h3>When customers order</h3>
          <Columns data={hourly} format={(v) => String(Math.round(v))} label="Orders by hour of day" />
          <p className="muted small">{busiest.orders ? `Busiest around ${busiest.hour}:00 — have stock packed and staff on hand.` : 'Not enough orders yet to show a pattern.'}</p>
        </section>
      </div>
      {d.customers && (
        <div className="adm-two">
          <section className="adm-card">
            <h3>Customers</h3>
            <div className="m-stats m-stats-tight">
              <div><span>Customers</span><strong>{d.customers.total}</strong></div>
              <div><span>New to you</span><strong>{d.customers.new}</strong></div>
              <div><span>Came back</span><strong>{d.customers.returning}</strong></div>
              <div><span>Repeat rate</span><strong>{d.customers.repeatRate == null ? '—' : `${d.customers.repeatRate}%`}</strong></div>
            </div>
            <p className="muted small">{d.customers.total ? (d.customers.repeatRate >= 40 ? 'Good loyalty — people come back.' : 'Try a promo code for second orders to bring people back.') : 'No deliveries in this period yet.'}</p>
          </section>
          <section className="adm-card">
            <h3>Top suburbs</h3>
            {d.customers.topSuburbs.length === 0 ? <p className="muted">No deliveries in this period yet.</p> : (
              <table className="adm-table">
                <thead><tr><th>Suburb</th><th className="num">Orders</th><th className="num">Sales</th></tr></thead>
                <tbody>{d.customers.topSuburbs.map((x) => <tr key={x.suburb}><td>{x.suburb}</td><td className="num">{x.orders}</td><td className="num">{rand(x.salesCents)}</td></tr>)}</tbody>
              </table>
            )}
          </section>
        </div>
      )}
      <section className="adm-card">
        <h3>Best sellers</h3>
        {d.topProducts.length === 0 ? <p className="muted">No deliveries in this period yet.</p> : (
          <table className="adm-table">
            <thead><tr><th>Product</th><th className="num">Sold</th><th className="num">Sales</th></tr></thead>
            <tbody>{d.topProducts.map((p) => <tr key={p.id}><td>{p.name}</td><td className="num">{p.qty}</td><td className="num">{rand(p.salesCents)}</td></tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

// ---- Payouts and reviews -------------------------------------------------

const todaySast = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 2 * 3600e3 - n * 864e5).toISOString().slice(0, 10);

function BankForm({ billing, onSaved, onCancel }) {
  const notify = useToast();
  const [f, setF] = useState({ bankName: billing.bank?.bankName || '', accountHolder: billing.bank?.accountHolder || '', accountNumber: '', branchCode: billing.bank?.branchCode || '', accountType: billing.bank?.accountType || 'cheque', password: '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const pickBank = (e) => {
    const b = billing.banks.find((x) => x.name === e.target.value);
    setF((x) => ({ ...x, bankName: e.target.value, branchCode: b?.branchCode || x.branchCode }));
  };
  const submit = async (e) => {
    e.preventDefault();
    try {
      const d = await api('/merchant/bank', { method: 'PUT', body: f });
      notify('Bank details saved', 'ok');
      onSaved(d.bank);
    } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form onSubmit={submit}>
      <div className="grid-2">
        <label className="field"><span>Bank</span>
          <select value={f.bankName} onChange={pickBank} required><option value="">Choose…</option>{billing.banks.map((b) => <option key={b.name}>{b.name}</option>)}</select>
        </label>
        <label className="field"><span>Account type</span>
          <select value={f.accountType} onChange={set('accountType')}>{billing.accountTypes.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select>
        </label>
        <label className="field"><span>Account holder</span><input value={f.accountHolder} onChange={set('accountHolder')} required autoComplete="off" /></label>
        <label className="field"><span>Account number</span><input value={f.accountNumber} onChange={set('accountNumber')} inputMode="numeric" required autoComplete="off" placeholder={billing.bank ? `Currently ${billing.bank.accountNumber}` : ''} /></label>
        <label className="field"><span>Branch code</span><input value={f.branchCode} onChange={set('branchCode')} inputMode="numeric" required /></label>
        <label className="field"><span>Your password</span><input type="password" value={f.password} onChange={set('password')} required autoComplete="current-password" /></label>
      </div>
      <p className="muted small">🔒 For your safety we ask for your password whenever bank details change, and our team confirms new details with you before the next payout.</p>
      <div className="actions"><button className="btn">Save bank details</button>{onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}</div>
    </form>
  );
}

function TaxForm({ tax, onSaved }) {
  const notify = useToast();
  const [f, setF] = useState(tax);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    try { const d = await api('/merchant/tax', { method: 'PUT', body: f }); notify('Tax details saved', 'ok'); onSaved(d.tax); } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form onSubmit={submit}>
      <div className="grid-2">
        <label className="field"><span>Registered business name</span><input value={f.legalName} onChange={set('legalName')} placeholder="e.g. RB Trading (Pty) Ltd" /></label>
        <label className="field"><span>Company registration no.</span><input value={f.companyReg} onChange={set('companyReg')} placeholder="e.g. 2021/123456/07" /></label>
        <label className="field"><span>VAT number (if registered)</span><input value={f.vatNumber} onChange={set('vatNumber')} inputMode="numeric" placeholder="10 digits, starts with 4" /></label>
      </div>
      <p className="muted small">With a VAT number, customers get a proper tax invoice from your business for the goods. Without one, the invoice says you aren't VAT-registered.</p>
      <div className="actions"><button className="btn btn-ghost">Save tax details</button></div>
    </form>
  );
}

function Money() {
  const notify = useToast();
  const [d, setD] = useState(null);
  const [billing, setBilling] = useState(null);
  const [editBank, setEditBank] = useState(false);
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(todaySast());
  const load = useCallback(() => { api('/merchant/payouts').then(setD); api('/merchant/billing').then(setBilling); }, []);
  useEffect(() => { load(); }, [load]);
  if (!d || !billing) return <Spinner />;
  const weekLabel = (w) => {
    const a = new Date(w + 'T12:00:00Z');
    const b = new Date(a.getTime() + 6 * 864e5);
    return `${a.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} – ${b.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}`;
  };
  const range = `from=${from}&to=${to}`;
  return (
    <>
      <div className="m-stats">
        <div><span>Owed to you now</span><strong>{rand(d.balanceCents)}</strong><em>paid out weekly by EFT</em></div>
        <div><span>Earned, all time</span><strong>{rand(d.earnedCents)}</strong></div>
        <div><span>Paid to you, all time</span><strong>{rand(d.paidCents)}</strong></div>
      </div>
      {!d.bank && <p className="banner warn">Add your bank details so we can pay you.</p>}

      <div className="card">
        <div className="row-between"><h3>🏦 Bank account</h3>{d.bank && !editBank && <button className="link" onClick={() => setEditBank(true)}>Change</button>}</div>
        {d.bank && !editBank ? (
          <p>{d.bank.bankName} · {d.bank.accountType} · <strong>{d.bank.accountNumber}</strong> · branch {d.bank.branchCode}<br /><span className="muted small">{d.bank.accountHolder}{d.bank.updatedAt ? ` · updated ${when(d.bank.updatedAt, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</span></p>
        ) : <BankForm billing={billing} onSaved={() => { setEditBank(false); load(); }} onCancel={d.bank ? () => setEditBank(false) : null} />}
      </div>

      <div className="card">
        <h3>📄 Statement</h3>
        <div className="m-range">
          <label className="field"><span>From</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span>To</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <div className="actions">
            <a className="btn" href={`/merchant/statement?${range}`} target="_blank" rel="noreferrer">View / save as PDF</a>
            <button className="btn btn-ghost" onClick={() => download(`/merchant/statement?${range}&format=csv`, `statement-${from}-to-${to}.csv`).catch((e) => notify(e.message, 'bad'))}>⬇ Spreadsheet (CSV)</button>
          </div>
        </div>
        <p className="muted small">{d.note}</p>
      </div>

      <div className="card">
        <h3>💸 Payouts</h3>
        {d.payouts.length === 0 ? <p className="muted">No payouts yet. They go out weekly once you have a balance and bank details.</p> : (
          <table className="adm-table">
            <thead><tr><th>Paid</th><th>Reference</th><th className="num">Amount</th></tr></thead>
            <tbody>{d.payouts.map((p) => <tr key={p.id}><td>{when(p.paidAt, { day: 'numeric', month: 'short', year: 'numeric' })}</td><td>{p.reference}</td><td className="num"><strong>{rand(p.amountCents)}</strong></td></tr>)}</tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>📅 Earnings by week</h3>
        {d.weeks.length === 0 ? <Empty icon="💳" title="Nothing yet">Your weekly earnings appear here after your first delivery.</Empty> : (
          <table className="adm-table">
            <thead><tr><th>Week</th><th className="num">Orders</th><th className="num">Sales</th><th className="num">Your promos</th><th className="num">Refunds</th><th className="num">Earned</th></tr></thead>
            <tbody>{d.weeks.map((w) => (
              <tr key={w.weekStart}><td>{weekLabel(w.weekStart)}</td><td className="num">{w.orders}</td><td className="num">{rand(w.salesCents)}</td>
                <td className="num">{w.storePromoCents ? `−${rand(w.storePromoCents)}` : '—'}</td><td className="num">{w.storeRefundCents ? `−${rand(w.storeRefundCents)}` : '—'}</td><td className="num"><strong>{rand(w.earnedCents)}</strong></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>🧾 Tax details</h3>
        <TaxForm tax={billing.tax} onSaved={(tax) => setBilling({ ...billing, tax })} />
      </div>
    </>
  );
}

function PromoForm({ onSaved, onCancel }) {
  const notify = useToast();
  const [f, setF] = useState({ code: '', kind: 'percent', value: '10', minSpend: '', maxOff: '', perUserLimit: '1', expiresAt: '', description: '', public: true });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    const body = {
      code: f.code, kind: f.kind, value: f.kind === 'percent' ? Number(f.value) : Math.round(Number(f.value) * 100),
      minSubtotalCents: Math.round(Number(f.minSpend || 0) * 100), maxDiscountCents: f.kind === 'percent' && f.maxOff ? Math.round(Number(f.maxOff) * 100) : null,
      perUserLimit: Number(f.perUserLimit), expiresAt: f.expiresAt || null, description: f.description, public: f.public,
    };
    try { await api('/merchant/promos', { method: 'POST', body }); notify(`${f.code.toUpperCase()} is live`, 'ok'); onSaved(); } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>New promo code</h3>
      <div className="grid-2">
        <label className="field"><span>Code</span><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} maxLength={16} placeholder="e.g. ROSE15" required /></label>
        <label className="field"><span>Type</span>
          <select value={f.kind} onChange={set('kind')}><option value="percent">Percentage off</option><option value="fixed">Rand amount off</option></select>
        </label>
        <label className="field"><span>{f.kind === 'percent' ? '% off' : 'R off'}</span><input type="number" min="1" max={f.kind === 'percent' ? 50 : 1000} step={f.kind === 'percent' ? 1 : 0.01} value={f.value} onChange={set('value')} required /></label>
        <label className="field"><span>Minimum spend (R, optional)</span><input type="number" min="0" step="0.01" value={f.minSpend} onChange={set('minSpend')} /></label>
        {f.kind === 'percent' && <label className="field"><span>Most it takes off (R, optional)</span><input type="number" min="0" step="0.01" value={f.maxOff} onChange={set('maxOff')} /></label>}
        <label className="field"><span>Uses per customer</span><input type="number" min="1" max="20" value={f.perUserLimit} onChange={set('perUserLimit')} /></label>
        <label className="field"><span>Last day (optional)</span><input type="date" value={f.expiresAt} min={todaySast()} onChange={set('expiresAt')} /></label>
        <label className="field"><span>Description (optional)</span><input value={f.description} onChange={set('description')} maxLength={120} placeholder="We'll write one if you leave it" /></label>
      </div>
      <label className="m-check"><input type="checkbox" checked={f.public} onChange={(e) => setF({ ...f, public: e.target.checked })} /> Show it on my store page (untick to share it only yourself, e.g. on Instagram)</label>
      <p className="muted small">Your store pays for its own codes: the discount comes off your payout for that order. Codes only work at your store.</p>
      <div className="actions"><button className="btn">Create code</button><button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function Promotions() {
  const notify = useToast();
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api('/merchant/promos').then((d) => setList(d.promos)), []);
  useEffect(() => { load(); }, [load]);
  if (!list) return <Spinner />;
  if (adding) return <PromoForm onSaved={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />;
  const toggle = async (p) => {
    try { await api(`/merchant/promos/${p.code}`, { method: 'PATCH', body: { active: !p.active } }); notify(p.active ? `${p.code} switched off` : `${p.code} is live`, 'ok'); load(); } catch (e) { notify(e.message, 'bad'); }
  };
  return (
    <>
      <div className="adm-toolbar"><p className="muted">Bring customers back with your own codes. You choose the discount; it comes off your payout only when an order is delivered.</p><button className="btn" onClick={() => setAdding(true)}>+ New code</button></div>
      {list.length === 0 ? <Empty icon="🏷️" title="No promo codes yet">Try 10% off for new customers, or R50 off orders over R400.</Empty> : (
        <table className="adm-table">
          <thead><tr><th>Code</th><th>Offer</th><th className="num">Orders</th><th className="num">Sales</th><th className="num">Discount given</th><th>Status</th><th /></tr></thead>
          <tbody>{list.map((p) => (
            <tr key={p.code}>
              <td><strong>{p.code}</strong>{!p.public && <span className="muted small"> · private</span>}</td>
              <td>{p.description}{p.expiresAt && <span className="muted small"><br />until {when(p.expiresAt, { day: 'numeric', month: 'short' })}</span>}</td>
              <td className="num">{p.uses}</td><td className="num">{rand(p.salesCents)}</td><td className="num">{rand(p.discountGivenCents)}</td>
              <td>{p.expired ? <span className="status s-cancelled">Ended</span> : p.active ? <span className="status s-approved">Live</span> : <span className="status s-placed">Off</span>}</td>
              <td>{!p.expired && <button className="link" onClick={() => toggle(p)}>{p.active ? 'Switch off' : 'Switch on'}</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </>
  );
}

function TeamAndActivity({ role }) {
  const notify = useToast();
  const [team, setTeam] = useState(null);
  const [log, setLog] = useState(null);
  const [f, setF] = useState({ name: '', email: '', role: 'packer' });
  const [invite, setInvite] = useState(null);
  const owner = role === 'owner';
  const load = useCallback(() => {
    if (owner) api('/merchant/team').then(setTeam);
    api('/merchant/activity').then((d) => setLog(d.entries));
  }, [owner]);
  useEffect(() => { load(); }, [load]);
  const add = async (e) => {
    e.preventDefault();
    try {
      const d = await api('/merchant/team', { method: 'POST', body: f });
      setInvite({ ...f, password: d.temporaryPassword });
      setF({ name: '', email: '', role: 'packer' });
      load();
    } catch (err) { notify(err.message, 'bad'); }
  };
  const change = async (m, body, msg) => {
    try { await api(`/merchant/team/${m.id}`, body ? { method: 'PATCH', body } : { method: 'DELETE' }); notify(msg, 'ok'); load(); } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <div className="adm-two">
      {owner && (
        <section className="adm-card">
          <h3>👥 Team</h3>
          {!team ? <Spinner /> : (
            <>
              <ul className="m-team">
                {team.members.map((m) => (
                  <li key={m.id}>
                    <div className="grow"><strong>{m.name}</strong> <span className="muted small">{m.email}</span><br />
                      <span className="muted small">{m.invited ? 'Invited — hasn’t set a password yet' : m.lastLoginAt ? `Last signed in ${when(m.lastLoginAt)}` : 'Never signed in'}</span></div>
                    {m.role === 'owner' ? <span className="status s-approved">Owner</span> : (
                      <>
                        <select value={m.role} onChange={(e) => change(m, { role: e.target.value }, `${m.name} is now a ${e.target.value}`)} aria-label={`Role for ${m.name}`}>
                          <option value="packer">Packer</option><option value="manager">Manager</option>
                        </select>
                        <button className="link" onClick={() => window.confirm(`Remove ${m.name}? They lose access straight away.`) && change(m, null, `${m.name} removed`)}>Remove</button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {invite ? (
                <div className="banner adm-gap">
                  <p><strong>Send {invite.name || invite.email} their login</strong> (shown once):</p>
                  <p>Sign in at <b>{window.location.origin}/login</b><br />Email: <b>{invite.email}</b><br />{invite.password ? <>Temporary password: <code>{invite.password}</code></> : 'They use the password they already have.'}</p>
                  <div className="actions">
                    {invite.password && <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(`ClickNPuff store login\n${window.location.origin}/login\nEmail: ${invite.email}\nTemporary password: ${invite.password}`).then(() => notify('Copied', 'ok'))}>Copy</button>}
                    <button className="btn btn-sm btn-ghost" onClick={() => setInvite(null)}>Done</button>
                  </div>
                </div>
              ) : (
                <form className="adm-gap" onSubmit={add}>
                  <h4>Add someone</h4>
                  <div className="grid-2">
                    <label className="field"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
                    <label className="field"><span>Work email</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
                  </div>
                  <div className="m-roles">
                    {team.roles.map((r) => (
                      <label key={r.role} className={`m-role ${f.role === r.role ? 'on' : ''}`}>
                        <input type="radio" name="role" checked={f.role === r.role} onChange={() => setF({ ...f, role: r.role })} />
                        <strong>{r.label}</strong><span className="muted small">{r.can}</span>
                      </label>
                    ))}
                  </div>
                  <p className="muted small">Everyone on your team must be 18 or older. Only you can see money, bank details and the team.</p>
                  <button className="btn">Add to team</button>
                </form>
              )}
            </>
          )}
        </section>
      )}
      <section className="adm-card">
        <h3>📜 Activity</h3>
        <p className="muted small">Who did what in your store, newest first.</p>
        {!log ? <Spinner /> : log.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <ul className="m-activity">
            {log.map((e) => (
              <li key={e.id}><span className="muted small">{when(e.at)}</span> <b>{e.by}</b> · {e.label}{e.detail ? <span className="muted"> — {e.detail}</span> : null}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ChooseOwnPassword() {
  const { user, setUser } = useAuth();
  const notify = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  if (!user?.mustChangePassword) return null;
  const save = async (e) => {
    e.preventDefault();
    try {
      await api('/me/password', { method: 'POST', body: f });
      setUser({ ...user, mustChangePassword: false });
      notify('Password saved', 'ok');
    } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <form className="card m-own-pass" onSubmit={save}>
      <h3>🔐 Choose your own password</h3>
      <p className="muted small">You signed in with a temporary password. Pick one only you know before you start.</p>
      <div className="grid-2">
        <label className="field"><span>Temporary password</span><input type="password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required autoComplete="current-password" /></label>
        <label className="field"><span>New password (10+ characters)</span><input type="password" minLength={10} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} required autoComplete="new-password" /></label>
      </div>
      <button className="btn">Save password</button>
    </form>
  );
}

function LicenceBanner({ store, go }) {
  const l = store.licence;
  if (!l || (!l.expired && l.daysLeft > 60)) return null;
  return (
    <p className={`banner ${l.expired || l.daysLeft <= 7 ? 'warn' : ''} m-licence`}>
      {l.expired ? '⚠️ Your licence expired — regulated products are hidden from customers.' : `🪪 Your licence expires in ${l.daysLeft} day${l.daysLeft === 1 ? '' : 's'} (${l.expiresOn}).`}
      {' '}<button className="link" onClick={() => go('store')}>Add the renewal</button>
    </p>
  );
}

function StoreSwitcher({ stores, current, role, onAdd }) {
  if (stores.length < 2 && role !== 'owner') return null;
  const pick = (id) => { setStoreId(id); window.location.reload(); };
  return (
    <div className="m-switch">
      {stores.length > 1 && (
        <select value={current} onChange={(e) => pick(e.target.value)} aria-label="Choose a store">
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'pending' ? ' (awaiting approval)' : ''}{s.role !== 'owner' ? ` · ${s.role}` : ''}</option>)}
        </select>
      )}
      {role === 'owner' && <button className="link small" onClick={onAdd}>+ Add a branch</button>}
    </div>
  );
}

function Reviews({ onReplied }) {
  const [d, setD] = useState(null);
  const [drafts, setDrafts] = useState({});
  const notify = useToast();
  const load = useCallback(() => api('/merchant/reviews').then(setD), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <Spinner />;
  const max = Math.max(1, ...d.distribution.map((x) => x.count));
  const reply = async (r) => {
    try { await api(`/merchant/reviews/${r.id}/reply`, { method: 'POST', body: { reply: drafts[r.id] } }); notify('Reply posted', 'ok'); load(); onReplied?.(); } catch (e) { notify(e.message, 'bad'); }
  };
  return (
    <>
      <div className="m-rating">
        <div className="m-rating-big"><strong>{d.rating ?? '—'}</strong><span>★ from {d.ratingCount} review{d.ratingCount === 1 ? '' : 's'}</span></div>
        <div className="m-dist">
          {d.distribution.map((x) => (
            <div key={x.stars} className="m-dist-row"><span>{x.stars}★</span><i><b style={{ width: `${(x.count / max) * 100}%` }} /></i><span>{x.count}</span></div>
          ))}
        </div>
      </div>
      {d.reviews.length === 0 ? <Empty icon="⭐" title="No reviews yet">Reviews from customers show up here — reply to thank them or put things right.</Empty>
        : d.reviews.map((r) => (
          <div key={r.id} className={`card ${r.rating <= 3 && !r.reply ? 'm-needs-reply' : ''}`}>
            {r.rating <= 3 && !r.reply && <p className="m-reply-nudge">💬 Reply needed — a kind, quick answer (and a fix) wins most unhappy customers back, and others see you care.</p>}
            <div className="row-between"><strong className="m-stars">{'★'.repeat(r.rating)}<span>{'★'.repeat(5 - r.rating)}</span></strong><span className="muted small">{r.name} · #{r.orderCode} · {when(r.at, { dateStyle: 'medium' })}</span></div>
            {r.comment ? <p>{r.comment}</p> : <p className="muted small">No comment.</p>}
            {r.reply ? <p className="m-reply"><b>Your reply:</b> {r.reply}</p> : (
              <div className="m-reply-form">
                <input value={drafts[r.id] || ''} onChange={(e) => setDrafts({ ...drafts, [r.id]: e.target.value })} placeholder="Reply publicly…" maxLength={500} aria-label="Reply to review" />
                <button className="btn btn-sm" onClick={() => reply(r)} disabled={!drafts[r.id]?.trim()}>Reply</button>
              </div>
            )}
          </div>
        ))}
    </>
  );
}

// ---- Store settings ---------------------------------------------------------

function CounterSettings({ store, onSaved }) {
  const notify = useToast();
  const [p, setP] = useState(printerSettings());
  const update = (next) => { setP(next); savePrinter(next); };
  return (
    <div className="adm-card">
      <h3>Counter</h3>
      <label className="switch-row">
        <div><strong>Accept orders automatically</strong><p className="muted small">Every new order is accepted straight away at your usual packing time. Use it when you're confident about your stock.</p></div>
        <span className="switch"><input type="checkbox" checked={store.autoAccept} aria-label="Accept orders automatically" onChange={(e) => api('/merchant/store', { method: 'PATCH', body: { autoAccept: e.target.checked } }).then((d) => { onSaved(d.store); notify(e.target.checked ? 'New orders will be accepted automatically' : 'Auto-accept off', 'ok'); })} /><span /></span>
      </label>
      <h4 className="adm-gap">Printer on this device</h4>
      <label className="field"><span>Paper</span>
        <select value={p.width} onChange={(e) => update({ ...p, width: e.target.value })}>
          <option value="58">58 mm receipt printer</option>
          <option value="80">80 mm receipt printer</option>
          <option value="a4">A4 / normal printer</option>
        </select>
      </label>
      <label className="switch-row">
        <div><strong>Print a slip when an order is accepted</strong><p className="muted small">Each slip has the bag code and a barcode the rider checks at pickup.</p></div>
        <span className="switch"><input type="checkbox" checked={p.autoPrint} aria-label="Print automatically" onChange={(e) => update({ ...p, autoPrint: e.target.checked })} /><span /></span>
      </label>
      <p className="muted small">If a store doesn't accept within 3 minutes we send a reminder{store.phone ? ` (and an SMS to ${store.phone} once SMS is switched on)` : ''}; after 10 minutes the order is declined and the customer refunded.</p>
    </div>
  );
}

function StoreSettings({ store, onSaved }) {
  const notify = useToast();
  const [f, setF] = useState({ description: store.description, prepMinutes: store.prepMinutes - (store.busyExtraMinutes || 0), deliveryRadiusKm: store.deliveryRadiusKm, licenceNumber: store.licenceNumber || '', licenceExpiresOn: store.licenceExpiresOn || '', phone: store.phone || '' });
  const [hoursOn, setHoursOn] = useState(!!store.hours);
  const [hours, setHours] = useState(() => Object.fromEntries(DAYS.map(([k]) => [k, store.hours?.[k] || (store.hours ? null : ['09:00', '21:00'])])));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async (body, msg = 'Saved') => {
    try { const d = await api('/merchant/store', { method: 'PATCH', body }); onSaved(d.store); notify(msg, 'ok'); } catch (err) { notify(err.message, 'bad'); }
  };
  return (
    <div className="adm-two">
      <form className="adm-card" onSubmit={(e) => { e.preventDefault(); save(f); }}>
        <h3>Store details</h3>
        <label className="field"><span>Description customers see</span><textarea value={f.description} onChange={set('description')} maxLength={400} /></label>
        <div className="grid-2">
          <label className="field"><span>Usual packing time (min)</span><input type="number" min="3" max="60" value={f.prepMinutes} onChange={set('prepMinutes')} /></label>
          <label className="field"><span>Delivery radius (km)</span><input type="number" min="1" max="25" value={f.deliveryRadiusKm} onChange={set('deliveryRadiusKm')} /></label>
        </div>
        <label className="field"><span>Store phone</span><input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
        <div className="grid-2">
          <label className="field"><span>Licence number</span><input value={f.licenceNumber} onChange={set('licenceNumber')} /></label>
          <label className="field"><span>Licence expiry date</span><input type="date" value={f.licenceExpiresOn} onChange={set('licenceExpiresOn')} /></label>
        </div>
        <p className="small muted">Licence: {store.licence?.expired ? '⚠️ expired — regulated products are hidden' : store.licenceVerified ? `✅ verified for ${store.licenceCategories.join(', ') || 'no categories yet'}` : store.licenceNumber ? '⏳ awaiting verification' : 'none on file'}. Changing the number or expiry date sends it back for review. We remind you 60, 30 and 7 days before it expires.</p>
        <button className="btn">Save details</button>
      </form>
      <div className="adm-card">
        <div className="row-between">
          <h3>Opening hours</h3>
          <label className="switch" title="Use opening hours"><input type="checkbox" checked={hoursOn} onChange={(e) => setHoursOn(e.target.checked)} aria-label="Use opening hours" /><span /></label>
        </div>
        <p className="muted small">{hoursOn ? 'Outside these hours you close automatically and customers see when you open next.' : `No hours set — you're open whenever your switch is on (within ${BRAND.name}'s delivery hours).`}</p>
        {hoursOn && DAYS.map(([k, label]) => (
          <div key={k} className="m-hours-row">
            <label className="m-day"><input type="checkbox" checked={!!hours[k]} onChange={(e) => setHours({ ...hours, [k]: e.target.checked ? ['09:00', '21:00'] : null })} /> {label}</label>
            {hours[k] ? <>
              <input type="time" value={hours[k][0]} onChange={(e) => setHours({ ...hours, [k]: [e.target.value, hours[k][1]] })} aria-label={`${label} opens`} />
              <span className="muted">to</span>
              <input type="time" value={hours[k][1]} onChange={(e) => setHours({ ...hours, [k]: [hours[k][0], e.target.value] })} aria-label={`${label} closes`} />
            </> : <span className="muted small">Closed</span>}
          </div>
        ))}
        <button className="btn adm-gap" onClick={() => save({ hours: hoursOn ? hours : null }, 'Opening hours saved')}>Save hours</button>
      </div>
    </div>
  );
}

// ---- Shell -------------------------------------------------------------------

function StatusBar({ store, setStore, stats }) {
  const notify = useToast();
  const [menu, setMenu] = useState(false);
  const patch = async (body, msg) => {
    try { const d = await api('/merchant/store', { method: 'PATCH', body }); setStore(d.store); if (msg) notify(msg, 'ok'); } catch (e) { notify(e.message, 'bad'); }
  };
  const a = store.availability;
  return (
    <div className="m-bar">
      <div className="m-bar-id">
        <h1>{store.name}</h1>
        <span className={`m-pill ${a.open ? 'open' : a.reason}`}>{a.open ? '●' : a.reason === 'paused' ? '⏸' : '○'} {a.label}</span>
        {store.status !== 'approved' && <span className="status s-placed">{store.status === 'pending' ? 'Awaiting approval' : 'Suspended'}</span>}
      </div>
      <div className="m-bar-stats">
        <span><b>{stats?.todayOrders ?? 0}</b> delivered today</span>
        <span><b>{rand(stats?.todaySalesCents ?? 0)}</b> sales</span>
        {stats?.avgPrepMinutes != null && <span><b>{stats.avgPrepMinutes} min</b> avg prep</span>}
      </div>
      <div className="m-bar-actions">
        <div className="m-busy">
          <span className="muted small">Busy time</span>
          <div className="adm-seg">{[0, 10, 20, 30].map((m) => <button key={m} className={store.busyExtraMinutes === m ? 'on' : ''} onClick={() => patch({ busyExtraMinutes: m }, m ? `Adding ${m} min to prep times` : 'Back to normal prep times')}>{m ? `+${m}` : 'Off'}</button>)}</div>
        </div>
        {a.reason === 'paused'
          ? <button className="btn" onClick={() => patch({ pauseMinutes: 0 }, 'Taking orders again')}>Resume orders</button>
          : (
            <div className="m-pause">
              <button className="btn btn-ghost" onClick={() => setMenu((x) => !x)} disabled={!store.switchedOn}>⏸ Pause</button>
              {menu && <div className="m-pause-menu">{[15, 30, 60, 120].map((m) => <button key={m} onClick={() => { setMenu(false); patch({ pauseMinutes: m }, `Paused for ${m} min`); }}>{m < 60 ? `${m} min` : `${m / 60} h`}</button>)}</div>}
            </div>
          )}
        <label className="m-switch">
          <span>{store.switchedOn ? 'Open' : 'Closed'}</span>
          <span className="switch"><input type="checkbox" checked={store.switchedOn} onChange={(e) => patch({ isOpen: e.target.checked }, e.target.checked ? 'Store open' : 'Store closed')} aria-label="Store open" /><span /></span>
        </label>
      </div>
    </div>
  );
}

export default function Merchant() {
  const [store, setStore] = useState(undefined);
  const [me, setMe] = useState({ role: null, stores: [] });
  const [alerts, setAlerts] = useState(null);
  const [addingBranch, setAddingBranch] = useState(false);
  const [section, setSection] = useState(() => new URLSearchParams(window.location.search).get('section') || 'orders');
  const [board, setBoard] = useState(null);
  const [sound, setSound] = useState(false);
  const notify = useToast();
  const seen = useRef(null);

  useEffect(() => {
    api('/merchant/store').then((d) => {
      setStore(d.store);
      setMe({ role: d.role, stores: d.stores || [] });
      // Remember the branch actually in use (the saved one may be gone).
      if (d.store) setStoreId(d.store.id);
    });
  }, []);
  const loadAlerts = useCallback(() => api('/merchant/alerts').then((d) => setAlerts(d.alerts)).catch(() => {}), []);
  useEffect(() => {
    if (!store?.id) return undefined;
    loadAlerts();
    const t = setInterval(loadAlerts, 60000);
    return () => clearInterval(t);
  }, [store?.id, loadAlerts]);
  useEffect(() => { if (section === 'reviews') loadAlerts(); }, [section, loadAlerts]);

  const loadBoard = useCallback(() => api('/merchant/orders').then((d) => {
    const fresh = d.live.filter((o) => o.lane === 'new' && seen.current && !seen.current.has(o.id));
    if (fresh.length) notify(`New order #${fresh[0].code}`, 'ok');
    seen.current = new Set(d.live.map((o) => o.id));
    setBoard(d);
    if (d.store) setStore(d.store);
  }).catch(() => {}), [notify]);

  useEffect(() => {
    if (!store) return undefined;
    loadBoard();
    const t = setInterval(loadBoard, 4000);
    return () => clearInterval(t);
  }, [store?.id, loadBoard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep chiming while anything sits in New.
  const waiting = board?.live.filter((o) => o.lane === 'new').length || 0;
  useEffect(() => {
    if (!sound || !waiting) return undefined;
    ding();
    const t = setInterval(ding, 4000);
    return () => clearInterval(t);
  }, [sound, waiting]);

  if (store === undefined) return <div className="page center pad"><Spinner /></div>;
  if (!store) return <Setup onCreated={(s) => { setStoreId(s.id); window.location.reload(); }} />;
  if (addingBranch) return <Setup branch onCancel={() => setAddingBranch(false)} onCreated={(s) => { setStoreId(s.id); window.location.reload(); }} />;

  const role = me.role || 'owner';
  const visible = SECTIONS.filter(([, , , need]) => RANK[role] >= RANK[need]);
  const current = visible.some(([k]) => k === section) ? section : 'orders';
  const badge = (k) => {
    if (k === 'orders' && waiting) return <b className="adm-badge hot">{waiting}</b>;
    if (k === 'reviews' && alerts?.reviewsToReply) return <b className="adm-badge">{alerts.reviewsToReply}</b>;
    return null;
  };

  return (
    <div className="m-app">
      <StoreSwitcher stores={me.stores} current={store.id} role={role} onAdd={() => setAddingBranch(true)} />
      <ChooseOwnPassword />
      <StatusBar store={store} setStore={setStore} stats={board?.stats} />
      {RANK[role] >= RANK.manager && <LicenceBanner store={store} go={setSection} />}
      <nav className="m-nav">
        {visible.map(([k, icon, label]) => (
          <button key={k} className={current === k ? 'on' : ''} onClick={() => setSection(k)}>
            {icon} {k === 'team' && role !== 'owner' ? 'Activity' : label}{badge(k)}
          </button>
        ))}
        <PushButton compact className="m-push" />
        <button className={`m-sound ${sound ? 'on' : ''}`} onClick={() => { unlockAudio(); setSound((x) => !x); }} title="Order alerts">
          {sound ? '🔔 Alerts on' : '🔕 Turn on alerts'}
        </button>
      </nav>
      <div className="m-main">
        {current === 'orders' && (board ? <Board data={board} reload={loadBoard} setStore={setStore} /> : <Spinner />)}
        {current === 'menu' && <Menu role={role} />}
        {current === 'insights' && <Insights />}
        {current === 'payouts' && <Money />}
        {current === 'promos' && <Promotions />}
        {current === 'reviews' && <Reviews onReplied={loadAlerts} />}
        {current === 'team' && <TeamAndActivity role={role} />}
        {current === 'store' && <><CounterSettings store={store} onSaved={setStore} /><StoreSettings store={store} onSaved={setStore} /></>}
      </div>
    </div>
  );
}

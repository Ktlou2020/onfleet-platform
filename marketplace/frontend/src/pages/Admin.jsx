import { useCallback, useEffect, useState } from 'react';
import { STATUS, Spinner, api, rand, useToast } from '../lib.jsx';

const REGULATED = ['flower', 'pre-rolls', 'edibles', 'extracts'];

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
          <strong>{s.name}</strong> <span className={`status s-${s.status}`}>{s.status}</span>
          <p className="muted small">{s.city} · {s.address} · {s.owner.name} ({s.owner.email})</p>
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
                <button key={c} className={`chip ${cats.includes(c) ? 'on' : ''}`} onClick={() => setCats((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))}>{c}</button>
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

export default function Admin() {
  const [tab, setTab] = useState('overview');
  const [ov, setOv] = useState(null);
  const [stores, setStores] = useState(null);
  const [orders, setOrders] = useState(null);
  const notify = useToast();

  const load = useCallback(() => {
    api('/admin/overview').then(setOv);
    api('/admin/stores').then((d) => setStores(d.stores));
    api('/admin/orders').then((d) => setOrders(d.orders));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const setSetting = async (body) => {
    try { await api('/admin/settings', { method: 'PUT', body }); load(); } catch (e) { notify(e.message, 'bad'); }
  };

  const cancel = async (o) => {
    const reason = window.prompt('Reason for cancelling (the customer sees this):');
    if (!reason) return;
    try { await api(`/orders/${o.id}/cancel`, { method: 'POST', body: { reason } }); load(); } catch (e) { notify(e.message, 'bad'); }
  };

  if (!ov) return <div className="page center pad"><Spinner /></div>;
  return (
    <div className="page">
      <p className="eyebrow">Operations</p>
      <h1>Control room</h1>
      <div className="stats">
        <div><span>Delivered today</span><strong>{ov.today.orders}</strong></div>
        <div><span>GMV today</span><strong>{rand(ov.today.gmv_cents)}</strong></div>
        <div><span>Service fees today</span><strong>{rand(ov.today.service_fees_cents)}</strong></div>
        <div><span>Avg order→door</span><strong>{ov.today.avg_minutes ? `${Math.round(ov.today.avg_minutes)} min` : '–'}</strong></div>
        <div><span>Live orders</span><strong>{ov.activeOrders}</strong></div>
        <div className={ov.unassigned ? 'alert' : ''}><span>Need a rider</span><strong>{ov.unassigned}</strong></div>
        <div><span>Riders online</span><strong>{ov.ridersOnline}</strong></div>
        <div className={ov.pendingStores ? 'alert' : ''}><span>Stores to review</span><strong>{ov.pendingStores}</strong></div>
      </div>

      <div className="tabs">
        {['overview', 'stores', 'orders'].map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>

      {tab === 'overview' && (
        <div className="card narrow-card">
          <h3>Compliance switches</h3>
          <label className="switch-row">
            <div>
              <strong>Regulated categories</strong>
              <p className="muted small">Flower, pre-rolls, edibles and extracts. Keep this OFF unless commercial sale is lawful and your legal counsel has signed off. Even when ON, each store also needs a verified licence covering the category.</p>
            </div>
            <span className="switch"><input type="checkbox" checked={ov.settings.regulatedSalesEnabled} onChange={(e) => setSetting({ regulatedSalesEnabled: e.target.checked })} /><span /></span>
          </label>
          <div className="grid-2">
            <label className="field"><span>Deliveries open (hour, SAST)</span><input type="number" min="0" max="23" defaultValue={ov.settings.deliveryOpenHour} onBlur={(e) => setSetting({ deliveryOpenHour: Number(e.target.value) })} /></label>
            <label className="field"><span>Deliveries close (hour, SAST)</span><input type="number" min="1" max="24" defaultValue={ov.settings.deliveryCloseHour} onBlur={(e) => setSetting({ deliveryCloseHour: Number(e.target.value) })} /></label>
          </div>
          <p className="muted small">{ov.customers} customers · {ov.unverifiedLicences} licences awaiting verification</p>
        </div>
      )}

      {tab === 'stores' && (!stores ? <Spinner /> : stores.map((s) => <StoreRow key={s.id} s={s} onChange={load} />))}

      {tab === 'orders' && (!orders ? <Spinner /> : (
        <div className="table">
          {orders.map((o) => (
            <div key={o.id} className="trow">
              <strong>#{o.code}</strong>
              <span className="grow small">{o.store.name} → {o.customer.name}<br /><span className="muted">{new Date(o.createdAt + 'Z').toLocaleString('en-ZA')} · {o.rider ? `🛵 ${o.rider.name}` : 'no rider'}</span></span>
              <span className={`status s-${o.status}`}>{STATUS[o.status]?.label}</span>
              <strong>{rand(o.totals.totalCents)}</strong>
              {!['delivered', 'cancelled', 'rejected'].includes(o.status) && <button className="link" onClick={() => cancel(o)}>Cancel</button>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

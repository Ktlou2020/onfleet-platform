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
  const [riders, setRiders] = useState(null);
  const [incidents, setIncidents] = useState(null);
  const notify = useToast();

  const load = useCallback(() => {
    api('/admin/overview').then(setOv);
    api('/admin/stores').then((d) => setStores(d.stores));
    api('/admin/orders').then((d) => setOrders(d.orders));
    api('/admin/riders').then((d) => setRiders(d.riders));
    api('/admin/incidents').then((d) => setIncidents(d.incidents));
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
        <div className={ov.openIncidents ? 'alert' : ''}><span>Open incidents</span><strong>{ov.openIncidents}</strong></div>
      </div>

      <div className="tabs">
        {['overview', 'stores', 'orders', 'riders', 'incidents'].map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
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

      {tab === 'riders' && (!riders ? <Spinner /> : (
        <div className="table">
          {riders.map((r) => (
            <div key={r.id} className="trow">
              <span className={`status ${r.online ? (r.paused ? 's-placed' : 's-approved') : 's-pending_payment'}`}>{r.online ? (r.paused ? 'Paused' : 'Online') : 'Offline'}</span>
              <span className="grow small"><strong>{r.name}</strong> · {r.vehicle}{r.plate ? ` ${r.plate}` : ''}<br /><span className="muted">{r.phone || 'no phone'}{r.location ? ` · last seen ${new Date(r.location.at + 'Z').toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}` : ''}</span></span>
              <span className="small">{r.currentOrder ? `🛵 #${r.currentOrder}` : '—'}</span>
              <span className="small">{r.tripsToday} today</span>
              <span className="small">{r.rating ? `★ ${r.rating}` : 'new'}</span>
              <span className="small">{r.acceptanceRate != null ? `${r.acceptanceRate}% accept` : ''}</span>
            </div>
          ))}
        </div>
      ))}

      {tab === 'incidents' && (!incidents ? <Spinner /> : incidents.length === 0 ? <p className="muted">No incidents reported.</p> : (
        <div className="table">
          {incidents.map((i) => (
            <div key={i.id} className={`trow ${i.resolved ? 'dim' : ''}`}>
              <span className={`status ${i.type === 'sos' ? 's-cancelled' : 's-placed'}`}>{i.type === 'sos' ? '🚨 SOS' : i.type.replace('_', ' ')}</span>
              <span className="grow small"><strong>{i.rider.name}</strong>{i.orderCode ? ` · #${i.orderCode}` : ''} · {new Date(i.at + 'Z').toLocaleString('en-ZA')}<br /><span className="muted">{i.note}</span></span>
              {i.rider.phone && <a className="link" href={`tel:${i.rider.phone}`}>Call</a>}
              {i.location && <a className="link" href={`https://www.google.com/maps?q=${i.location.lat},${i.location.lng}`} target="_blank" rel="noreferrer">Map</a>}
              {!i.resolved && <button className="link" onClick={() => api(`/admin/incidents/${i.id}/resolve`, { method: 'POST' }).then(load)}>Resolve</button>}
            </div>
          ))}
        </div>
      ))}

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

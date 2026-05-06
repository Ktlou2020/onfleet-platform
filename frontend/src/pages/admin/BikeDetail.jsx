import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, fmt, fmtDate } from '../../components/ui';

const bikeIcon = new L.DivIcon({
  html: `<div style="background:var(--primary);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white">🏍️</div>`,
  className:'', iconSize:[30,30], iconAnchor:[15,15]
});

export default function AdminBikeDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({});
  const [showService, setShowService] = useState(false);
  const [service, setService] = useState({ service_date: new Date().toISOString().slice(0,10), service_type: 'monthly',
    description:'', odometer_km:'', cost:0, next_service_date:'', next_service_km:'', performed_by:'OnFleet Workshop' });

  const load = () => api.get(`/bikes/${id}`).then(r => { setData(r.data); setForm(r.data.bike); });
  useEffect(() => { load(); }, [id]);
  if (!data) return <Loading />;
  const b = data.bike;
  const pos = b.last_known_lat ? [b.last_known_lat, b.last_known_lng] : null;

  const save = async () => {
    try { await api.put(`/bikes/${id}`, form); toast.success('Saved'); setEdit(false); load(); }
    catch { toast.error('Failed'); }
  };
  const addService = async () => {
    try { await api.post(`/bikes/${id}/service`, service); toast.success('Service logged'); setShowService(false); load(); }
    catch { toast.error('Failed'); }
  };

  return (
    <>
      <Link to="/admin/bikes" className="muted text-sm">← Back to fleet</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">{b.make} {b.model}</h1>
          <div className="muted">VIN {b.vin} · {b.registration || 'no rego'}</div>
        </div>
        <div className="row"><Badge status={b.status} />
          <button className="btn btn-sm btn-secondary" onClick={() => setEdit(!edit)}>{edit ? 'Cancel' : 'Edit'}</button>
          <button className="btn btn-sm" onClick={() => setShowService(true)}>+ Log service</button></div>
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Details</h3>
          {edit ? (
            <>
              <div className="grid grid-2">
                <div className="field"><label className="label">Status</label>
                  <select value={form.status} onChange={e=>setForm({...form, status: e.target.value})}>
                    {['available','allocated','maintenance','sold','retired'].map(s => <option key={s}>{s}</option>)}
                  </select></div>
                <div className="field"><label className="label">Registration</label>
                  <input value={form.registration||''} onChange={e=>setForm({...form, registration: e.target.value})}/></div>
                <div className="field"><label className="label">Odometer (km)</label>
                  <input type="number" value={form.odometer_km||0} onChange={e=>setForm({...form, odometer_km: +e.target.value})}/></div>
                <div className="field"><label className="label">Weekly rental</label>
                  <input type="number" value={form.rental_weekly} onChange={e=>setForm({...form, rental_weekly: +e.target.value})}/></div>
                <div className="field"><label className="label">Insurance provider</label>
                  <input value={form.insurance_provider||''} onChange={e=>setForm({...form, insurance_provider: e.target.value})}/></div>
                <div className="field"><label className="label">Insurance expiry</label>
                  <input type="date" value={form.insurance_expiry||''} onChange={e=>setForm({...form, insurance_expiry: e.target.value})}/></div>
                <div className="field"><label className="label">Next service date</label>
                  <input type="date" value={form.next_service_date||''} onChange={e=>setForm({...form, next_service_date: e.target.value})}/></div>
                <div className="field"><label className="label">Next service km</label>
                  <input type="number" value={form.next_service_km||0} onChange={e=>setForm({...form, next_service_km: +e.target.value})}/></div>
              </div>
              <button className="btn" onClick={save}>Save changes</button>
            </>
          ) : (
            <>
              <Row k="VIN" v={b.vin} />
              <Row k="Year" v={b.year} />
              <Row k="Engine" v={`${b.engine_cc}cc`} />
              <Row k="Color" v={b.color} />
              <Row k="Condition" v={b.condition} />
              <Row k="Purchase price" v={fmt(b.purchase_price)} />
              <Row k="Weekly rental" v={fmt(b.rental_weekly)} />
              <Row k="Odometer" v={`${b.odometer_km || 0} km`} />
              <Row k="GPS device" v={b.gps_device_id} />
              <Row k="Insurance" v={`${b.insurance_provider || '—'} · expires ${fmtDate(b.insurance_expiry)}`} />
              <Row k="Next service" v={`${fmtDate(b.next_service_date)} or ${b.next_service_km || '—'} km`} />
            </>
          )}
        </div>
        <div className="card">
          <h3 className="mb-3">🛰️ Live location</h3>
          {pos ? <div style={{ height: 320, borderRadius: 8, overflow:'hidden' }}>
            <MapContainer center={pos} zoom={13} style={{ height: '100%' }}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Marker position={pos} icon={bikeIcon}><Popup>{b.make} {b.model}</Popup></Marker>
            </MapContainer>
          </div> : <div className="muted">No GPS data yet.</div>}
        </div>
      </div>

      <div className="card">
        <h3 className="mb-3">Service history</h3>
        <table className="table">
          <thead><tr><th>Date</th><th>Type</th><th>Odometer</th><th>Description</th><th>Cost</th><th>By</th></tr></thead>
          <tbody>
            {data.services.map(s => (
              <tr key={s.id}><td>{fmtDate(s.service_date)}</td><td>{s.service_type}</td>
                <td>{s.odometer_km} km</td><td className="text-sm muted">{s.description}</td>
                <td>{fmt(s.cost)}</td><td>{s.performed_by}</td></tr>
            ))}
          </tbody>
        </table>
        {!data.services.length && <div className="muted text-sm">No service records yet.</div>}
      </div>

      {showService && <Modal title="Log service" onClose={() => setShowService(false)}>
        <div className="grid grid-2">
          <div className="field"><label className="label">Date</label>
            <input type="date" value={service.service_date} onChange={e=>setService({...service, service_date: e.target.value})}/></div>
          <div className="field"><label className="label">Type</label>
            <select value={service.service_type} onChange={e=>setService({...service, service_type: e.target.value})}>
              <option value="monthly">Monthly (free)</option><option value="major">Major</option>
              <option value="repair">Repair</option><option value="tyres">Tyres</option>
            </select></div>
          <div className="field"><label className="label">Odometer (km)</label>
            <input type="number" value={service.odometer_km} onChange={e=>setService({...service, odometer_km: +e.target.value})}/></div>
          <div className="field"><label className="label">Cost (R)</label>
            <input type="number" value={service.cost} onChange={e=>setService({...service, cost: +e.target.value})}/></div>
          <div className="field"><label className="label">Next service date</label>
            <input type="date" value={service.next_service_date} onChange={e=>setService({...service, next_service_date: e.target.value})}/></div>
          <div className="field"><label className="label">Next service km</label>
            <input type="number" value={service.next_service_km} onChange={e=>setService({...service, next_service_km: +e.target.value})}/></div>
        </div>
        <div className="field"><label className="label">Description</label>
          <textarea rows={3} value={service.description} onChange={e=>setService({...service, description: e.target.value})}/></div>
        <button className="btn" onClick={addService}>Log service</button>
      </Modal>}
    </>
  );
}
function Row({k, v}) {
  return <div className="flex-between" style={{ padding:'8px 0', borderBottom:'1px solid var(--border)' }}>
    <span className="muted text-sm">{k}</span><span>{v || '—'}</span></div>;
}

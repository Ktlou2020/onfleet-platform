import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, fmt, fmtDate } from '../../components/ui';
import { Plus } from 'lucide-react';

export default function AdminBikes() {
  const [bikes, setBikes] = useState(null);
  const [filter, setFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ vin: '', make: '', model: '', year: 2024, engine_cc: 125, color: '', condition: 'new', purchase_price: '', rental_weekly: '850', total_weeks: 78, registration: '', image_url: '' });

  const load = () => api.get('/bikes', { params: filter ? { status: filter } : {} }).then((response) => setBikes(response.data.bikes));
  useEffect(() => { load(); }, [filter]);

  const create = async () => {
    try {
      await api.post('/bikes', { ...form, year: Number(form.year), engine_cc: Number(form.engine_cc), purchase_price: Number(form.purchase_price || 0), rental_weekly: Number(form.rental_weekly), total_weeks: Number(form.total_weeks) });
      toast.success('Bike added');
      setShowAdd(false);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed');
    }
  };

  if (!bikes) return <Loading />;
  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Bike Fleet</h1>
          <p className="page-sub">Manage inventory, upload bike images, log repairs, and track ROI in each bike detail page.</p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}><Plus size={16} /> Add bike</button>
      </div>
      <div className="row mb-4">
        {['', 'available', 'allocated', 'maintenance', 'sold', 'retired'].map((value) => (
          <button key={value} onClick={() => setFilter(value)} className={`btn btn-sm ${filter === value ? '' : 'btn-secondary'}`}>{value || 'All'}</button>
        ))}
      </div>

      <div className="grid grid-3">
        {bikes.map((bike) => (
          <Link key={bike.id} to={`/admin/bikes/${bike.id}`} className="bike-card" style={{ color: 'var(--text)', display: 'block' }}>
            <div className="img" style={{ height: 160, backgroundImage: bike.image_url ? `url("${bike.image_url}")` : 'none', backgroundSize: 'cover', backgroundPosition: 'center', backgroundColor: '#0a1219' }} />
            <div className="body" style={{ padding: 16 }}>
              <div className="flex-between mb-2">
                <h3>{bike.make} {bike.model}</h3>
                <Badge status={bike.status} />
              </div>
              <div className="text-sm muted mb-3">{bike.year} · {bike.engine_cc}cc · {bike.color}</div>
              <div className="text-xs muted">VIN: {bike.vin}</div>
              <div className="text-xs muted">REG: {bike.registration || '—'}</div>
              <div className="flex-between mt-3 mb-1"><span className="muted text-sm">Weekly</span><strong style={{ color: 'var(--primary-light)' }}>{fmt(bike.rental_weekly)}</strong></div>
              <div className="flex-between"><span className="muted text-sm">Odometer</span><span>{bike.odometer_km || 0} km</span></div>
              {bike.next_service_date && <div className="flex-between"><span className="muted text-sm">Next service</span><span className="text-xs">{fmtDate(bike.next_service_date)}</span></div>}
            </div>
          </Link>
        ))}
      </div>

      {showAdd && (
        <Modal title="Add new bike" onClose={() => setShowAdd(false)}>
          <div className="grid grid-2">
            <div className="field"><label className="label">VIN *</label><input value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} /></div>
            <div className="field"><label className="label">Registration</label><input value={form.registration} onChange={(e) => setForm({ ...form, registration: e.target.value })} /></div>
            <div className="field"><label className="label">Make *</label><input value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} /></div>
            <div className="field"><label className="label">Model *</label><input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></div>
            <div className="field"><label className="label">Year</label><input type="number" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} /></div>
            <div className="field"><label className="label">Engine cc</label><input type="number" value={form.engine_cc} onChange={(e) => setForm({ ...form, engine_cc: e.target.value })} /></div>
            <div className="field"><label className="label">Condition</label><select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}><option value="new">New</option><option value="used">Used</option></select></div>
            <div className="field"><label className="label">Color</label><input value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} /></div>
            <div className="field"><label className="label">Purchase price</label><input type="number" value={form.purchase_price} onChange={(e) => setForm({ ...form, purchase_price: e.target.value })} /></div>
            <div className="field"><label className="label">Weekly rental</label><input type="number" value={form.rental_weekly} onChange={(e) => setForm({ ...form, rental_weekly: e.target.value })} /></div>
            <div className="field"><label className="label">Total weeks</label><input type="number" value={form.total_weeks} onChange={(e) => setForm({ ...form, total_weeks: e.target.value })} /></div>
            <div className="field"><label className="label">Image URL</label><input value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="Optional remote image URL" /></div>
          </div>
          <div className="row"><button className="btn" onClick={create}>Add bike</button><button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

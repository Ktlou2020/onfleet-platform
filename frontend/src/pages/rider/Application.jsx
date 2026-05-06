import { useEffect, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, fmt, fmtDate } from '../../components/ui';

export default function RiderApplication() {
  const [apps, setApps] = useState(null);
  const [bikes, setBikes] = useState([]);
  const [form, setForm] = useState({
    preferred_bike_id: '', employment_status: 'self_employed', monthly_income: '',
    delivery_platforms: [], has_riding_experience: true, years_riding: '',
    has_drivers_license: true
  });

  const load = () => Promise.all([api.get('/applications/mine'), api.get('/bikes/catalog')])
    .then(([a, b]) => { setApps(a.data.applications); setBikes(b.data.bikes); });
  useEffect(() => { load(); }, []);

  const togglePlatform = (p) => setForm(f => ({
    ...f,
    delivery_platforms: f.delivery_platforms.includes(p)
      ? f.delivery_platforms.filter(x => x !== p) : [...f.delivery_platforms, p]
  }));

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/applications', { ...form, monthly_income: +form.monthly_income, years_riding: +form.years_riding });
      toast.success('Application submitted! We\'ll review within 48 hours.');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Submission failed'); }
  };

  if (!apps) return <Loading />;
  const active = apps.find(a => ['submitted','under_review','approved'].includes(a.status));

  return (
    <>
      <h1 className="page-title">Application</h1>
      <p className="page-sub">Apply for a rent-to-own bike</p>

      {apps.length > 0 && (
        <div className="card mb-4">
          <h3 className="mb-3">Your applications</h3>
          <table className="table">
            <thead><tr><th>Submitted</th><th>Bike</th><th>Status</th></tr></thead>
            <tbody>
              {apps.map(a => (
                <tr key={a.id}>
                  <td>{fmtDate(a.submitted_at)}</td>
                  <td>{a.make ? `${a.make} ${a.model}` : '—'}</td>
                  <td><Badge status={a.status}/></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!active && (
        <form className="card" onSubmit={submit}>
          <h3 className="mb-3">New application</h3>

          <div className="field">
            <label className="label">Preferred bike</label>
            <select value={form.preferred_bike_id} onChange={e => setForm({ ...form, preferred_bike_id: e.target.value })} required>
              <option value="">— Select a bike —</option>
              {bikes.map(b => <option key={b.id} value={b.id}>{b.make} {b.model} ({b.engine_cc}cc) — {fmt(b.rental_weekly)}/week</option>)}
            </select>
          </div>

          <div className="grid grid-2">
            <div className="field"><label className="label">Employment status</label>
              <select value={form.employment_status} onChange={e => setForm({ ...form, employment_status: e.target.value })}>
                <option value="self_employed">Self-employed</option>
                <option value="employed">Employed</option>
                <option value="unemployed">Unemployed</option>
              </select></div>
            <div className="field"><label className="label">Monthly income (R)</label>
              <input type="number" required value={form.monthly_income} onChange={e => setForm({ ...form, monthly_income: e.target.value })} /></div>
          </div>

          <div className="field">
            <label className="label">Delivery platforms you'll use</label>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {['UberEats','MrD','Bolt Food','Takealot','Other'].map(p => (
                <label key={p} className="row" style={{ background: form.delivery_platforms.includes(p) ? 'var(--primary)' : 'var(--surface-2)',
                  padding: '8px 14px', borderRadius: 100, cursor: 'pointer', userSelect: 'none', color: form.delivery_platforms.includes(p) ? 'white' : 'var(--text)' }}>
                  <input type="checkbox" checked={form.delivery_platforms.includes(p)} onChange={() => togglePlatform(p)} style={{ display: 'none' }} />
                  {p}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-2">
            <div className="field"><label className="label">Years of riding experience</label>
              <input type="number" value={form.years_riding} onChange={e => setForm({ ...form, years_riding: e.target.value })} /></div>
            <div className="field"><label className="label">Do you have a license?</label>
              <select value={form.has_drivers_license ? '1' : '0'} onChange={e => setForm({ ...form, has_drivers_license: e.target.value === '1' })}>
                <option value="1">Yes</option><option value="0">No</option>
              </select></div>
          </div>

          <button className="btn">Submit application</button>
          <div className="muted text-sm mt-3">After submitting, please upload your KYC documents (ID, proof of address, license). Approval within 48 hours.</div>
        </form>
      )}
    </>
  );
}

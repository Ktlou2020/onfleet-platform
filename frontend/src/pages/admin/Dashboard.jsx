import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, CartesianGrid, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import api from '../../api';
import toast from 'react-hot-toast';
import { Stat, Loading, SearchInput } from '../../components/ui';
import { fmt, matchesSearch } from '../../components/ui';
import { useAuth } from '../../auth';
import { Users, Bike, AlertCircle, TrendingUp, FileCheck, ShieldCheck, Wrench, ImagePlus } from 'lucide-react';

export default function AdminDashboard() {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [search, setSearch] = useState('');
  const [branding, setBranding] = useState(null);
  const [heroImageFile, setHeroImageFile] = useState(null);
  const [uploadingHero, setUploadingHero] = useState(false);

  const loadDashboard = () => api.get('/admin/dashboard').then((r) => setD(r.data));
  const loadBranding = () => {
    if (user?.role !== 'superadmin') return Promise.resolve();
    return api.get('/admin/branding').then((r) => setBranding(r.data)).catch(() => setBranding(null));
  };

  useEffect(() => {
    loadDashboard();
    loadBranding();
  }, [user?.role]);

  const s = d?.stats || {};
  const {
    pending_applications = 0,
    pending_kyc = 0,
    overdue_count = 0,
    upcoming_services = 0,
    expiring_license_disc = 0,
    expiring_insurance = 0
  } = s;

  const actions = useMemo(() => ([
    { icon: '📋', count: pending_applications, label: 'Pending applications', link: '/admin/applications?status=submitted' },
    { icon: '🆔', count: pending_kyc, label: 'Application documents to review', link: '/admin/applications' },
    { icon: '⚠️', count: overdue_count, label: 'Overdue agreements', link: '/admin/agreements?status=active', danger: true },
    { icon: '🔧', count: upcoming_services, label: 'Bikes due for service (14d)', link: '/admin/bikes?status=active' },
    { icon: '🪪', count: expiring_license_disc, label: 'License discs expiring (30d)', link: '/admin/bikes', danger: true },
    { icon: '🛡️', count: expiring_insurance, label: 'Insurance expiring (30d)', link: '/admin/bikes' }
  ].filter((item) => matchesSearch(search, item.label, item.count))), [pending_applications, pending_kyc, overdue_count, upcoming_services, expiring_license_disc, expiring_insurance, search]);

  const uploadHeroImage = async () => {
    if (!heroImageFile) return toast.error('Choose a hero image first');
    try {
      setUploadingHero(true);
      const fd = new FormData();
      fd.append('image', heroImageFile);
      const { data } = await api.post('/admin/branding/hero-image', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setBranding(data);
      setHeroImageFile(null);
      toast.success('Homepage hero image updated');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update hero image');
    } finally {
      setUploadingHero(false);
    }
  };

  if (!d) return <Loading />;

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">Real-time business overview with compliance and fleet alerts.</p>
        </div>
        <Link to="/admin/strategy" className="btn btn-secondary">AI strategy report</Link>
      </div>

      <div className="row mb-4" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search dashboard actions and queues" style={{ flex: '1 1 320px', maxWidth: 420 }} />
        <div className="muted text-sm">Showing {actions.length} action items</div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Total revenue" value={fmt(s.revenue_total)} delta={`${fmt(s.revenue_30d)} last 30 days`} icon={<TrendingUp size={16}/>} accent="var(--success)" />
        <Stat label="Active agreements" value={s.active_agreements} delta={`${s.completed_agreements} completed`} icon={<FileCheck size={16}/>} />
        <Stat label="Riders" value={s.riders} icon={<Users size={16}/>} accent="var(--accent)" />
        <Stat label="Overdue amount" value={fmt(s.overdue_amount)} delta={`${s.overdue_count} agreements`} icon={<AlertCircle size={16}/>} accent="var(--danger)" />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Ready to go bikes" value={s.bikes_available} icon={<Bike size={16}/>} />
        <Stat label="Active bikes" value={s.bikes_allocated} icon={<Bike size={16}/>} accent="var(--accent)" />
        <Stat label="Bikes in repairs" value={s.bikes_maintenance} icon={<Wrench size={16}/>} accent="var(--warn)" />
        <Stat label="Compliance alerts" value={s.expiring_license_disc} delta={`${s.pending_kyc} docs pending · ${s.expiring_insurance} insurance`} icon={<ShieldCheck size={16}/>} accent="var(--warn)" />
      </div>

      {user?.role === 'superadmin' && (
        <div className="card mb-4">
          <div className="flex-between" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ marginBottom: 8 }}>Homepage hero image</h3>
              <div className="muted text-sm">Super admins can replace the public homepage hero visual here.</div>
            </div>
            <div className="badge badge-info"><ImagePlus size={12} /> Branding</div>
          </div>
          <div className="grid grid-2 mt-3">
            <div className="branding-hero-preview" style={{ backgroundImage: branding?.hero_image_url ? `url(${branding.hero_image_url})` : 'none' }}>
              {!branding?.hero_image_url && <div className="muted">No custom hero image uploaded yet.</div>}
            </div>
            <div>
              <div className="field">
                <label className="label">Upload hero image</label>
                <input type="file" accept="image/jpeg,image/jpg,image/png,image/webp" onChange={(e) => setHeroImageFile(e.target.files?.[0] || null)} />
                <div className="muted text-sm mt-2">Recommended: wide landscape image in JPG, PNG, or WEBP format.</div>
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn" onClick={uploadHeroImage} disabled={uploadingHero}>{uploadingHero ? 'Uploading…' : 'Update hero image'}</button>
                {branding?.hero_image_url && <a className="btn btn-secondary" href={branding.hero_image_url} target="_blank" rel="noreferrer">Open current image</a>}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Weekly revenue (last 90 days)</h3>
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={d.weekly_revenue}>
                <CartesianGrid stroke="#252b38" vertical={false} />
                <XAxis dataKey="week" stroke="#8a95a8" fontSize={11} />
                <YAxis stroke="#8a95a8" fontSize={11} />
                <Tooltip contentStyle={{ background: '#12151c', border: '1px solid #252b38' }} formatter={(v) => fmt(v)} />
                <Bar dataKey="total" fill="#ff6b35" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h3 className="mb-3">Action queue</h3>
          {actions.map((item) => <ActionItem key={item.label} {...item} />)}
          {!actions.length && <div className="muted text-sm">No dashboard actions match your search.</div>}
        </div>
      </div>
    </>
  );
}

function ActionItem({ icon, count, label, link, danger }) {
  return (
    <Link to={link} style={{ display: 'flex', alignItems:'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>
      <div style={{ fontSize: 20 }}>{icon}</div>
      <div style={{ flex: 1 }}>{label}</div>
      <div className="badge" style={{ background: count > 0 ? (danger ? 'rgba(239,68,68,0.2)' : 'rgba(255,107,53,0.2)') : 'var(--surface-2)', color: count > 0 ? (danger ? 'var(--danger)' : 'var(--primary)') : 'var(--muted)' }}>{count}</div>
    </Link>
  );
}

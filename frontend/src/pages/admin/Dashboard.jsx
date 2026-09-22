import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, CartesianGrid, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import api from '../../api';
import toast from 'react-hot-toast';
import { Stat, Loading, SearchInput } from '../../components/ui';
import { fmt, matchesSearch } from '../../components/ui';
import { useAuth } from '../../auth';
import { Users, Bike, AlertCircle, TrendingUp, FileCheck, ShieldCheck, Wrench, ImagePlus, ClipboardList, BadgeCheck, Shield, CreditCard } from 'lucide-react';

// Rates below 75% read as a problem to act on this week rather than a blip.
const rateAccent = (rate) => (rate === null || rate === undefined
  ? undefined
  : rate >= 90 ? 'var(--success)' : rate >= 75 ? 'var(--warn)' : 'var(--danger)');

const monthLabel = (ym) => new Date(`${ym}-01T00:00:00Z`)
  .toLocaleString('en-ZA', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// Whether riders are paying, how old the unpaid money is, how many bikes are
// gone, and how many on the road could be found. None of these were anywhere
// on the dashboard, so none of them were being watched.
function KpiPanel({ kpis }) {
  if (!kpis) return null;
  const { collections, arrears, losses, trackers } = kpis;
  const over90 = arrears.buckets.find((b) => b.key === 'd90_plus') || { amount: 0, agreements: 0 };
  const three = collections.three_month;

  return (
    <div className="card mb-4">
      <div className="card-title"><h3>Business health</h3></div>

      <div className="grid grid-4 mb-4">
        <Stat
          label="Collection rate"
          value={three.rate === null ? '—' : `${three.rate}%`}
          delta={`${fmt(three.collected)} of ${fmt(three.billed)} billed · last 3 full months`}
          icon={<TrendingUp size={16} />}
          accent={rateAccent(three.rate)}
        />
        <Stat
          label="Over 90 days behind"
          value={fmt(over90.amount)}
          delta={`${over90.agreements} active agreement${over90.agreements === 1 ? '' : 's'}`}
          icon={<AlertCircle size={16} />}
          accent="var(--danger)"
        />
        <Stat
          label="Bikes lost"
          value={losses.lost}
          delta={`${losses.loss_rate ?? 0}% of ${losses.fleet} · ${losses.stolen} stolen, ${losses.written_off} written off`}
          icon={<Bike size={16} />}
          accent="var(--danger)"
        />
        <Stat
          label="Bikes on the road with a tracker"
          value={`${trackers.tracked} / ${trackers.on_road}`}
          delta={`${trackers.coverage ?? 0}% covered · ${trackers.reporting_24h} reported in 24h`}
          icon={<Shield size={16} />}
          accent={(trackers.coverage ?? 0) >= 80 ? 'var(--success)' : 'var(--danger)'}
        />
      </div>

      <div className="grid grid-2" style={{ gap: 24 }}>
        <div>
          <div className="text-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Billed and collected, by month</div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Month</th><th>Billed</th><th>Collected</th><th>Rate</th></tr></thead>
              <tbody>
                {collections.months.map((m, i) => (
                  <tr key={m.month}>
                    <td className="text-xs" style={{ whiteSpace: 'nowrap' }}>
                      {monthLabel(m.month)}{i === collections.months.length - 1 ? ' (so far)' : ''}
                    </td>
                    <td className="text-xs">{fmt(m.billed)}</td>
                    <td className="text-xs">{fmt(m.collected)}</td>
                    <td className="text-xs" style={{ color: rateAccent(m.rate), fontWeight: 600 }}>
                      {m.rate === null ? '—' : `${m.rate}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted text-xs" style={{ marginTop: 8, lineHeight: 1.5 }}>
            Billing only counts while an agreement was running, so ended agreements don't drag the rate down.
            A month can pass 100% when riders catch up on arrears.
            {collections.excluded_agreements > 0 && (
              <> {collections.excluded_agreements} defaulted agreement{collections.excluded_agreements === 1 ? ' has' : 's have'} no
              end date recorded and {collections.excluded_agreements === 1 ? 'is' : 'are'} left out.</>
            )}
          </div>
        </div>

        <div>
          <div className="text-sm" style={{ fontWeight: 600, marginBottom: 6 }}>How far behind active agreements are</div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Behind by</th><th>Agreements</th><th>Owed</th></tr></thead>
              <tbody>
                {arrears.buckets.map((b) => (
                  <tr key={b.key}>
                    <td className="text-xs">{b.label}</td>
                    <td className="text-xs">{b.agreements}</td>
                    <td className="text-xs" style={b.key === 'd90_plus' && b.amount > 0 ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                      {b.key === 'current' ? '—' : fmt(b.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted text-xs" style={{ marginTop: 8, lineHeight: 1.5 }}>
            Active agreements owe {fmt(arrears.active_overdue)}.
            {arrears.other_overdue > 0 && (
              <> The Overdue amount above is {fmt(arrears.total_overdue)} because it also counts {fmt(arrears.other_overdue)} still
              owed on agreements that are paused or have ended.</>
            )}
            {losses.lost > 0 && losses.priced === 0 && (
              <> None of the {losses.lost} lost bikes has a purchase price recorded, so their value can't be totalled.</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [kpis, setKpis] = useState(null);
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
    // Loaded separately so a failure here never takes the rest of the dashboard with it.
    api.get('/admin/kpis').then((r) => setKpis(r.data)).catch(() => setKpis(null));
  }, [user?.role]);

  const s = d?.stats || {};
  const {
    pending_applications = 0,
    pending_kyc = 0,
    default_action_count = 0,
    upcoming_services = 0,
    expiring_license_disc = 0,
    expiring_insurance = 0
  } = s;

  const actions = useMemo(() => ([
    { icon: <ClipboardList size={18} />, count: pending_applications, label: 'Pending applications', link: '/admin/applications?status=submitted' },
    { icon: <BadgeCheck size={18} />, count: pending_kyc, label: 'Application documents to review', link: '/admin/applications?status=under_review' },
    { icon: <AlertCircle size={18} />, count: default_action_count, label: 'Defaulted agreements needing action', link: '/admin/agreements?status=defaulted&exclude_bike_statuses=stolen,written_off,sold', danger: true },
    { icon: <Wrench size={18} />, count: upcoming_services, label: 'Bikes due for service (14d)', link: '/admin/bikes?status=active' },
    { icon: <CreditCard size={18} />, count: expiring_license_disc, label: 'License discs expiring (30d)', link: '/admin/bikes', danger: true },
    { icon: <Shield size={18} />, count: expiring_insurance, label: 'Insurance expiring (30d)', link: '/admin/bikes' }
  ].filter((item) => matchesSearch(search, item.label, item.count))), [pending_applications, pending_kyc, default_action_count, upcoming_services, expiring_license_disc, expiring_insurance, search]);

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

      <KpiPanel kpis={kpis} />

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
                <input type="file" accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.heic,.heif" onChange={(e) => setHeroImageFile(e.target.files?.[0] || null)} />
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
    <Link to={link} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>
      <div style={{ color: count > 0 ? (danger ? 'var(--danger)' : 'var(--primary)') : 'var(--muted)', flexShrink: 0 }}>{icon}</div>
      <div style={{ flex: 1 }}>{label}</div>
      <div className="badge" style={{ background: count > 0 ? (danger ? 'rgba(239,68,68,0.2)' : 'rgba(255,107,53,0.2)') : 'var(--surface-2)', color: count > 0 ? (danger ? 'var(--danger)' : 'var(--primary)') : 'var(--muted)' }}>{count}</div>
    </Link>
  );
}

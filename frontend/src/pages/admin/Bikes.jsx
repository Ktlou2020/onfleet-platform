import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, Pagination, SearchInput, fmt, fmtDate, matchesSearch, paginateItems, CopyableContactValue } from '../../components/ui';
import { Plus } from 'lucide-react';
import { useAuth } from '../../auth';

const bikeStatusOptions = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'not_available', label: 'Not available' },
  { value: 'sold', label: 'Sold' },
  { value: 'paid_off', label: 'Paid off' },
  { value: 'written_off', label: 'Written off' },
  { value: 'repairs', label: 'Repairs' },
  { value: 'ready_to_go', label: 'Ready to go' },
  { value: 'stationary', label: 'Stationary' }
];

function getBikeStatusLabel(status) {
  return bikeStatusOptions.find((option) => option.value === status)?.label || status || '—';
}

function getExpiryMeta(date) {
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${date}T00:00:00`);
  const days = Math.round((expiry - today) / 86400000);
  if (days < 0) return { tone: 'var(--danger)', label: `License disc expired ${Math.abs(days)}d ago` };
  if (days === 0) return { tone: 'var(--danger)', label: 'License disc expires today' };
  if (days <= 30) return { tone: 'var(--warn)', label: `License disc expires in ${days}d` };
  return { tone: 'var(--muted)', label: `License disc valid until ${fmtDate(date)}` };
}

function buildInitialForm() {
  return {
    vin: '',
    make: '',
    model: '',
    year: 2024,
    engine_cc: 125,
    color: '',
    condition: 'new',
    purchase_price: '',
    rental_weekly: '850',
    total_weeks: 78,
    registration: '',
    image_url: '',
    license_disc_no: '',
    license_disc_expiry: ''
  };
}

export default function AdminBikes() {
  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';
  const [bikes, setBikes] = useState(null);
  const [filter, setFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(9);
  const [savingStatusId, setSavingStatusId] = useState(null);
  const [statusDrafts, setStatusDrafts] = useState({});
  const [creating, setCreating] = useState(false);
  const [readingLicenseDisc, setReadingLicenseDisc] = useState(false);
  const [form, setForm] = useState(buildInitialForm());
  const [docFiles, setDocFiles] = useState({ rc1: null, license_disc: null });

  const load = () => api.get('/bikes', { params: filter ? { status: filter } : {} }).then((response) => {
    const nextBikes = response.data.bikes;
    setBikes(nextBikes);
    setStatusDrafts(Object.fromEntries(nextBikes.map((bike) => [bike.id, bike.status])));
  });

  useEffect(() => { load(); }, [filter]);
  useEffect(() => { setPage(1); }, [search, filter]);

  const filtered = (bikes || []).filter((bike) => matchesSearch(
    search,
    bike.vin,
    bike.registration,
    bike.make,
    bike.model,
    bike.year,
    bike.color,
    bike.status,
    getBikeStatusLabel(bike.status),
    bike.engine_cc,
    bike.odometer_km,
    bike.allocated_rider_name,
    bike.allocated_rider_phone,
    bike.allocated_agreement_no,
    bike.license_disc_no,
    bike.license_disc_expiry,
    bike.rc1_original_name,
    bike.license_disc_original_name
  ));

  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  const closeAddModal = () => {
    setShowAdd(false);
    setForm(buildInitialForm());
    setDocFiles({ rc1: null, license_disc: null });
    setReadingLicenseDisc(false);
    setCreating(false);
  };

  const openAddModal = () => {
    setForm(buildInitialForm());
    setDocFiles({ rc1: null, license_disc: null });
    setReadingLicenseDisc(false);
    setShowAdd(true);
  };

  const analyzeLicenseDisc = async (file) => {
    if (!file || !isSuperadmin) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      setReadingLicenseDisc(true);
      const { data } = await api.post('/bikes/document-insights/license-disc', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setForm((current) => ({
        ...current,
        license_disc_no: data.license_disc_no || current.license_disc_no,
        license_disc_expiry: data.license_disc_expiry || current.license_disc_expiry
      }));
      if (data.license_disc_expiry || data.license_disc_no) {
        toast.success(`License disc read${data.license_disc_expiry ? ` · expiry ${fmtDate(data.license_disc_expiry)}` : ''}`);
      } else {
        toast('License disc uploaded, but no expiry could be read automatically.');
      }
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not read license disc PDF');
    } finally {
      setReadingLicenseDisc(false);
    }
  };

  const handleDocumentSelection = async (documentType, file) => {
    setDocFiles((current) => ({ ...current, [documentType]: file || null }));
    if (documentType === 'license_disc' && file) {
      await analyzeLicenseDisc(file);
    }
  };

  const uploadBikeDocument = async (bikeId, documentType, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const { data } = await api.post(`/bikes/${bikeId}/documents/${documentType}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return data;
  };

  const create = async () => {
    try {
      setCreating(true);
      const { data } = await api.post('/bikes', {
        ...form,
        year: Number(form.year),
        engine_cc: Number(form.engine_cc),
        purchase_price: Number(form.purchase_price || 0),
        rental_weekly: Number(form.rental_weekly),
        total_weeks: Number(form.total_weeks)
      });

      const uploadIssues = [];
      let uploadedDocs = 0;
      let extractedExpiry = null;

      if (isSuperadmin && docFiles.rc1) {
        try {
          await uploadBikeDocument(data.id, 'rc1', docFiles.rc1);
          uploadedDocs += 1;
        } catch (error) {
          uploadIssues.push(error.response?.data?.error || 'RC1 upload failed');
        }
      }

      if (isSuperadmin && docFiles.license_disc) {
        try {
          const uploadResult = await uploadBikeDocument(data.id, 'license_disc', docFiles.license_disc);
          extractedExpiry = uploadResult.license_disc_expiry || null;
          uploadedDocs += 1;
        } catch (error) {
          uploadIssues.push(error.response?.data?.error || 'License disc upload failed');
        }
      }

      if (uploadIssues.length) {
        toast.error(`Bike added, but some documents still need attention: ${uploadIssues.join(' · ')}`);
      } else if (uploadedDocs && extractedExpiry) {
        toast.success(`Bike added and documents uploaded. License disc expiry set to ${fmtDate(extractedExpiry)}.`);
      } else if (uploadedDocs) {
        toast.success('Bike added and documents uploaded');
      } else {
        toast.success('Bike added');
      }

      closeAddModal();
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed');
    } finally {
      setCreating(false);
    }
  };

  const saveBikeStatus = async (bike) => {
    const nextStatus = statusDrafts[bike.id] || bike.status;
    if (nextStatus === bike.status) return toast('No status change to save');
    try {
      setSavingStatusId(bike.id);
      await api.put(`/bikes/${bike.id}`, { status: nextStatus });
      setBikes((current) => (current || []).map((item) => item.id === bike.id ? { ...item, status: nextStatus } : item));
      toast.success(`Bike status updated to ${getBikeStatusLabel(nextStatus)}`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update bike status');
      setStatusDrafts((current) => ({ ...current, [bike.id]: bike.status }));
    } finally {
      setSavingStatusId(null);
    }
  };

  if (!bikes) return <Loading />;
  return (
    <>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title">Bike Fleet</h1>
          <p className="page-sub">Manage inventory, assigned riders, service history, license disc compliance, and fleet statuses.</p>
        </div>
        <button className="btn" onClick={openAddModal}><Plus size={16} /> Add bike</button>
      </div>
      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search VIN, rider, registration, disc expiry" style={{ flex: '1 1 320px', maxWidth: 420 }} />
        <div className="muted text-sm">Showing {filtered.length} matching bikes</div>
      </div>
      <div className="row mb-4" style={{ flexWrap: 'wrap' }}>
        {bikeStatusOptions.map((option) => (
          <button key={option.value || 'all'} onClick={() => setFilter(option.value)} className={`btn btn-sm ${filter === option.value ? '' : 'btn-secondary'}`}>{option.label}</button>
        ))}
      </div>

      <div className="grid grid-3">
        {pagination.items.map((bike) => {
          const discMeta = getExpiryMeta(bike.license_disc_expiry);
          const draftStatus = statusDrafts[bike.id] || bike.status;
          const changed = draftStatus !== bike.status;
          return (
            <div key={bike.id} className="bike-card" style={{ color: 'var(--text)', display: 'block' }}>
              <div className="img" style={{ height: 180, backgroundImage: bike.image_url ? `url("${bike.image_url}")` : 'none', backgroundSize: 'cover', backgroundPosition: 'center', backgroundColor: '#0a1219', position: 'relative' }}>
                {bike.allocated_rider_name && (
                  <div style={{ position: 'absolute', left: 12, right: 12, bottom: 12, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'rgba(8,12,18,0.76)', backdropFilter: 'blur(8px)' }}>
                    <div className="avatar" style={{ width: 36, height: 36, backgroundImage: bike.allocated_rider_avatar_url ? `url(${bike.allocated_rider_avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 }}>{bike.allocated_rider_avatar_url ? '' : bike.allocated_rider_name?.[0]}</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="text-xs muted">Allocated rider</div>
                      <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bike.allocated_rider_name}</div>
                    </div>
                  </div>
                )}
              </div>
              <div className="body" style={{ padding: 16 }}>
                <div className="flex-between mb-2" style={{ gap: 12 }}>
                  <h3>{bike.make} {bike.model}</h3>
                  <Badge status={bike.status}>{getBikeStatusLabel(bike.status)}</Badge>
                </div>
                <div className="text-sm muted mb-3">{bike.year} · {bike.engine_cc}cc · {bike.color}</div>
                <div className="text-xs muted">VIN: {bike.vin}</div>
                <div className="text-xs muted">REG: {bike.registration || '—'}</div>
                <div className="flex-between mt-3 mb-1"><span className="muted text-sm">Weekly</span><strong style={{ color: 'var(--primary-light)' }}>{fmt(bike.rental_weekly)}</strong></div>
                <div className="flex-between"><span className="muted text-sm">Odometer</span><span>{bike.odometer_km || 0} km</span></div>
                {bike.next_service_date && <div className="flex-between"><span className="muted text-sm">Next service</span><span className="text-xs">{fmtDate(bike.next_service_date)}</span></div>}
                <div className="flex-between"><span className="muted text-sm">License disc</span><span className="text-xs">{bike.license_disc_expiry ? fmtDate(bike.license_disc_expiry) : '—'}</span></div>
                {discMeta && <div className="text-xs" style={{ marginTop: 8, color: discMeta.tone }}>{discMeta.label}</div>}
                {bike.rc1_file_path && <div className="text-xs muted mt-2">RC1 on file</div>}
                {bike.allocated_rider_name && (
                  <div className="card mt-3" style={{ background: 'var(--surface-2)', padding: 12 }}>
                    <div className="text-xs muted">Allocated to</div>
                    <div style={{ fontWeight: 700 }}>{bike.allocated_rider_name}</div>
                    <div className="mt-1"><CopyableContactValue value={bike.allocated_rider_phone} compact /></div>
                    <div className="text-xs muted mt-1">{bike.allocated_agreement_no || 'No agreement number'}</div>
                  </div>
                )}
                <div className="card mt-3" style={{ background: 'var(--surface-2)', padding: 12 }}>
                  <div className="text-xs muted" style={{ marginBottom: 8 }}>Quick status update</div>
                  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select value={draftStatus} onChange={(e) => setStatusDrafts((current) => ({ ...current, [bike.id]: e.target.value }))} style={{ flex: '1 1 190px' }}>
                      {bikeStatusOptions.filter((option) => option.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    <button className={`btn btn-sm ${changed ? '' : 'btn-secondary'}`} onClick={() => saveBikeStatus(bike)} disabled={savingStatusId === bike.id || !changed}>
                      {savingStatusId === bike.id ? 'Saving…' : 'Save status'}
                    </button>
                    <Link to={`/admin/bikes/${bike.id}`} className="btn btn-sm btn-secondary">Open</Link>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {!pagination.items.length && <div className="card muted" style={{ textAlign: 'center' }}>{search ? 'No bikes match your search.' : 'No bikes found.'}</div>}
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="bikes" />

      {showAdd && (
        <Modal title="Add new bike" onClose={closeAddModal}>
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
            <div className="field"><label className="label">License disc no.</label><input value={form.license_disc_no} onChange={(e) => setForm({ ...form, license_disc_no: e.target.value })} /></div>
            <div className="field"><label className="label">License disc expiry</label><input type="date" value={form.license_disc_expiry} onChange={(e) => setForm({ ...form, license_disc_expiry: e.target.value })} /></div>
          </div>

          {isSuperadmin && (
            <div className="card mt-3" style={{ background: 'var(--surface-2)', padding: 14 }}>
              <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>Bike documents</div>
                  <div className="muted text-sm">Upload PDFs for the RC1 and the license disc while creating the bike.</div>
                </div>
                <div className="text-xs muted">Superadmin only</div>
              </div>
              <div className="grid grid-2">
                <div className="field">
                  <label className="label">RC1 PDF</label>
                  <input type="file" accept="application/pdf" onChange={(e) => handleDocumentSelection('rc1', e.target.files?.[0] || null)} />
                  <div className="text-xs muted mt-1">{docFiles.rc1 ? docFiles.rc1.name : 'Optional'}</div>
                </div>
                <div className="field">
                  <label className="label">License disc PDF</label>
                  <input type="file" accept="application/pdf" onChange={(e) => handleDocumentSelection('license_disc', e.target.files?.[0] || null)} />
                  <div className="text-xs muted mt-1">
                    {readingLicenseDisc ? 'Reading license disc…' : docFiles.license_disc ? docFiles.license_disc.name : 'Upload to auto-read the expiry date'}
                  </div>
                  {form.license_disc_expiry && <div className="text-xs" style={{ marginTop: 6, color: 'var(--primary-light)' }}>Detected expiry: {fmtDate(form.license_disc_expiry)}</div>}
                </div>
              </div>
            </div>
          )}

          <div className="row"><button className="btn" onClick={create} disabled={creating || readingLicenseDisc}>{creating ? 'Adding…' : 'Add bike'}</button><button className="btn btn-secondary" onClick={closeAddModal} disabled={creating}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

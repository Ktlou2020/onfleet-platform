import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, Badge, Modal, Pagination, fmt, fmtDate, paginateItems } from '../../components/ui';
import { useAuth } from '../../auth';

const bikeStatusOptions = [
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

const bikeIcon = new L.DivIcon({
  html: `<div style="background:var(--primary);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white">🏍️</div>`,
  className: '', iconSize: [30, 30], iconAnchor: [15, 15]
});

function getExpiryMeta(date) {
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${date}T00:00:00`);
  const days = Math.round((expiry - today) / 86400000);
  if (days < 0) return { tone: 'var(--danger)', label: `License disc expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago` };
  if (days === 0) return { tone: 'var(--danger)', label: 'License disc expires today' };
  if (days <= 30) return { tone: 'var(--warn)', label: `License disc expires in ${days} day${days === 1 ? '' : 's'}` };
  return { tone: 'var(--muted)', label: `License disc valid until ${fmtDate(date)}` };
}

export default function AdminBikeDetail() {
  const { user } = useAuth();
  const { id } = useParams();
  const isSuperadmin = user?.role === 'superadmin';
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({});
  const [showService, setShowService] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [rc1File, setRc1File] = useState(null);
  const [licenseDiscFile, setLicenseDiscFile] = useState(null);
  const [uploadingDoc, setUploadingDoc] = useState('');
  const [servicePage, setServicePage] = useState(1);
  const [servicePageSize, setServicePageSize] = useState(10);
  const [service, setService] = useState({ service_date: new Date().toISOString().slice(0, 10), service_type: 'monthly', description: '', odometer_km: '', cost: 0, next_service_date: '', next_service_km: '', performed_by: 'OnFleet Workshop', invoice: null });

  const load = () => api.get(`/bikes/${id}`).then((response) => {
    setData(response.data);
    setForm(response.data.bike);
  });

  useEffect(() => { load(); }, [id]);

  const uploadBikeDocument = async (documentType, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const { data: result } = await api.post(`/bikes/${id}/documents/${documentType}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return result;
  };

  const handleDocumentUpload = async (documentType) => {
    const file = documentType === 'rc1' ? rc1File : licenseDiscFile;
    if (!file) return toast.error(`Choose a ${documentType === 'rc1' ? 'RC1' : 'license disc'} PDF first`);
    try {
      setUploadingDoc(documentType);
      const result = await uploadBikeDocument(documentType, file);
      if (documentType === 'rc1') {
        toast.success('RC1 uploaded');
        setRc1File(null);
      } else if (result.license_disc_expiry) {
        toast.success(`License disc uploaded · expiry set to ${fmtDate(result.license_disc_expiry)}`);
        setLicenseDiscFile(null);
      } else {
        toast('License disc uploaded, but no expiry could be read automatically.');
        setLicenseDiscFile(null);
      }
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Document upload failed');
    } finally {
      setUploadingDoc('');
    }
  };

  if (!data) return <Loading />;
  const bike = data.bike;
  const pos = bike.last_known_lat ? [bike.last_known_lat, bike.last_known_lng] : null;
  const servicePagination = paginateItems(data.services, servicePage, servicePageSize);
  const discMeta = getExpiryMeta(bike.license_disc_expiry);

  const save = async () => {
    try {
      await api.put(`/bikes/${id}`, form);
      toast.success('Saved');
      setEdit(false);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed');
    }
  };

  const uploadImage = async () => {
    if (!imageFile) return toast.error('Choose an image first');
    const fd = new FormData();
    fd.append('image', imageFile);
    try {
      await api.post(`/bikes/${id}/image`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Bike image updated');
      setImageFile(null);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Upload failed');
    }
  };

  const addService = async () => {
    const fd = new FormData();
    Object.entries(service).forEach(([key, value]) => {
      if (key === 'invoice') return;
      fd.append(key, value ?? '');
    });
    if (service.invoice) fd.append('invoice', service.invoice);
    try {
      await api.post(`/bikes/${id}/service`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Service event logged');
      setShowService(false);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed');
    }
  };

  return (
    <>
      <Link to="/admin/bikes" className="muted text-sm">← Back to fleet</Link>
      <div className="flex-between mt-2 mb-4">
        <div>
          <h1 className="page-title">{bike.make} {bike.model}</h1>
          <div className="muted">VIN {bike.vin} · {bike.registration || 'no registration yet'}</div>
        </div>
        <div className="row"><Badge status={bike.status}>{getBikeStatusLabel(bike.status)}</Badge><button className="btn btn-sm btn-secondary" onClick={() => setEdit(!edit)}>{edit ? 'Cancel' : 'Edit'}</button><button className="btn btn-sm" onClick={() => setShowService(true)}>+ Log service / repair</button></div>
      </div>

      {discMeta && (
        <div className="card mb-4" style={{ border: `1px solid ${discMeta.tone}`, background: 'rgba(255,255,255,0.01)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: discMeta.tone }}>License disc alert</div>
          <div className="muted text-sm">{discMeta.label}. Track renewals here so admins can action compliance before the bike is flagged.</div>
        </div>
      )}

      <div className="grid grid-4 mb-4">
        <div className="stat"><div className="stat-label">Revenue</div><div className="stat-value">{fmt(data.roi?.revenue_total)}</div></div>
        <div className="stat"><div className="stat-label">Purchase price</div><div className="stat-value">{fmt(data.roi?.purchase_price)}</div></div>
        <div className="stat"><div className="stat-label">Service + repairs</div><div className="stat-value">{fmt(data.roi?.service_cost_total)}</div></div>
        <div className="stat"><div className="stat-label">Net ROI</div><div className="stat-value">{fmt(data.roi?.net_roi)}{data.roi?.roi_pct !== null && <div className="muted text-sm">{data.roi?.roi_pct}%</div>}</div></div>
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Bike image</h3>
          <div style={{ height: 260, borderRadius: 12, background: '#0a1219 center/cover no-repeat', backgroundImage: bike.image_url ? `url("${bike.image_url}")` : 'none', position: 'relative' }}>
            {bike.allocated_rider_name && (
              <div style={{ position: 'absolute', left: 16, right: 16, bottom: 16, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, background: 'rgba(8,12,18,0.76)', backdropFilter: 'blur(8px)' }}>
                <div className="avatar" style={{ width: 44, height: 44, backgroundImage: bike.allocated_rider_avatar_url ? `url(${bike.allocated_rider_avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }}>{bike.allocated_rider_avatar_url ? '' : bike.allocated_rider_name?.[0]}</div>
                <div>
                  <div className="text-xs muted">Allocated rider</div>
                  <div style={{ fontWeight: 700 }}>{bike.allocated_rider_name}</div>
                  <div className="text-xs muted">{bike.allocated_rider_phone || 'No phone'} · {bike.allocated_agreement_no || 'No agreement number'}</div>
                </div>
              </div>
            )}
          </div>
          <div className="row mt-3"><input type="file" accept="image/jpeg,image/jpg,image/png,image/webp" onChange={(e) => setImageFile(e.target.files?.[0] || null)} /><button className="btn btn-secondary" onClick={uploadImage}>Upload image</button></div>
        </div>
        <div className="card">
          <h3 className="mb-3">Details</h3>
          {edit ? (
            <>
              <div className="grid grid-2">
                <div className="field"><label className="label">Status</label><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{bikeStatusOptions.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></div>
                <div className="field"><label className="label">Registration</label><input value={form.registration || ''} onChange={(e) => setForm({ ...form, registration: e.target.value })} /></div>
                <div className="field"><label className="label">Odometer (km)</label><input type="number" value={form.odometer_km || 0} onChange={(e) => setForm({ ...form, odometer_km: Number(e.target.value) })} /></div>
                <div className="field"><label className="label">Weekly rental</label><input type="number" value={form.rental_weekly} onChange={(e) => setForm({ ...form, rental_weekly: Number(e.target.value) })} /></div>
                <div className="field"><label className="label">Insurance provider</label><input value={form.insurance_provider || ''} onChange={(e) => setForm({ ...form, insurance_provider: e.target.value })} /></div>
                <div className="field"><label className="label">Insurance expiry</label><input type="date" value={form.insurance_expiry || ''} onChange={(e) => setForm({ ...form, insurance_expiry: e.target.value })} /></div>
                <div className="field"><label className="label">License disc no.</label><input value={form.license_disc_no || ''} onChange={(e) => setForm({ ...form, license_disc_no: e.target.value })} /></div>
                <div className="field"><label className="label">License disc expiry</label><input type="date" value={form.license_disc_expiry || ''} onChange={(e) => setForm({ ...form, license_disc_expiry: e.target.value })} /></div>
                <div className="field"><label className="label">Next service date</label><input type="date" value={form.next_service_date || ''} onChange={(e) => setForm({ ...form, next_service_date: e.target.value })} /></div>
                <div className="field"><label className="label">Next service km</label><input type="number" value={form.next_service_km || 0} onChange={(e) => setForm({ ...form, next_service_km: Number(e.target.value) })} /></div>
              </div>
              <button className="btn" onClick={save}>Save changes</button>
            </>
          ) : (
            <>
              <Row k="VIN" v={bike.vin} />
              <Row k="Year" v={bike.year} />
              <Row k="Engine" v={bike.engine_cc ? `${bike.engine_cc}cc` : '—'} />
              <Row k="Color" v={bike.color} />
              <Row k="Status" v={getBikeStatusLabel(bike.status)} />
              <Row k="Condition" v={bike.condition} />
              <Row k="Weekly rental" v={fmt(bike.rental_weekly)} />
              <Row k="Purchase price" v={fmt(bike.purchase_price)} />
              <Row k="Odometer" v={`${bike.odometer_km || 0} km`} />
              <Row k="Insurance" v={`${bike.insurance_provider || '—'} · expires ${fmtDate(bike.insurance_expiry)}`} />
              <Row k="License disc" v={`${bike.license_disc_no || '—'} · expires ${fmtDate(bike.license_disc_expiry)}`} />
              <Row k="RC1 file" v={bike.rc1_file_path ? <a href={bike.rc1_file_path} target="_blank" rel="noreferrer">{bike.rc1_original_name || 'Open RC1 PDF'}</a> : '—'} />
              <Row k="License disc file" v={bike.license_disc_file_path ? <a href={bike.license_disc_file_path} target="_blank" rel="noreferrer">{bike.license_disc_original_name || 'Open license disc PDF'}</a> : '—'} />
              <Row k="Next service" v={`${fmtDate(bike.next_service_date)} or ${bike.next_service_km || '—'} km`} />
            </>
          )}

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700 }}>Bike documents</div>
                <div className="muted text-sm">Store the RC1 and the license disc PDF under this bike record.</div>
              </div>
              {isSuperadmin && <div className="text-xs muted">Superadmin only</div>}
            </div>

            <div className="grid grid-2">
              <div className="card" style={{ background: 'var(--surface-2)', padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>RC1</div>
                <div className="text-sm muted" style={{ marginBottom: 10 }}>{bike.rc1_file_path ? 'PDF available for download' : 'No RC1 uploaded yet'}</div>
                {bike.rc1_file_path && <a href={bike.rc1_file_path} target="_blank" rel="noreferrer">{bike.rc1_original_name || 'Open RC1 PDF'}</a>}
                {isSuperadmin && (
                  <>
                    <div className="field mt-3"><label className="label">Replace / upload RC1 PDF</label><input type="file" accept="application/pdf" onChange={(e) => setRc1File(e.target.files?.[0] || null)} /></div>
                    <button className="btn btn-secondary btn-sm" onClick={() => handleDocumentUpload('rc1')} disabled={uploadingDoc === 'rc1'}>{uploadingDoc === 'rc1' ? 'Uploading…' : 'Upload RC1'}</button>
                  </>
                )}
              </div>

              <div className="card" style={{ background: 'var(--surface-2)', padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>License disc</div>
                <div className="text-sm muted" style={{ marginBottom: 10 }}>{bike.license_disc_file_path ? 'PDF available for download' : 'No license disc uploaded yet'}</div>
                {bike.license_disc_file_path && <a href={bike.license_disc_file_path} target="_blank" rel="noreferrer">{bike.license_disc_original_name || 'Open license disc PDF'}</a>}
                {bike.license_disc_expiry && <div className="text-xs" style={{ marginTop: 8, color: 'var(--primary-light)' }}>Current expiry: {fmtDate(bike.license_disc_expiry)}</div>}
                {isSuperadmin && (
                  <>
                    <div className="field mt-3"><label className="label">Replace / upload license disc PDF</label><input type="file" accept="application/pdf" onChange={(e) => setLicenseDiscFile(e.target.files?.[0] || null)} /></div>
                    <button className="btn btn-secondary btn-sm" onClick={() => handleDocumentUpload('license_disc')} disabled={uploadingDoc === 'license_disc'}>{uploadingDoc === 'license_disc' ? 'Uploading…' : 'Upload license disc'}</button>
                    <div className="text-xs muted mt-2">The system will read the PDF and update the stored disc expiry automatically when it can detect one.</div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {bike.allocated_rider_name && (
        <div className="card mb-4">
          <h3 className="mb-3">Allocated rider</h3>
          <div className="row" style={{ alignItems: 'center', gap: 16 }}>
            <div className="avatar" style={{ width: 72, height: 72, backgroundImage: bike.allocated_rider_avatar_url ? `url(${bike.allocated_rider_avatar_url})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center', fontSize: 28 }}>{bike.allocated_rider_avatar_url ? '' : bike.allocated_rider_name?.[0]}</div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{bike.allocated_rider_name}</div>
              <div className="muted">{bike.allocated_rider_phone || 'No phone saved'}</div>
              <div className="text-xs muted">Agreement {bike.allocated_agreement_no || '—'}</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-2 mb-4">
        <div className="card">
          <h3 className="mb-3">Live location</h3>
          {pos ? <div style={{ height: 320, borderRadius: 8, overflow: 'hidden' }}><MapContainer center={pos} zoom={13} style={{ height: '100%' }}><TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /><Marker position={pos} icon={bikeIcon}><Popup>{bike.make} {bike.model}</Popup></Marker></MapContainer></div> : <div className="muted">No GPS data yet.</div>}
        </div>
        <div className="card">
          <h3 className="mb-3">Service & repair history</h3>
          <table className="table">
            <thead><tr><th>Date</th><th>Type</th><th>Cost</th><th>Invoice</th></tr></thead>
            <tbody>
              {servicePagination.items.map((serviceRow) => (
                <tr key={serviceRow.id}>
                  <td>{fmtDate(serviceRow.service_date)}</td>
                  <td>{serviceRow.service_type}</td>
                  <td>{fmt(serviceRow.cost)}</td>
                  <td>{serviceRow.invoice_file_path ? <a href={serviceRow.invoice_file_path} target="_blank" rel="noreferrer">{serviceRow.invoice_original_name || 'Open'}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!servicePagination.items.length && <div className="muted text-sm">No service records yet.</div>}
          <Pagination page={servicePagination.currentPage} pageSize={servicePagination.pageSize} totalItems={servicePagination.totalItems} onPageChange={setServicePage} onPageSizeChange={setServicePageSize} label="service records" />
        </div>
      </div>

      {showService && <Modal title="Log service or repair" onClose={() => setShowService(false)}>
        <div className="grid grid-2">
          <div className="field"><label className="label">Date</label><input type="date" value={service.service_date} onChange={(e) => setService({ ...service, service_date: e.target.value })} /></div>
          <div className="field"><label className="label">Type</label><select value={service.service_type} onChange={(e) => setService({ ...service, service_type: e.target.value })}><option value="monthly">Monthly service</option><option value="major">Major service</option><option value="repair">Repair</option><option value="tyres">Tyres</option></select></div>
          <div className="field"><label className="label">Odometer (km)</label><input type="number" value={service.odometer_km} onChange={(e) => setService({ ...service, odometer_km: Number(e.target.value) })} /></div>
          <div className="field"><label className="label">Cost (R)</label><input type="number" value={service.cost} onChange={(e) => setService({ ...service, cost: Number(e.target.value) })} /></div>
          <div className="field"><label className="label">Next service date</label><input type="date" value={service.next_service_date} onChange={(e) => setService({ ...service, next_service_date: e.target.value })} /></div>
          <div className="field"><label className="label">Next service km</label><input type="number" value={service.next_service_km} onChange={(e) => setService({ ...service, next_service_km: Number(e.target.value) })} /></div>
        </div>
        <div className="field"><label className="label">Performed by</label><input value={service.performed_by} onChange={(e) => setService({ ...service, performed_by: e.target.value })} /></div>
        <div className="field"><label className="label">Description</label><textarea rows={3} value={service.description} onChange={(e) => setService({ ...service, description: e.target.value })} /></div>
        <div className="field"><label className="label">Invoice / receipt (PDF or image)</label><input type="file" accept="application/pdf,image/jpeg,image/jpg,image/png" onChange={(e) => setService({ ...service, invoice: e.target.files?.[0] || null })} /></div>
        <button className="btn" onClick={addService}>Log event</button>
      </Modal>}
    </>
  );
}

function Row({ k, v }) {
  return <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><span className="muted text-sm">{k}</span><span>{v || '—'}</span></div>;
}

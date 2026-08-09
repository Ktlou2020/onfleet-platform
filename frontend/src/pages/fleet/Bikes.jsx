import { useEffect, useMemo, useState } from 'react';
import { Bike as BikeIcon, Pencil, Plus, Wrench } from 'lucide-react';
import { FleetHelpTip } from './helpSupport';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../auth';
import { Badge, EmptyState, ListPageSkeleton, Loading, Modal, Pagination, SearchInput, fmt, fmtDate, matchesSearch, paginateItems } from '../../components/ui';
import { canManageFleetSection } from './access';

const bikeStatusOptions = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'not_available', label: 'Not available' },
  { value: 'sold', label: 'Sold' },
  { value: 'paid_off', label: 'Paid off' },
  { value: 'written_off', label: 'Written off' },
  { value: 'stolen', label: 'Stolen' },
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

function getServiceUrgency(nextServiceDate, nextServiceKm, odometerKm) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (nextServiceDate) {
    const serviceDay = new Date(`${nextServiceDate}T00:00:00`);
    const days = Math.round((serviceDay - today) / 86400000);
    if (days < 0) return { cls: 'urgency-overdue', label: `Service overdue by ${Math.abs(days)}d` };
    if (days === 0) return { cls: 'urgency-overdue', label: 'Service due today' };
    if (days <= 14) return { cls: 'urgency-soon', label: `Service in ${days}d` };
    return { cls: 'urgency-ok', label: `Service in ${days}d` };
  }
  if (nextServiceKm && odometerKm) {
    const kmLeft = Number(nextServiceKm) - Number(odometerKm);
    if (kmLeft <= 0) return { cls: 'urgency-overdue', label: 'Service overdue by km' };
    if (kmLeft <= 500) return { cls: 'urgency-soon', label: `Service in ${kmLeft} km` };
  }
  return null;
}

const SERVICEABLE_STATUS_OPTIONS = bikeStatusOptions.filter((option) => ['active', 'ready_to_go', 'repairs', 'not_available', 'stationary'].includes(option.value));

function buildInitialServiceForm(bike = {}) {
  return {
    service_date: new Date().toISOString().slice(0, 10),
    service_type: 'monthly',
    description: '',
    cost: '',
    odometer_km: bike?.odometer_km || '',
    next_service_km: bike?.odometer_km ? Number(bike.odometer_km) + 3000 : '',
    next_service_date: '',
    performed_by: '',
    bike_status_after_service: ''
  };
}

function buildInitialForm() {
  return {
    vin: '',
    make: '',
    model: '',
    registration: '',
    fleet: '',
    year: 2024,
    engine_cc: 125,
    color: '',
    condition: 'new',
    purchase_price: '',
    rental_weekly: '850',
    total_weeks: 78,
    odometer_km: 0,
    status: 'ready_to_go',
    image_url: '',
    license_disc_no: '',
    license_disc_expiry: '',
    next_service_date: '',
    next_service_km: '',
    notes: ''
  };
}

export default function FleetOwnerBikes() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'bikes');
  const [bikes, setBikes] = useState(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [fleetFilter, setFleetFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(9);
  const [savingStatusId, setSavingStatusId] = useState(null);
  const [statusDrafts, setStatusDrafts] = useState({});
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingBike, setEditingBike] = useState(null);
  const [form, setForm] = useState(buildInitialForm());
  const [historyBike, setHistoryBike] = useState(null);
  const [serviceRecords, setServiceRecords] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [showLogService, setShowLogService] = useState(false);
  const [serviceForm, setServiceForm] = useState(buildInitialServiceForm());
  const [loggingService, setLoggingService] = useState(false);
  const [serviceKmTouched, setServiceKmTouched] = useState(false);

  const load = async () => {
    const response = await api.get('/fleet/bikes', { params: filter ? { status: filter } : {} });
    const nextBikes = response.data.bikes;
    setBikes(nextBikes);
    setStatusDrafts(Object.fromEntries(nextBikes.map((bike) => [bike.id, bike.status])));
  };

  useEffect(() => { load().catch(() => toast.error('Could not load bikes')); }, [filter]);
  useEffect(() => { setPage(1); }, [search, filter, fleetFilter]);

  const fleetOptions = useMemo(() => Array.from(new Set((bikes || []).map((bike) => String(bike.fleet || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [bikes]);
  const filtered = useMemo(() => (bikes || []).filter((bike) => matchesSearch(
    search,
    bike.vin,
    bike.registration,
    bike.fleet,
    bike.make,
    bike.model,
    bike.year,
    bike.color,
    bike.status,
    getBikeStatusLabel(bike.status),
    bike.engine_cc,
    bike.odometer_km,
    bike.rider_name,
    bike.rider_email,
    bike.rider_phone,
    bike.agreement_no,
    bike.license_disc_no,
    bike.license_disc_expiry
  ) && (!fleetFilter || String(bike.fleet || '').trim() === fleetFilter)), [bikes, search, fleetFilter]);
  const pagination = useMemo(() => paginateItems(filtered, page, pageSize), [filtered, page, pageSize]);

  const closeModal = () => {
    setShowAdd(false);
    setEditingBike(null);
    setForm(buildInitialForm());
    setSaving(false);
  };

  const openAddModal = () => {
    setEditingBike(null);
    setForm(buildInitialForm());
    setShowAdd(true);
  };

  const openEditModal = (bike) => {
    setEditingBike(bike);
    setForm({
      vin: bike.vin || '',
      make: bike.make || '',
      model: bike.model || '',
      registration: bike.registration || '',
      fleet: bike.fleet || '',
      year: bike.year || 2024,
      engine_cc: bike.engine_cc || 125,
      color: bike.color || '',
      condition: bike.condition || 'new',
      purchase_price: bike.purchase_price || '',
      rental_weekly: bike.rental_weekly || '',
      total_weeks: bike.total_weeks || 78,
      odometer_km: bike.odometer_km || 0,
      status: bike.status || 'ready_to_go',
      image_url: bike.image_url || '',
      license_disc_no: bike.license_disc_no || '',
      license_disc_expiry: bike.license_disc_expiry || '',
      next_service_date: bike.next_service_date || '',
      next_service_km: bike.next_service_km || '',
      notes: bike.notes || ''
    });
    setShowAdd(true);
  };

  const openHistory = async (bike) => {
    setHistoryBike(bike);
    setLoadingHistory(true);
    try {
      const { data } = await api.get(`/fleet/bikes/${bike.id}/service`);
      setServiceRecords(data.service || []);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load service history');
      setServiceRecords([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  const closeHistory = () => {
    setHistoryBike(null);
    setServiceRecords([]);
    setShowLogService(false);
  };

  const openLogService = () => {
    setServiceForm(buildInitialServiceForm(historyBike));
    setServiceKmTouched(false);
    setShowLogService(true);
  };

  const onOdometerChange = (value) => {
    setServiceForm((f) => ({
      ...f,
      odometer_km: value,
      next_service_km: serviceKmTouched ? f.next_service_km : (value ? Number(value) + 3000 : '')
    }));
  };

  const logService = async () => {
    if (!serviceForm.service_date || !serviceForm.service_type) {
      return toast.error('Service date and type are required');
    }
    setLoggingService(true);
    try {
      await api.post('/fleet/maintenance/log', { ...serviceForm, bike_id: historyBike.id });
      toast.success('Service logged');
      setShowLogService(false);
      await Promise.all([openHistory(historyBike), load()]);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not log service');
    } finally {
      setLoggingService(false);
    }
  };

  const saveBike = async () => {
    try {
      setSaving(true);
      const payload = {
        ...form,
        year: Number(form.year) || null,
        engine_cc: Number(form.engine_cc) || null,
        purchase_price: form.purchase_price === '' ? null : Number(form.purchase_price),
        rental_weekly: Number(form.rental_weekly),
        total_weeks: Number(form.total_weeks) || 78,
        odometer_km: Number(form.odometer_km) || 0
      };
      if (!payload.vin || !payload.make || !payload.model || !payload.rental_weekly) {
        throw new Error('VIN, make, model, and weekly rental are required');
      }
      if (editingBike) {
        await api.put(`/fleet/bikes/${editingBike.id}`, payload);
        toast.success('Bike updated');
      } else {
        await api.post('/fleet/bikes', payload);
        toast.success('Bike added');
      }
      closeModal();
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || error.message || 'Could not save bike');
      setSaving(false);
    }
  };

  const saveBikeStatus = async (bike) => {
    const nextStatus = statusDrafts[bike.id] || bike.status;
    if (nextStatus === bike.status) return toast('No status change to save');
    try {
      setSavingStatusId(bike.id);
      const { data } = await api.put(`/fleet/bikes/${bike.id}`, { status: nextStatus });
      if (nextStatus === 'stolen' && data?.discontinued_agreement_no) {
        toast.success(`Bike marked stolen. Agreement ${data.discontinued_agreement_no} was discontinued.`);
      } else {
        toast.success(`Bike status updated to ${getBikeStatusLabel(nextStatus)}`);
      }
      await load();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not update bike status');
      setStatusDrafts((current) => ({ ...current, [bike.id]: bike.status }));
    } finally {
      setSavingStatusId(null);
    }
  };

  if (!bikes) return <ListPageSkeleton />;

  return (
    <>
      <div className="flex-between mb-2" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Bikes Fleet</h1>
          <p className="page-sub" style={{ marginBottom: 8 }}>Add new bikes, edit current inventory, and manage operational status with the same fast card workflow used in the super admin console.</p>
          <FleetHelpTip section="bikes" tooltip="Use this guide for adding bikes, searching by registration or VIN, managing fleet tags, and updating bike status changes." label="Learn more about bikes" />
        </div>
        {canManage && <button className="btn" onClick={openAddModal} title="Add a new bike record to your fleet inventory"><Plus size={16} /> Add bike</button>}
      </div>
      <div className="row mb-3" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search VIN, rider, registration, fleet, disc expiry" style={{ flex: '1 1 320px', maxWidth: 420 }} />
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={fleetFilter} onChange={(e) => setFleetFilter(e.target.value)} style={{ minWidth: 180 }} title="Filter bikes by fleet tag or business unit">
            <option value="">All fleets</option>
            {fleetOptions.map((fleetName) => <option key={fleetName} value={fleetName}>{fleetName}</option>)}
          </select>
          <div className="muted text-sm">Showing {filtered.length} matching bikes</div>
          <FleetHelpTip section="common-questions" tooltip="Search works best with registration, VIN, fleet name, rider name, agreement number, or licence disc details." label="Search tips" compact />
        </div>
      </div>
      <div className="row mb-4" style={{ flexWrap: 'wrap' }}>
        {bikeStatusOptions.map((option) => (
          <button key={option.value || 'all'} onClick={() => setFilter(option.value)} className={`btn btn-sm ${filter === option.value ? '' : 'btn-secondary'}`}>{option.label}</button>
        ))}
      </div>

      <div className="grid grid-3">
        {pagination.items.map((bike) => {
          const discMeta = getExpiryMeta(bike.license_disc_expiry);
          const serviceUrgency = getServiceUrgency(bike.next_service_date, bike.next_service_km, bike.odometer_km);
          const draftStatus = statusDrafts[bike.id] || bike.status;
          const changed = draftStatus !== bike.status;
          return (
            <div key={bike.id} className="bike-card" style={{ color: 'var(--text)', display: 'block' }}>
              <div className="img" style={{ height: 170, backgroundImage: bike.image_url ? `url("${bike.image_url}")` : 'none', backgroundSize: 'cover', backgroundPosition: 'center', backgroundColor: '#0a1219', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                {!bike.image_url && <BikeIcon size={42} style={{ color: 'var(--muted)' }} />}
                {serviceUrgency && (
                  <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 100, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <span className={`urgency-dot ${serviceUrgency.cls}`} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{serviceUrgency.label}</span>
                  </div>
                )}
              </div>
              <div className="body" style={{ padding: 16 }}>
                <div className="flex-between mb-2" style={{ gap: 12 }}>
                  <h3>{bike.registration || `Bike #${bike.id}`}</h3>
                  <Badge status={bike.status}>{getBikeStatusLabel(bike.status)}</Badge>
                </div>
                <div className="text-sm" style={{ marginBottom: 8, fontWeight: 600 }}>{[bike.make, bike.model].filter(Boolean).join(' ') || '—'}</div>
                <div className="row mb-3" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="badge badge-info">Fleet: {bike.fleet || 'Unassigned'}</span>
                  <span className="badge badge-muted">{bike.year || '—'} · {bike.engine_cc || '—'}cc · {bike.color || '—'}</span>
                </div>
                <div className="text-xs muted">VIN: {bike.vin}</div>
                <div className="flex-between mt-3 mb-1"><span className="muted text-sm">Weekly rental</span><strong style={{ color: 'var(--primary-light)' }}>{fmt(bike.rental_weekly)}</strong></div>
                <div className="flex-between"><span className="muted text-sm">Odometer</span><span>{bike.odometer_km || 0} km</span></div>
                {(bike.next_service_date || bike.next_service_km) && (
                  <div className="flex-between mt-1">
                    <span className="muted text-sm">Next service</span>
                    <span className="text-xs" style={{ color: serviceUrgency?.cls === 'urgency-overdue' ? 'var(--danger)' : serviceUrgency?.cls === 'urgency-soon' ? 'var(--warn)' : undefined }}>
                      {bike.next_service_date ? fmtDate(bike.next_service_date) : '—'}{bike.next_service_km ? ` · ${Number(bike.next_service_km).toLocaleString('en-ZA')} km` : ''}
                    </span>
                  </div>
                )}
                <div className="flex-between mt-1"><span className="muted text-sm">License disc</span><span className="text-xs">{bike.license_disc_expiry ? fmtDate(bike.license_disc_expiry) : '—'}</span></div>
                {discMeta && <div className="text-xs" style={{ marginTop: 6, color: discMeta.tone }}>{discMeta.label}</div>}
                {bike.rider_name && <div className="text-xs muted mt-2">Rider: {bike.rider_name}</div>}
                {bike.agreement_no && <div className="text-xs muted">Agreement: {bike.agreement_no}</div>}
                <button className="btn btn-sm btn-secondary mt-3" style={{ width: '100%' }} onClick={() => openHistory(bike)}><Wrench size={14} /> Service &amp; repair history</button>
                {canManage && (
                  <div className="card mt-3" style={{ background: 'var(--surface-2)', padding: 12 }}>
                    <div className="fleet-help-meta" style={{ marginBottom: 8 }}>
                      <div className="text-xs muted">Quick actions</div>
                      <FleetHelpTip section="bikes" tooltip="Use quick actions to move a bike through its lifecycle and keep the fleet status accurate for allocations and maintenance." label="Learn more" compact />
                    </div>
                    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <select value={draftStatus} onChange={(e) => setStatusDrafts((current) => ({ ...current, [bike.id]: e.target.value }))} style={{ flex: '1 1 190px' }}>
                        {bikeStatusOptions.filter((option) => option.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                      <button className={`btn btn-sm ${changed ? '' : 'btn-secondary'}`} onClick={() => saveBikeStatus(bike)} disabled={savingStatusId === bike.id || !changed}>
                        {savingStatusId === bike.id ? 'Saving…' : 'Save status'}
                      </button>
                      <button className="btn btn-sm btn-secondary" onClick={() => openEditModal(bike)}><Pencil size={14} /> Edit</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!pagination.items.length && <EmptyState title="No bikes found" sub={search || filter || fleetFilter ? 'Adjust your filters or search terms to show more bikes.' : 'Add your first bike to start managing your fleet inventory.'} action={canManage ? <button className="btn" onClick={openAddModal}>Add bike</button> : null} />}
      <Pagination page={pagination.currentPage} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={setPage} onPageSizeChange={setPageSize} label="bikes" />

      {showAdd && (
        <Modal title={editingBike ? 'Edit bike' : 'Add bike'} onClose={closeModal}>
          <div className="mb-3">
            <FleetHelpTip section="bikes" tooltip="Capture registration, fleet tag, pricing, licence disc data, and status so the bike is ready for rider allocation and reporting." label="Open bike setup guide" compact />
          </div>
          <div className="grid grid-2">
            <div className="field"><label className="label">VIN *</label><input value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} /></div>
            <div className="field"><label className="label">Registration</label><input value={form.registration} onChange={(e) => setForm({ ...form, registration: e.target.value })} /></div>
            <div className="field"><label className="label">Make *</label><input value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} /></div>
            <div className="field"><label className="label">Model *</label><input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></div>
            <div className="field"><label className="label">Fleet</label><input value={form.fleet} onChange={(e) => setForm({ ...form, fleet: e.target.value })} placeholder="e.g. Johannesburg Dispatch" /></div>
            <div className="field"><label className="label">Status</label><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{bikeStatusOptions.filter((option) => option.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
            <div className="field"><label className="label">Year</label><input type="number" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} /></div>
            <div className="field"><label className="label">Engine cc</label><input type="number" value={form.engine_cc} onChange={(e) => setForm({ ...form, engine_cc: e.target.value })} /></div>
            <div className="field"><label className="label">Condition</label><select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}><option value="new">New</option><option value="used">Used</option></select></div>
            <div className="field"><label className="label">Color</label><input value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} /></div>
            <div className="field"><label className="label">Purchase price</label><input type="number" value={form.purchase_price} onChange={(e) => setForm({ ...form, purchase_price: e.target.value })} /></div>
            <div className="field"><label className="label">Weekly rental *</label><input type="number" value={form.rental_weekly} onChange={(e) => setForm({ ...form, rental_weekly: e.target.value })} /></div>
            <div className="field"><label className="label">Total weeks</label><input type="number" value={form.total_weeks} onChange={(e) => setForm({ ...form, total_weeks: e.target.value })} /></div>
            <div className="field"><label className="label">Odometer km</label><input type="number" value={form.odometer_km} onChange={(e) => setForm({ ...form, odometer_km: e.target.value })} /></div>
            <div className="field"><label className="label">Image URL</label><input value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} /></div>
            <div className="field"><label className="label">License disc no.</label><input value={form.license_disc_no} onChange={(e) => setForm({ ...form, license_disc_no: e.target.value })} /></div>
            <div className="field"><label className="label">License disc expiry</label><input type="date" value={form.license_disc_expiry} onChange={(e) => setForm({ ...form, license_disc_expiry: e.target.value })} /></div>
            <div className="field"><label className="label">Next service date</label><input type="date" value={form.next_service_date} onChange={(e) => setForm({ ...form, next_service_date: e.target.value })} /></div>
            <div className="field"><label className="label">Next service km</label><input type="number" value={form.next_service_km} onChange={(e) => setForm({ ...form, next_service_km: e.target.value })} placeholder="e.g. 12500" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label className="label">Notes</label><textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn" onClick={saveBike} disabled={saving}>{saving ? 'Saving…' : editingBike ? 'Save changes' : 'Add bike'}</button>
          </div>
        </Modal>
      )}

      {historyBike && (
        <Modal title={`Service & repair history · ${historyBike.registration || `Bike #${historyBike.id}`}`} onClose={closeHistory}>
          <div className="flex-between mb-3" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div className="muted text-sm">Includes services logged here and repairs completed by the OnFleet workshop.</div>
            {canManage && !showLogService && <button className="btn btn-sm" onClick={openLogService}>+ Log service / repair</button>}
          </div>

          {showLogService && (
            <div className="card mb-4" style={{ background: 'var(--surface-2)' }}>
              <div className="grid grid-2">
                <div className="field"><label className="label">Date</label><input type="date" value={serviceForm.service_date} onChange={(e) => setServiceForm((f) => ({ ...f, service_date: e.target.value }))} /></div>
                <div className="field"><label className="label">Type</label><select value={serviceForm.service_type} onChange={(e) => setServiceForm((f) => ({ ...f, service_type: e.target.value }))}><option value="monthly">Monthly service</option><option value="major">Major service</option><option value="repair">Repair</option><option value="tyres">Tyres</option></select></div>
                <div className="field"><label className="label">Odometer (km)</label><input type="number" value={serviceForm.odometer_km} onChange={(e) => onOdometerChange(e.target.value)} placeholder="Current km" /></div>
                <div className="field"><label className="label">Cost (R)</label><input type="number" value={serviceForm.cost} onChange={(e) => setServiceForm((f) => ({ ...f, cost: e.target.value }))} /></div>
                <div className="field">
                  <label className="label">Next service km</label>
                  <input type="number" value={serviceForm.next_service_km} onChange={(e) => { setServiceKmTouched(true); setServiceForm((f) => ({ ...f, next_service_km: e.target.value })); }} />
                  <div className="text-xs muted mt-1">Defaults to 3,000 km after this reading — edit if this bike needs a different interval.</div>
                </div>
                <div className="field"><label className="label">Next service date</label><input type="date" value={serviceForm.next_service_date} onChange={(e) => setServiceForm((f) => ({ ...f, next_service_date: e.target.value }))} /></div>
                <div className="field"><label className="label">Performed by</label><input value={serviceForm.performed_by} onChange={(e) => setServiceForm((f) => ({ ...f, performed_by: e.target.value }))} placeholder="Workshop or mechanic name" /></div>
                <div className="field"><label className="label">Bike status after</label><select value={serviceForm.bike_status_after_service} onChange={(e) => setServiceForm((f) => ({ ...f, bike_status_after_service: e.target.value }))}><option value="">No change</option>{SERVICEABLE_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
              </div>
              <div className="field"><label className="label">Description</label><textarea rows={2} value={serviceForm.description} onChange={(e) => setServiceForm((f) => ({ ...f, description: e.target.value }))} placeholder="What was done" /></div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setShowLogService(false)}>Cancel</button>
                <button className="btn" onClick={logService} disabled={loggingService}>{loggingService ? 'Logging…' : 'Log service'}</button>
              </div>
            </div>
          )}

          {loadingHistory ? <Loading /> : (
            <table className="table">
              <thead><tr><th>Date</th><th>Type</th><th>Odometer</th><th>Cost</th><th>Invoice</th></tr></thead>
              <tbody>
                {serviceRecords.map((serviceRow) => (
                  <tr key={serviceRow.id}>
                    <td>{fmtDate(serviceRow.service_date)}</td>
                    <td>{serviceRow.service_type}{serviceRow.job_card_id ? ' (workshop)' : ''}</td>
                    <td>{serviceRow.odometer_km ? `${Number(serviceRow.odometer_km).toLocaleString('en-ZA')} km` : '—'}</td>
                    <td>{fmt(serviceRow.cost)}</td>
                    <td>{serviceRow.invoice_file_path ? <a href={serviceRow.invoice_file_path} target="_blank" rel="noreferrer">{serviceRow.invoice_original_name || 'Open'}</a> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loadingHistory && !serviceRecords.length && <div className="muted text-sm">No service records yet.</div>}
        </Modal>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Plus, Pencil, Trash2, Clock, ChevronDown, ChevronRight, Printer, FileText } from 'lucide-react';
import api from '../../api';
import { Badge, ConfirmModal, Loading, Modal, fmt, fmtDate, fmtDateTime } from '../../components/ui';

const STATUS_COLOR = { open: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };
const PRIORITY_COLOR = { urgent: 'danger', high: 'warning', normal: 'info', low: '' };
const ITEM_TYPES = ['labor', 'part', 'consumable', 'other'];
// Must match bikes.status CHECK constraint
const BIKE_STATUSES = ['active', 'ready_to_go', 'repairs', 'not_available', 'stationary'];

const EMPTY_ITEM = { item_type: 'labor', description: '', quantity: '1', unit_cost: '' };
const EMPTY_COMPLETE = { completion_notes: '', odometer_km: '', next_service_date: '', next_service_km: '', bike_status_after: 'active' };
const QUICK_ITEMS = [
  { label: 'Basic service · R275', item_type: 'labor', description: 'Basic service', unit_cost: '275', quantity: '1' },
];

function elapsed(startedAt) {
  if (!startedAt) return null;
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function PartsSuggestions({ query, onSelect }) {
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => {
    if (!query || query.length < 2) { setSuggestions([]); return; }
    const t = setTimeout(() => {
      api.get('/workshop/parts-suggestions', { params: { q: query } })
        .then((r) => setSuggestions(r.data.suggestions))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  if (!suggestions.length) return null;
  return (
    <div className="card" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 40, padding: 6, maxHeight: 180, overflowY: 'auto' }}>
      {suggestions.map((s, i) => (
        <button key={i} className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 3 }} onClick={() => onSelect(s)}>
          <span>{s.description} <span className="muted text-xs">({s.item_type})</span></span>
          <span className="muted text-xs">{fmt(s.avg_unit_cost)} avg</span>
        </button>
      ))}
    </div>
  );
}

function buildPrintHTML(card, bikeReg, bikeMake, bikeModel) {
  const itemRows = card.items.map((item) => `
    <tr>
      <td>${item.item_type}</td>
      <td>${item.description}</td>
      <td style="text-align:right">${item.quantity}</td>
      <td style="text-align:right">R ${Number(item.unit_cost).toFixed(2)}</td>
      <td style="text-align:right;font-weight:700">R ${(item.quantity * item.unit_cost).toFixed(2)}</td>
    </tr>
  `).join('');
  const bikeYear = card.bike_year || card.year;
  const bikeVin = card.bike_vin || card.vin;
  const fleet = card.bike_org_name || card.fleet_org_name;
  return `<!DOCTYPE html><html><head>
    <title>Job Card #${card.id}</title>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; padding: 28px 32px; color: #111; font-size: 13px; }
      h1 { font-size: 22px; font-weight: 800; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #111; }
      .sub { font-size: 12px; color: #666; margin-top: 4px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
      .section { border: 1px solid #ddd; border-radius: 6px; padding: 14px; }
      .section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #888; margin-bottom: 8px; }
      .big { font-size: 20px; font-weight: 800; margin-bottom: 2px; }
      .meta { font-size: 12px; color: #555; margin-top: 2px; }
      .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
      .kv-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #888; }
      .kv-value { font-size: 13px; font-weight: 600; }
      table { width: 100%; border-collapse: collapse; margin-top: 4px; }
      th { background: #f4f4f4; text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid #ddd; }
      td { padding: 8px 10px; border-bottom: 1px solid #eee; font-size: 13px; }
      .total-row td { font-weight: 700; border-top: 2px solid #111; border-bottom: none; font-size: 14px; }
      .notes-box { margin-top: 20px; background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px; }
      .footer { margin-top: 24px; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 12px; display: flex; justify-content: space-between; }
      @media print { body { padding: 16px; } }
    </style>
  </head><body>
    <div class="header">
      <div>
        <h1>Job Card #${card.id}</h1>
        <div class="sub">${card.job_type.toUpperCase()} &nbsp;·&nbsp; ${card.status.replace('_', ' ').toUpperCase()} &nbsp;·&nbsp; Priority: ${card.priority}</div>
      </div>
      <div style="text-align:right;font-size:12px;color:#555;line-height:1.7">
        <div>Created: ${new Date(card.created_at).toLocaleDateString('en-ZA')}</div>
        ${card.started_at ? `<div>Started: ${new Date(card.started_at).toLocaleDateString('en-ZA')}</div>` : ''}
        ${card.completed_at ? `<div>Completed: ${new Date(card.completed_at).toLocaleDateString('en-ZA')}</div>` : ''}
      </div>
    </div>
    <div class="grid">
      <div class="section">
        <div class="section-title">Bike</div>
        <div class="big">${bikeReg || '—'}</div>
        <div class="meta">${bikeMake} ${bikeModel}${bikeYear ? ` · ${bikeYear}` : ''}</div>
        ${bikeVin ? `<div class="meta" style="margin-top:4px">VIN: ${bikeVin}</div>` : ''}
        ${fleet ? `<div class="meta">Fleet: ${fleet}</div>` : ''}
        ${card.fleet_owner_name && !fleet ? `<div class="meta">Owner: ${card.fleet_owner_name}</div>` : ''}
        ${card.bike_odometer_km != null ? `<div class="meta" style="margin-top:6px">Odometer: ${card.bike_odometer_km.toLocaleString()} km</div>` : ''}
      </div>
      <div class="section">
        <div class="section-title">Details</div>
        <div class="kv">
          <div><div class="kv-label">Technician</div><div class="kv-value">${card.technician_name || '—'}</div></div>
          <div><div class="kv-label">Created by</div><div class="kv-value">${card.created_by_name || '—'}</div></div>
        </div>
        ${card.description ? `<div style="margin-top:10px"><div class="section-title">Description</div><div style="white-space:pre-wrap;font-size:13px">${card.description}</div></div>` : ''}
      </div>
    </div>
    <div class="section-title" style="margin-bottom:6px">Line Items</div>
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Description</th>
          <th style="text-align:right">Qty</th>
          <th style="text-align:right">Unit Cost</th>
          <th style="text-align:right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows || '<tr><td colspan="5" style="text-align:center;color:#999;padding:20px">No line items</td></tr>'}
        <tr class="total-row">
          <td colspan="4" style="text-align:right">TOTAL</td>
          <td style="text-align:right">R ${Number(card.total_cost || 0).toFixed(2)}</td>
        </tr>
      </tbody>
    </table>
    ${card.completion_notes ? `<div class="notes-box"><div class="section-title">Completion Notes</div><div style="white-space:pre-wrap;margin-top:6px">${card.completion_notes}</div></div>` : ''}
    <div class="footer">
      <span>OnFleet Africa Workshop</span>
      <span>Printed ${new Date().toLocaleString('en-ZA')}</span>
    </div>
    <script>window.addEventListener('load', function(){ window.print(); });<\/script>
  </body></html>`;
}

export default function WorkshopJobCard() {
  const { id } = useParams();
  const nav = useNavigate();
  const [card, setCard] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(null);

  const [showAddItem, setShowAddItem] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showComplete, setShowComplete] = useState(false);
  const [completeForm, setCompleteForm] = useState(EMPTY_COMPLETE);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [cardRes, techRes, tmplRes] = await Promise.all([
      api.get(`/workshop/job-cards/${id}`),
      api.get('/workshop/technicians'),
      api.get('/workshop/templates'),
    ]);
    setCard(cardRes.data.job_card);
    setTechnicians(techRes.data.technicians);
    setTemplates(tmplRes.data.templates || []);
  };

  useEffect(() => { load().catch(() => toast.error('Could not load job card')); }, [id]);

  const loadHistory = async () => {
    if (history) return;
    try {
      const { data } = await api.get(`/workshop/job-cards/${id}/bike-history`);
      setHistory(data.records);
    } catch {
      setHistory([]);
    }
  };

  const toggleHistory = () => {
    setHistoryOpen((v) => !v);
    loadHistory();
  };

  const startJob = async () => {
    try {
      setBusy(true);
      const { data } = await api.post(`/workshop/job-cards/${id}/start`);
      setCard(data.job_card);
      toast.success('Job started');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not start job');
    } finally {
      setBusy(false);
    }
  };

  const completeJob = async () => {
    try {
      setBusy(true);
      const { data } = await api.post(`/workshop/job-cards/${id}/complete`, completeForm);
      setCard(data.job_card);
      setShowComplete(false);
      setHistory(null);
      toast.success('Job completed — service record saved');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not complete job');
    } finally {
      setBusy(false);
    }
  };

  const cancelJob = async () => {
    try {
      setBusy(true);
      await api.delete(`/workshop/job-cards/${id}`);
      toast.success('Job cancelled');
      nav('/workshop/app/job-cards');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not cancel job');
      setBusy(false);
    }
  };

  const saveItem = async () => {
    try {
      setBusy(true);
      const { data } = editItem
        ? await api.put(`/workshop/job-cards/${id}/items/${editItem.id}`, itemForm)
        : await api.post(`/workshop/job-cards/${id}/items`, itemForm);
      setCard(data.job_card);
      setShowAddItem(false);
      setEditItem(null);
      setItemForm(EMPTY_ITEM);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not save item');
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (itemId) => {
    try {
      setBusy(true);
      const { data } = await api.delete(`/workshop/job-cards/${id}/items/${itemId}`);
      setCard(data.job_card);
      setConfirmDeleteItem(null);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not delete item');
    } finally {
      setBusy(false);
    }
  };

  const openEditItem = (item) => {
    setEditItem(item);
    setItemForm({ item_type: item.item_type, description: item.description, quantity: String(item.quantity), unit_cost: String(item.unit_cost) });
    setShowAddItem(true);
  };

  const updateTechnician = async (techId) => {
    try {
      await api.put(`/workshop/job-cards/${id}`, { technician_id: techId || null });
      await load();
    } catch {
      toast.error('Could not update technician');
    }
  };

  const saveAsTemplate = async () => {
    if (!templateName.trim()) return;
    try {
      setSavingTemplate(true);
      await api.post('/workshop/templates', {
        name: templateName.trim(),
        job_type: card.job_type,
        items: card.items.map((i) => ({ item_type: i.item_type, description: i.description, quantity: i.quantity, unit_cost: i.unit_cost })),
      });
      toast.success('Template saved');
      setTemplateName('');
      const { data } = await api.get('/workshop/templates');
      setTemplates(data.templates || []);
    } catch {
      toast.error('Could not save template');
    } finally {
      setSavingTemplate(false);
    }
  };

  const applyTemplate = async (templateId) => {
    try {
      setApplyingTemplate(templateId);
      const { data } = await api.post(`/workshop/job-cards/${id}/apply-template/${templateId}`);
      setCard(data.job_card);
      toast.success('Template applied');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not apply template');
    } finally {
      setApplyingTemplate(null);
    }
  };

  const deleteTemplate = async (templateId) => {
    try {
      await api.delete(`/workshop/templates/${templateId}`);
      setTemplates((ts) => ts.filter((t) => t.id !== templateId));
      toast.success('Template deleted');
    } catch {
      toast.error('Could not delete template');
    }
  };

  const printJob = () => {
    const w = window.open('', '_blank', 'width=860,height=700');
    if (!w) { toast.error('Pop-up blocked — allow pop-ups and try again'); return; }
    w.document.write(buildPrintHTML(card, bikeReg, bikeMake, bikeModel));
    w.document.close();
  };

  const elapsedTime = useMemo(() => card?.status === 'in_progress' ? elapsed(card.started_at) : null, [card]);

  if (!card) return <Loading />;

  const isOpen = ['open', 'in_progress'].includes(card.status);
  const bikeReg = card.bike_registration || card.registration;
  const bikeMake = card.bike_make || card.make;
  const bikeModel = card.bike_model || card.model;
  const hasBike = !!card.bike_id;

  return (
    <>
      <button className="btn btn-sm btn-secondary" style={{ marginBottom: 16 }} onClick={() => nav('/workshop/app/job-cards')}>
        <ArrowLeft size={14} /> Back
      </button>

      {/* Header */}
      <div className="flex-between mb-3" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
            <h1 className="page-title" style={{ marginBottom: 0 }}>Job #{card.id}</h1>
            <Badge status={STATUS_COLOR[card.status]}>{card.status.replace('_', ' ')}</Badge>
            {card.priority !== 'normal' && <Badge status={PRIORITY_COLOR[card.priority]}>{card.priority}</Badge>}
            {elapsedTime && (
              <span style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={12} /> {elapsedTime} elapsed
              </span>
            )}
          </div>
          <p className="page-sub">{card.job_type} · Created {fmtDateTime(card.created_at)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-secondary" onClick={printJob}>
            <Printer size={13} /> Print
          </button>
          {card.status === 'open' && (
            <button className="btn btn-sm" onClick={startJob} disabled={busy}>Start job</button>
          )}
          {isOpen && (
            <>
              <button className="btn btn-sm" onClick={() => { setCompleteForm(EMPTY_COMPLETE); setShowComplete(true); }} disabled={busy}>
                Mark complete
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => setConfirmCancel(true)} disabled={busy}>Cancel</button>
            </>
          )}
        </div>
      </div>

      {/* Two-column info grid */}
      <div className="grid grid-2" style={{ gap: 16, marginBottom: 20 }}>
        {/* Bike card */}
        <div className="card" style={{ padding: 16 }}>
          <div className="text-xs muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Bike</div>
          <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 2 }}>{bikeReg || '—'}</div>
          <div className="text-sm" style={{ marginBottom: 6 }}>{bikeMake} {bikeModel}{(card.bike_year || card.year) ? ` · ${card.bike_year || card.year}` : ''}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(card.bike_vin || card.vin) && <span className="text-xs muted">VIN: {card.bike_vin || card.vin}</span>}
            {(card.bike_color || card.color) && <span className="text-xs muted">{card.bike_color || card.color}</span>}
            {(card.bike_engine_cc || card.engine_cc) && <span className="text-xs muted">{card.bike_engine_cc || card.engine_cc}cc</span>}
          </div>
          {(card.bike_org_name || card.fleet_org_name) && (
            <div className="text-xs muted" style={{ marginTop: 8 }}>Fleet: {card.bike_org_name || card.fleet_org_name}</div>
          )}
          {card.fleet_owner_name && !card.bike_org_name && (
            <div className="text-xs muted">Owner: {card.fleet_owner_name}</div>
          )}
          {hasBike && (
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {card.bike_odometer_km != null && <div><div className="text-xs muted">Odometer</div><div className="text-sm">{card.bike_odometer_km.toLocaleString()} km</div></div>}
              {card.bike_next_service_date && <div><div className="text-xs muted">Next service</div><div className="text-sm">{fmtDate(card.bike_next_service_date)}</div></div>}
              {card.bike_next_service_km && <div><div className="text-xs muted">Service km</div><div className="text-sm">{card.bike_next_service_km.toLocaleString()}</div></div>}
            </div>
          )}
        </div>

        {/* Job details card */}
        <div className="card" style={{ padding: 16 }}>
          <div className="text-xs muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Details</div>
          <div className="grid grid-2" style={{ gap: 10 }}>
            <div><div className="text-xs muted">Type</div><div className="text-sm">{card.job_type}</div></div>
            <div><div className="text-xs muted">Priority</div><div className="text-sm">{card.priority}</div></div>
            <div>
              <div className="text-xs muted">Assigned to</div>
              {isOpen ? (
                <select className="text-sm" value={card.technician_id || ''} onChange={(e) => updateTechnician(e.target.value)} style={{ fontSize: 13, padding: '2px 4px', marginTop: 2 }}>
                  <option value="">Unassigned</option>
                  {technicians.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                </select>
              ) : (
                <div className="text-sm">{card.technician_name || '—'}</div>
              )}
            </div>
            <div><div className="text-xs muted">Created by</div><div className="text-sm">{card.created_by_name || '—'}</div></div>
            {card.started_at && <div><div className="text-xs muted">Started</div><div className="text-sm">{fmtDateTime(card.started_at)}</div></div>}
            {card.completed_at && <div><div className="text-xs muted">Completed</div><div className="text-sm">{fmtDateTime(card.completed_at)}</div></div>}
          </div>
          {card.description && (
            <div style={{ marginTop: 10 }}>
              <div className="text-xs muted">Description</div>
              <div className="text-sm" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{card.description}</div>
            </div>
          )}
          {card.completion_notes && (
            <div style={{ marginTop: 10 }}>
              <div className="text-xs muted">Completion notes</div>
              <div className="text-sm" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{card.completion_notes}</div>
            </div>
          )}
        </div>
      </div>

      {/* Line items */}
      <div className="flex-between mb-2" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>Line Items</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Total: {fmt(card.total_cost)}</span>
          {isOpen && (
            <button className="btn btn-sm" onClick={() => { setEditItem(null); setItemForm(EMPTY_ITEM); setShowAddItem(true); }}>
              <Plus size={13} /> Add item
            </button>
          )}
        </div>
      </div>

      <div className="card table-wrap" style={{ padding: 0, marginBottom: 20 }}>
        <table className="table">
          <thead>
            <tr>
              <th className="col-mobile-hide">Type</th>
              <th>Description</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }} className="col-mobile-hide">Unit</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              {isOpen && <th style={{ width: 72 }}></th>}
            </tr>
          </thead>
          <tbody>
            {card.items.map((item) => (
              <tr key={item.id}>
                <td className="col-mobile-hide"><Badge>{item.item_type}</Badge></td>
                <td>
                  {item.description}
                  <div className="mobile-only text-xs muted" style={{ marginTop: 2 }}>{item.item_type}</div>
                </td>
                <td style={{ textAlign: 'right' }}>{item.quantity}</td>
                <td style={{ textAlign: 'right' }} className="col-mobile-hide">{fmt(item.unit_cost)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(item.quantity * item.unit_cost)}</td>
                {isOpen && (
                  <td>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => openEditItem(item)}><Pencil size={12} /></button>
                      <button className="btn btn-sm btn-danger" onClick={() => setConfirmDeleteItem(item)}><Trash2 size={12} /></button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!card.items.length && (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <p className="muted">No line items yet.</p>
            {isOpen && <button className="btn" style={{ marginTop: 10 }} onClick={() => { setEditItem(null); setItemForm(EMPTY_ITEM); setShowAddItem(true); }}>Add first item</button>}
          </div>
        )}
      </div>

      {/* Templates panel */}
      <div className="card" style={{ padding: 0, marginBottom: 20 }}>
        <button
          style={{ width: '100%', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)', fontWeight: 600, fontSize: 14 }}
          onClick={() => setTemplatesOpen((v) => !v)}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={15} />
            Templates
            {templates.length > 0 && <span className="text-xs muted" style={{ fontWeight: 400 }}>({templates.length} saved)</span>}
          </span>
          {templatesOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {templatesOpen && (
          <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
            {templates.length > 0 && (
              <div style={{ marginBottom: card.items.length > 0 ? 20 : 0 }}>
                <div className="text-xs muted" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Apply a saved template</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {templates.map((t) => {
                    let itemCount = 0;
                    try { itemCount = JSON.parse(t.items || '[]').length; } catch { itemCount = 0; }
                    return (
                      <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--surface, rgba(0,0,0,0.03))', borderRadius: 6 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</span>
                          <span className="text-xs muted" style={{ marginLeft: 8 }}>{t.job_type} · {itemCount} item{itemCount !== 1 ? 's' : ''}</span>
                        </div>
                        {isOpen && (
                          <button className="btn btn-sm btn-secondary" disabled={applyingTemplate === t.id} onClick={() => applyTemplate(t.id)}>
                            {applyingTemplate === t.id ? '…' : 'Apply'}
                          </button>
                        )}
                        <button className="btn btn-sm btn-danger" onClick={() => deleteTemplate(t.id)} title="Delete template">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {card.items.length > 0 && (
              <div>
                <div className="text-xs muted" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Save current items as template</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="Template name (e.g. 6-month service)"
                    style={{ flex: 1 }}
                    onKeyDown={(e) => e.key === 'Enter' && saveAsTemplate()}
                  />
                  <button className="btn btn-sm" disabled={savingTemplate || !templateName.trim()} onClick={saveAsTemplate}>
                    {savingTemplate ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}
            {templates.length === 0 && card.items.length === 0 && (
              <p className="muted text-sm">Add line items to this job to save them as a reusable template.</p>
            )}
          </div>
        )}
      </div>

      {/* Bike service history */}
      {hasBike && (
        <div className="card" style={{ padding: 0, marginBottom: 24 }}>
          <button
            style={{ width: '100%', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)', fontWeight: 600, fontSize: 14 }}
            onClick={toggleHistory}
          >
            <span>Bike Service History</span>
            {historyOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {historyOpen && (
            <div>
              <div style={{ height: 1, background: 'var(--border)' }} />
              {history === null ? (
                <div style={{ padding: 20, textAlign: 'center' }} className="muted text-sm">Loading…</div>
              ) : history.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center' }} className="muted text-sm">No previous service records for this bike.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Description</th>
                        <th style={{ textAlign: 'right' }}>Cost</th>
                        <th>Odometer</th>
                        <th>Performed by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((r) => (
                        <tr key={r.id} style={r.job_card_id === Number(id) ? { background: 'rgba(99,102,241,0.06)' } : {}}>
                          <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.service_date)}</td>
                          <td><Badge>{r.service_type}</Badge></td>
                          <td className="text-xs">{r.description || '—'}</td>
                          <td style={{ textAlign: 'right' }}>{r.cost ? fmt(r.cost) : '—'}</td>
                          <td className="text-xs muted">{r.odometer_km ? `${r.odometer_km.toLocaleString()} km` : '—'}</td>
                          <td className="text-xs muted">{r.performed_by || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add/Edit item modal */}
      {showAddItem && (
        <Modal title={editItem ? 'Edit line item' : 'Add line item'} onClose={() => { setShowAddItem(false); setEditItem(null); setItemForm(EMPTY_ITEM); }}>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label className="label">Type</label>
              <select value={itemForm.item_type} onChange={(e) => setItemForm((f) => ({ ...f, item_type: e.target.value }))}>
                {ITEM_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Quantity</label>
              <input type="number" min="0.01" step="0.01" value={itemForm.quantity} onChange={(e) => setItemForm((f) => ({ ...f, quantity: e.target.value }))} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div className="text-xs muted" style={{ marginBottom: 6 }}>Quick add</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {QUICK_ITEMS.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setItemForm((f) => ({ ...f, item_type: q.item_type, description: q.description, unit_cost: q.unit_cost, quantity: q.quantity }))}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="label">Description <span style={{ color: 'var(--danger)' }}>*</span></label>
            <div style={{ position: 'relative' }}>
              <input
                value={itemForm.description}
                onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="e.g. Oil filter, Labour – brake pad replacement"
                autoComplete="off"
              />
              <PartsSuggestions
                query={itemForm.description}
                onSelect={(s) => setItemForm((f) => ({ ...f, description: s.description, item_type: s.item_type, unit_cost: String(s.avg_unit_cost || '') }))}
              />
            </div>
          </div>
          <div className="field">
            <label className="label">Unit cost (R)</label>
            <input type="number" min="0" step="0.01" value={itemForm.unit_cost} onChange={(e) => setItemForm((f) => ({ ...f, unit_cost: e.target.value }))} placeholder="0.00" />
          </div>
          {itemForm.description && itemForm.quantity && (
            <div className="text-sm muted" style={{ marginBottom: 8 }}>
              Line total: <strong>{fmt(Number(itemForm.quantity || 0) * Number(itemForm.unit_cost || 0))}</strong>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => { setShowAddItem(false); setEditItem(null); setItemForm(EMPTY_ITEM); }}>Cancel</button>
            <button className="btn" onClick={saveItem} disabled={busy || !itemForm.description}>{busy ? 'Saving…' : editItem ? 'Save changes' : 'Add item'}</button>
          </div>
        </Modal>
      )}

      {/* Complete job modal */}
      {showComplete && (
        <Modal title="Complete job" onClose={() => setShowComplete(false)}>
          <p className="muted text-sm" style={{ marginBottom: 16 }}>
            Total: <strong>{fmt(card.total_cost)}</strong>{hasBike ? ' · Service record will be logged to this bike.' : ''}
          </p>
          <div className="field">
            <label className="label">Completion notes</label>
            <textarea rows={3} value={completeForm.completion_notes} onChange={(e) => setCompleteForm((f) => ({ ...f, completion_notes: e.target.value }))} placeholder="What was done, parts installed, observations…" />
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label className="label">Odometer reading (km)</label>
              <input type="number" value={completeForm.odometer_km} onChange={(e) => setCompleteForm((f) => ({ ...f, odometer_km: e.target.value }))} placeholder="Current km" />
            </div>
            <div className="field">
              <label className="label">Next service date</label>
              <input type="date" value={completeForm.next_service_date} onChange={(e) => setCompleteForm((f) => ({ ...f, next_service_date: e.target.value }))} />
            </div>
            <div className="field">
              <label className="label">Next service at (km)</label>
              <input type="number" value={completeForm.next_service_km} onChange={(e) => setCompleteForm((f) => ({ ...f, next_service_km: e.target.value }))} placeholder="e.g. 15000" />
            </div>
            {hasBike && (
              <div className="field">
                <label className="label">Bike status after</label>
                <select value={completeForm.bike_status_after} onChange={(e) => setCompleteForm((f) => ({ ...f, bike_status_after: e.target.value }))}>
                  {BIKE_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => setShowComplete(false)}>Cancel</button>
            <button className="btn" onClick={completeJob} disabled={busy}>{busy ? 'Completing…' : 'Complete job'}</button>
          </div>
        </Modal>
      )}

      {confirmCancel && (
        <ConfirmModal
          title="Cancel job card"
          body="Cancel this job? The job will be marked cancelled. This cannot be undone."
          confirmLabel="Cancel job"
          danger
          busy={busy}
          onConfirm={cancelJob}
          onClose={() => setConfirmCancel(false)}
        />
      )}

      {confirmDeleteItem && (
        <ConfirmModal
          title="Remove line item"
          body={`Remove "${confirmDeleteItem.description}" from this job?`}
          confirmLabel="Remove"
          danger
          busy={busy}
          onConfirm={() => deleteItem(confirmDeleteItem.id)}
          onClose={() => setConfirmDeleteItem(null)}
        />
      )}
    </>
  );
}

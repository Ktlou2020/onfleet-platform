import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Plus, Pencil, Trash2, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../api';
import { Badge, ConfirmModal, Loading, Modal, fmt, fmtDate, fmtDateTime } from '../../components/ui';

const STATUS_COLOR = { open: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };
const PRIORITY_COLOR = { urgent: 'danger', high: 'warning', normal: 'info', low: '' };
const ITEM_TYPES = ['labor', 'part', 'consumable', 'other'];
// Must match bikes.status CHECK constraint
const BIKE_STATUSES = ['active', 'ready_to_go', 'repairs', 'not_available', 'stationary'];

const EMPTY_ITEM = { item_type: 'labor', description: '', quantity: '1', unit_cost: '' };
const EMPTY_COMPLETE = { completion_notes: '', odometer_km: '', next_service_date: '', next_service_km: '', bike_status_after: 'active' };

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

export default function WorkshopJobCard() {
  const { id } = useParams();
  const nav = useNavigate();
  const [card, setCard] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [history, setHistory] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [showAddItem, setShowAddItem] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showComplete, setShowComplete] = useState(false);
  const [completeForm, setCompleteForm] = useState(EMPTY_COMPLETE);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [cardRes, techRes] = await Promise.all([
      api.get(`/workshop/job-cards/${id}`),
      api.get('/workshop/technicians')
    ]);
    setCard(cardRes.data.job_card);
    setTechnicians(techRes.data.technicians);
  };

  useEffect(() => { load().catch(() => toast.error('Could not load job card')); }, [id]);

  const loadHistory = async () => {
    if (history) return; // already loaded
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
      setHistory(null); // refresh history on next open
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
        {isOpen && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {card.status === 'open' && (
              <button className="btn btn-sm" onClick={startJob} disabled={busy}>Start job</button>
            )}
            <button className="btn btn-sm" onClick={() => { setCompleteForm(EMPTY_COMPLETE); setShowComplete(true); }} disabled={busy}>
              Mark complete
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => setConfirmCancel(true)} disabled={busy}>Cancel</button>
          </div>
        )}
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
              <th>Type</th>
              <th>Description</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Unit</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              {isOpen && <th style={{ width: 72 }}></th>}
            </tr>
          </thead>
          <tbody>
            {card.items.map((item) => (
              <tr key={item.id}>
                <td><Badge>{item.item_type}</Badge></td>
                <td>{item.description}</td>
                <td style={{ textAlign: 'right' }}>{item.quantity}</td>
                <td style={{ textAlign: 'right' }}>{fmt(item.unit_cost)}</td>
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

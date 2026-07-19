import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Plus, Pencil, Trash2 } from 'lucide-react';
import api from '../../api';
import { Badge, ConfirmModal, Loading, Modal, fmt, fmtDate, fmtDateTime } from '../../components/ui';

const STATUS_COLOR = { open: 'info', in_progress: 'warning', completed: 'success', cancelled: '' };
const PRIORITY_COLOR = { urgent: 'danger', high: 'warning', normal: 'info', low: '' };
const ITEM_TYPES = ['labor', 'part', 'consumable', 'other'];
const BIKE_STATUSES = ['available', 'in_use', 'maintenance', 'not_available'];

const EMPTY_ITEM = { item_type: 'labor', description: '', quantity: '1', unit_cost: '' };
const EMPTY_COMPLETE = { completion_notes: '', odometer_km: '', next_service_date: '', next_service_km: '', bike_status_after: 'available' };

export default function WorkshopJobCard() {
  const { id } = useParams();
  const nav = useNavigate();
  const [card, setCard] = useState(null);
  const [technicians, setTechnicians] = useState([]);

  const [showAddItem, setShowAddItem] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM);
  const [confirmCancelItem, setConfirmCancelItem] = useState(null);
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
      toast.success('Job completed and service record saved');
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
      let data;
      if (editItem) {
        ({ data } = await api.put(`/workshop/job-cards/${id}/items/${editItem.id}`, itemForm));
      } else {
        ({ data } = await api.post(`/workshop/job-cards/${id}/items`, itemForm));
      }
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
      setConfirmCancelItem(null);
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
    } catch (error) {
      toast.error('Could not update technician');
    }
  };

  if (!card) return <Loading />;

  const isOpen = ['open', 'in_progress'].includes(card.status);
  const bikeReg = card.bike_registration || card.registration;
  const bikeMake = card.bike_make || card.make;
  const bikeModel = card.bike_model || card.model;

  return (
    <>
      <button className="btn btn-sm btn-secondary" style={{ marginBottom: 16 }} onClick={() => nav('/workshop/app/job-cards')}>
        <ArrowLeft size={14} /> Back to Job Cards
      </button>

      <div className="flex-between mb-3" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="flex-between" style={{ gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title" style={{ marginBottom: 4 }}>Job #{card.id}</h1>
            <Badge status={STATUS_COLOR[card.status]}>{card.status.replace('_', ' ')}</Badge>
            {card.priority !== 'normal' && <Badge status={PRIORITY_COLOR[card.priority]}>{card.priority}</Badge>}
          </div>
          <p className="page-sub">{card.job_type} · Created {fmtDateTime(card.created_at)}</p>
        </div>
        {isOpen && (
          <div className="row" style={{ gap: 8 }}>
            {card.status === 'open' && (
              <button className="btn btn-sm" onClick={startJob} disabled={busy}>Start job</button>
            )}
            <button className="btn btn-sm" onClick={() => { setCompleteForm(EMPTY_COMPLETE); setShowComplete(true); }} disabled={busy}>Mark complete</button>
            <button className="btn btn-sm btn-danger" onClick={() => setConfirmCancel(true)} disabled={busy}>Cancel job</button>
          </div>
        )}
      </div>

      <div className="grid grid-2" style={{ gap: 16, marginBottom: 24 }}>
        {/* Bike info */}
        <div className="card" style={{ padding: 16 }}>
          <div className="text-xs muted" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Bike</div>
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4 }}>{bikeReg || '—'}</div>
          <div className="text-sm">{bikeMake} {bikeModel}{card.bike_year || card.year ? ` · ${card.bike_year || card.year}` : ''}</div>
          {card.bike_vin || card.vin ? <div className="text-xs muted">VIN: {card.bike_vin || card.vin}</div> : null}
          {card.bike_color || card.color ? <div className="text-xs muted">Color: {card.bike_color || card.color}</div> : null}
          {(card.bike_engine_cc || card.engine_cc) ? <div className="text-xs muted">{card.bike_engine_cc || card.engine_cc}cc</div> : null}
          {card.bike_org_name ? <div className="text-xs muted" style={{ marginTop: 6 }}>Fleet: {card.bike_org_name}</div> : null}
          {card.fleet_org_name && !card.bike_org_name ? <div className="text-xs muted" style={{ marginTop: 6 }}>Fleet: {card.fleet_org_name}</div> : null}
          {card.fleet_owner_name ? <div className="text-xs muted">Owner: {card.fleet_owner_name}</div> : null}
          {card.bike_id && (
            <div style={{ marginTop: 8 }}>
              {card.bike_odometer_km ? <div className="text-xs">Odometer: {card.bike_odometer_km.toLocaleString()} km</div> : null}
              {card.bike_next_service_date ? <div className="text-xs">Next service: {fmtDate(card.bike_next_service_date)}</div> : null}
              {card.bike_next_service_km ? <div className="text-xs">Next service km: {card.bike_next_service_km.toLocaleString()}</div> : null}
            </div>
          )}
        </div>

        {/* Job info */}
        <div className="card" style={{ padding: 16 }}>
          <div className="text-xs muted" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Job Details</div>
          <div className="grid grid-2" style={{ gap: 8 }}>
            <div>
              <div className="text-xs muted">Type</div>
              <div className="text-sm">{card.job_type}</div>
            </div>
            <div>
              <div className="text-xs muted">Priority</div>
              <div className="text-sm">{card.priority}</div>
            </div>
            <div>
              <div className="text-xs muted">Assigned to</div>
              {isOpen ? (
                <select className="text-sm" value={card.technician_id || ''} onChange={(e) => updateTechnician(e.target.value)} style={{ fontSize: 13, padding: '2px 4px' }}>
                  <option value="">Unassigned</option>
                  {technicians.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                </select>
              ) : (
                <div className="text-sm">{card.technician_name || '—'}</div>
              )}
            </div>
            <div>
              <div className="text-xs muted">Created by</div>
              <div className="text-sm">{card.created_by_name || '—'}</div>
            </div>
            {card.started_at ? (
              <div>
                <div className="text-xs muted">Started</div>
                <div className="text-sm">{fmtDateTime(card.started_at)}</div>
              </div>
            ) : null}
            {card.completed_at ? (
              <div>
                <div className="text-xs muted">Completed</div>
                <div className="text-sm">{fmtDateTime(card.completed_at)}</div>
              </div>
            ) : null}
          </div>
          {card.description ? (
            <div style={{ marginTop: 12 }}>
              <div className="text-xs muted">Description</div>
              <div className="text-sm" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{card.description}</div>
            </div>
          ) : null}
          {card.completion_notes ? (
            <div style={{ marginTop: 12 }}>
              <div className="text-xs muted">Completion notes</div>
              <div className="text-sm" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{card.completion_notes}</div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Line items */}
      <div className="flex-between mb-2">
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Line Items</h2>
        <div className="flex-between" style={{ gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Total: {fmt(card.total_cost)}</span>
          {isOpen && (
            <button className="btn btn-sm" onClick={() => { setEditItem(null); setItemForm(EMPTY_ITEM); setShowAddItem(true); }}>
              <Plus size={14} /> Add item
            </button>
          )}
        </div>
      </div>

      <div className="card table-wrap" style={{ padding: 0, marginBottom: 24 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Description</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Unit cost</th>
              <th style={{ textAlign: 'right' }}>Line total</th>
              {isOpen ? <th style={{ width: 80 }}></th> : null}
            </tr>
          </thead>
          <tbody>
            {card.items.map((item) => (
              <tr key={item.id}>
                <td><Badge>{item.item_type}</Badge></td>
                <td>{item.description}</td>
                <td style={{ textAlign: 'right' }}>{item.quantity}</td>
                <td style={{ textAlign: 'right' }}>{fmt(item.unit_cost)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(item.quantity * item.unit_cost)}</td>
                {isOpen ? (
                  <td>
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => openEditItem(item)} title="Edit"><Pencil size={13} /></button>
                      <button className="btn btn-sm btn-danger" onClick={() => setConfirmCancelItem(item)} title="Delete"><Trash2 size={13} /></button>
                    </div>
                  </td>
                ) : null}
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
              <input type="number" min="1" step="0.01" value={itemForm.quantity} onChange={(e) => setItemForm((f) => ({ ...f, quantity: e.target.value }))} />
            </div>
          </div>
          <div className="field">
            <label className="label">Description <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input value={itemForm.description} onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))} placeholder="e.g. Oil filter, Labour – brake pad replacement" />
          </div>
          <div className="field">
            <label className="label">Unit cost (R)</label>
            <input type="number" min="0" step="0.01" value={itemForm.unit_cost} onChange={(e) => setItemForm((f) => ({ ...f, unit_cost: e.target.value }))} placeholder="0.00" />
          </div>
          {itemForm.description && itemForm.quantity && (
            <div className="text-sm muted" style={{ marginBottom: 8 }}>
              Line total: {fmt(Number(itemForm.quantity || 0) * Number(itemForm.unit_cost || 0))}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => { setShowAddItem(false); setEditItem(null); setItemForm(EMPTY_ITEM); }}>Cancel</button>
            <button className="btn" onClick={saveItem} disabled={busy || !itemForm.description}>{busy ? 'Saving…' : editItem ? 'Save changes' : 'Add item'}</button>
          </div>
        </Modal>
      )}

      {/* Complete modal */}
      {showComplete && (
        <Modal title="Complete job" onClose={() => setShowComplete(false)}>
          <p className="muted text-sm" style={{ marginBottom: 16 }}>
            Completing this job will log a service record{card.bike_id ? ' and update the bike' : ''}. Total cost: <strong>{fmt(card.total_cost)}</strong>
          </p>
          <div className="field">
            <label className="label">Completion notes</label>
            <textarea rows={3} value={completeForm.completion_notes} onChange={(e) => setCompleteForm((f) => ({ ...f, completion_notes: e.target.value }))} placeholder="What was done, parts used, observations…" />
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label className="label">Odometer (km)</label>
              <input type="number" value={completeForm.odometer_km} onChange={(e) => setCompleteForm((f) => ({ ...f, odometer_km: e.target.value }))} placeholder="Current reading" />
            </div>
            <div className="field">
              <label className="label">Next service date</label>
              <input type="date" value={completeForm.next_service_date} onChange={(e) => setCompleteForm((f) => ({ ...f, next_service_date: e.target.value }))} />
            </div>
            <div className="field">
              <label className="label">Next service km</label>
              <input type="number" value={completeForm.next_service_km} onChange={(e) => setCompleteForm((f) => ({ ...f, next_service_km: e.target.value }))} placeholder="e.g. 15000" />
            </div>
            {card.bike_id && (
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

      {/* Confirm cancel job */}
      {confirmCancel && (
        <ConfirmModal
          title="Cancel job card"
          body="Cancel this job card? This cannot be undone."
          confirmLabel="Cancel job"
          danger
          busy={busy}
          onConfirm={cancelJob}
          onClose={() => setConfirmCancel(false)}
        />
      )}

      {/* Confirm delete item */}
      {confirmCancelItem && (
        <ConfirmModal
          title="Remove line item"
          body={`Remove "${confirmCancelItem.description}" from this job?`}
          confirmLabel="Remove"
          danger
          busy={busy}
          onConfirm={() => deleteItem(confirmCancelItem.id)}
          onClose={() => setConfirmCancelItem(null)}
        />
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, SearchInput, fmtDateTime, matchesSearch } from '../../components/ui';
import { Modal } from '../../components/ui';
import { sortNewestFirst } from '../../utils/sortNewestFirst';
import { ALERT_LABELS } from '../../lib/alertMeta';
import { Plus, ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';

const CLAIM_TYPES = ['theft', 'damage', 'accident', 'fire', 'other'];
const CLAIM_STATUSES = ['filed', 'investigating', 'approved', 'rejected', 'paid', 'closed'];
const STATUS_COLORS = {
  filed: '#94a3b8', investigating: '#eab308', approved: '#22c55e',
  rejected: '#ef4444', paid: '#1E88D1', closed: 'var(--muted)',
};

function StatusBadge({ status }) {
  const color = STATUS_COLORS[status] || '#94a3b8';
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: color, padding: '2px 7px', borderRadius: 5, textTransform: 'uppercase', letterSpacing: '.3px' }}>
      {status}
    </span>
  );
}

function FileClaimModal({ isOpen, onClose, onFiled }) {
  const [bikes, setBikes] = useState([]);
  const [bikeId, setBikeId] = useState('');
  const [claimType, setClaimType] = useState('theft');
  const [description, setDescription] = useState('');
  const [incidentDate, setIncidentDate] = useState('');
  const [bikeAlerts, setBikeAlerts] = useState([]);
  const [selectedAlertIds, setSelectedAlertIds] = useState(new Set());
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    api.get('/bikes').then((r) => setBikes(r.data.bikes || [])).catch(() => {});
    setBikeId(''); setClaimType('theft'); setDescription(''); setIncidentDate('');
    setBikeAlerts([]); setSelectedAlertIds(new Set());
  }, [isOpen]);

  useEffect(() => {
    if (!bikeId) { setBikeAlerts([]); return; }
    setLoadingAlerts(true);
    api.get(`/tracking/alerts?bike_id=${bikeId}&limit=30`)
      .then((r) => setBikeAlerts(r.data || []))
      .catch(() => setBikeAlerts([]))
      .finally(() => setLoadingAlerts(false));
  }, [bikeId]);

  const toggleAlert = (id) => setSelectedAlertIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const submit = async () => {
    if (!bikeId || !description.trim()) return toast.error('Bike and description are required');
    setSaving(true);
    try {
      const { data } = await api.post('/claims', {
        bike_id: Number(bikeId),
        claim_type: claimType,
        description: description.trim(),
        incident_date: incidentDate || null,
        linked_alert_ids: [...selectedAlertIds],
      });
      toast.success('Claim filed');
      onFiled(data.claim);
      onClose();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to file claim');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="File insurance claim">
      <div style={{ minWidth: 420, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label className="label" style={{ fontSize: 12 }}>Bike</label>
          <select className="input" value={bikeId} onChange={(e) => setBikeId(e.target.value)}>
            <option value="">Select a bike…</option>
            {bikes.map((b) => (
              <option key={b.id} value={b.id}>{b.registration || b.vin} — {b.make} {b.model}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" style={{ fontSize: 12 }}>Claim type</label>
          <select className="input" value={claimType} onChange={(e) => setClaimType(e.target.value)}>
            {CLAIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label" style={{ fontSize: 12 }}>Incident date</label>
          <input type="date" className="input" value={incidentDate} onChange={(e) => setIncidentDate(e.target.value)} />
        </div>
        <div>
          <label className="label" style={{ fontSize: 12 }}>Description</label>
          <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened…" />
        </div>
        {bikeId && (
          <div>
            <label className="label" style={{ fontSize: 12 }}>Link supporting alerts (optional evidence)</label>
            {loadingAlerts ? (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading alerts…</div>
            ) : bikeAlerts.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>No alerts recorded for this bike.</div>
            ) : (
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                {bikeAlerts.map((a) => (
                  <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 2px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selectedAlertIds.has(a.id)} onChange={() => toggleAlert(a.id)} />
                    <span style={{ fontWeight: 600 }}>{ALERT_LABELS[a.alert_type] || a.alert_type}</span>
                    <span style={{ color: 'var(--muted)' }}>{fmtDateTime(a.created_at)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <button className="btn btn-primary" disabled={saving} onClick={submit} style={{ marginTop: 4 }}>
          {saving ? 'Filing…' : 'File claim'}
        </button>
      </div>
    </Modal>
  );
}

function ClaimRow({ claim, onUpdated }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState(claim.status);
  const [payout, setPayout] = useState(claim.payout_amount || '');
  const [notes, setNotes] = useState(claim.notes || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put(`/claims/${claim.id}`, {
        status, payout_amount: payout === '' ? null : Number(payout), notes,
      });
      onUpdated(data.claim);
      toast.success('Claim updated');
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to update claim');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 8, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => setExpanded((e) => !e)}>
        <ShieldAlert size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{claim.bike_registration || `Bike #${claim.bike_id}`}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'capitalize' }}>{claim.claim_type}</span>
            <StatusBadge status={claim.status} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{claim.description}</div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{fmtDateTime(claim.filed_at)}</div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {claim.incident_date && <div style={{ fontSize: 12 }}><strong>Incident date:</strong> {claim.incident_date}</div>}
          {claim.filed_by_name && <div style={{ fontSize: 12 }}><strong>Filed by:</strong> {claim.filed_by_name}</div>}
          {claim.alerts?.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>Linked alert evidence</div>
              {claim.alerts.map((a) => (
                <div key={a.id} style={{ fontSize: 12, padding: '4px 0' }}>
                  {ALERT_LABELS[a.alert_type] || a.alert_type} — {fmtDateTime(a.created_at)}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label className="label" style={{ fontSize: 11 }}>Status</label>
              <select className="input" style={{ fontSize: 12 }} value={status} onChange={(e) => setStatus(e.target.value)}>
                {CLAIM_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label" style={{ fontSize: 11 }}>Payout amount (R)</label>
              <input className="input" style={{ fontSize: 12, width: 120 }} type="number" value={payout} onChange={(e) => setPayout(e.target.value)} />
            </div>
            <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
          <div>
            <label className="label" style={{ fontSize: 11 }}>Notes</label>
            <textarea className="input" style={{ fontSize: 12 }} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminClaims() {
  const [claims, setClaims] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showFile, setShowFile] = useState(false);

  const load = () => api.get('/claims', { params: statusFilter ? { status: statusFilter } : {} }).then((r) => setClaims(r.data.claims));
  useEffect(() => { load(); }, [statusFilter]);

  const filtered = useMemo(() => sortNewestFirst((claims || []).filter((c) =>
    matchesSearch(search, c.bike_registration, c.claim_type, c.description, c.status)
  ), ['filed_at', 'id']), [claims, search]);

  if (!claims) return <Loading />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Insurance Claims</h1>
        <button className="btn btn-primary" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => setShowFile(true)}>
          <Plus size={14} /> File claim
        </button>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search claims…" />
        <select className="input" style={{ width: 160 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {CLAIM_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {filtered.length === 0 ? (
        <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>No claims filed yet.</div>
      ) : filtered.map((c) => (
        <ClaimRow key={c.id} claim={c} onUpdated={(updated) => setClaims((prev) => prev.map((p) => p.id === updated.id ? { ...p, ...updated } : p))} />
      ))}
      <FileClaimModal isOpen={showFile} onClose={() => setShowFile(false)} onFiled={(claim) => setClaims((prev) => [claim, ...(prev || [])])} />
    </div>
  );
}

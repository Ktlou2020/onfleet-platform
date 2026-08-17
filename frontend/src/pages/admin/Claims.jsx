import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Loading, SearchInput, fmtDateTime, matchesSearch } from '../../components/ui';
import { Modal } from '../../components/ui';
import { sortNewestFirst } from '../../utils/sortNewestFirst';
import { ALERT_LABELS } from '../../lib/alertMeta';
import { Plus, ShieldAlert, ChevronDown, ChevronUp, Search, Sparkles, Camera, X, MapPin } from 'lucide-react';

const CLAIM_TYPES = ['theft', 'damage', 'accident', 'fire', 'other'];
const CLAIM_STATUSES = ['filed', 'investigating', 'approved', 'rejected', 'paid', 'closed'];
const STATUS_COLORS = {
  filed: '#94a3b8', investigating: '#eab308', approved: '#22c55e',
  rejected: '#ef4444', paid: '#1E88D1', closed: 'var(--muted)',
};
const RISK_COLORS = { low: '#22c55e', medium: '#eab308', high: '#ef4444' };

function StatusBadge({ status }) {
  const color = STATUS_COLORS[status] || '#94a3b8';
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: color, padding: '2px 7px', borderRadius: 5, textTransform: 'uppercase', letterSpacing: '.3px' }}>
      {status}
    </span>
  );
}

function RiskBadge({ level }) {
  if (!level) return null;
  const color = RISK_COLORS[level] || '#94a3b8';
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: color, padding: '2px 7px', borderRadius: 5, textTransform: 'uppercase', letterSpacing: '.3px' }}>
      {level} risk
    </span>
  );
}

function bikeLabel(b) {
  return `${b.registration || b.vin} — ${b.make} ${b.model}`;
}

function BikeSearchSelect({ bikes, value, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = bikes.find((b) => String(b.id) === String(value));

  const results = query.trim()
    ? bikes.filter((b) => matchesSearch(query, b.registration, b.vin, b.make, b.model))
    : bikes;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
        <input
          className="input"
          style={{ paddingLeft: 30 }}
          placeholder="Search by plate, VIN, make or model…"
          value={open ? query : (selected ? bikeLabel(selected) : '')}
          onFocus={() => { setQuery(''); setOpen(true); }}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </div>
      {open && (
        <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 2, maxHeight: 220, overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.3)' }}>
          {results.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--muted)' }}>No bikes match "{query}"</div>
          ) : results.map((b) => (
            <div
              key={b.id}
              onMouseDown={() => { onChange(String(b.id)); setOpen(false); }}
              style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', background: String(b.id) === String(value) ? 'var(--surface-2)' : undefined }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = String(b.id) === String(value) ? 'var(--surface-2)' : 'transparent'; }}
            >
              {bikeLabel(b)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FileClaimModal({ isOpen, onClose, onFiled }) {
  const [bikes, setBikes] = useState([]);
  const [bikeId, setBikeId] = useState('');
  const [claimType, setClaimType] = useState('theft');
  const [description, setDescription] = useState('');
  const [incidentDate, setIncidentDate] = useState('');
  const [sapsCaseNumber, setSapsCaseNumber] = useState('');
  const [sapsPoliceStation, setSapsPoliceStation] = useState('');
  const [bikeAlerts, setBikeAlerts] = useState([]);
  const [selectedAlertIds, setSelectedAlertIds] = useState(new Set());
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    api.get('/bikes').then((r) => setBikes(r.data.bikes || [])).catch(() => {});
    setBikeId(''); setClaimType('theft'); setDescription(''); setIncidentDate('');
    setSapsCaseNumber(''); setSapsPoliceStation('');
    setBikeAlerts([]); setSelectedAlertIds(new Set());
  }, [isOpen]);

  useEffect(() => {
    if (!bikeId) { setBikeAlerts([]); return; }
    setLoadingAlerts(true);
    const params = { bike_id: bikeId, limit: 100 };
    // Scoped to the day before/of/after the incident date, so evidence
    // linking isn't limited to whatever the most recent 30 alerts happen to
    // be — a bike with lots of unrelated recent alerts could otherwise push
    // the actual incident-day alerts off the list entirely.
    if (incidentDate) {
      const day = new Date(`${incidentDate}T00:00:00`);
      const from = new Date(day); from.setDate(from.getDate() - 1);
      const to = new Date(day); to.setDate(to.getDate() + 2); // exclusive upper bound
      params.from = from.toISOString();
      params.to = to.toISOString();
    }
    api.get('/tracking/alerts', { params })
      .then((r) => setBikeAlerts(r.data || []))
      .catch(() => setBikeAlerts([]))
      .finally(() => setLoadingAlerts(false));
  }, [bikeId, incidentDate]);

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
        saps_case_number: sapsCaseNumber.trim() || null,
        saps_police_station: sapsPoliceStation.trim() || null,
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
          <BikeSearchSelect bikes={bikes} value={bikeId} onChange={setBikeId} />
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
        {claimType === 'theft' && (
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ fontSize: 12 }}>SAPS case number</label>
              <input className="input" value={sapsCaseNumber} onChange={(e) => setSapsCaseNumber(e.target.value)} placeholder="e.g. CAS 123/08/2026" />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ fontSize: 12 }}>Police station</label>
              <input className="input" value={sapsPoliceStation} onChange={(e) => setSapsPoliceStation(e.target.value)} placeholder="e.g. Sandton SAPS" />
            </div>
          </div>
        )}
        {bikeId && (
          <div>
            <label className="label" style={{ fontSize: 12 }}>
              Link supporting alerts (optional evidence)
              {incidentDate && <span style={{ fontWeight: 400, color: 'var(--muted)' }}> — day before/of/after the incident date</span>}
            </label>
            {loadingAlerts ? (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading alerts…</div>
            ) : bikeAlerts.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{incidentDate ? 'No alerts around the incident date.' : 'No alerts recorded for this bike.'}</div>
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
  const [sapsCaseNumber, setSapsCaseNumber] = useState(claim.saps_case_number || '');
  const [sapsPoliceStation, setSapsPoliceStation] = useState(claim.saps_police_station || '');
  const [saving, setSaving] = useState(false);
  const [generatingAi, setGeneratingAi] = useState(false);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoCaption, setPhotoCaption] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [gpsFile, setGpsFile] = useState(null);
  const [gpsPreview, setGpsPreview] = useState(null);
  const [gpsPreviewing, setGpsPreviewing] = useState(false);
  const [gpsImporting, setGpsImporting] = useState(false);
  const [gpsResult, setGpsResult] = useState(null);

  const uploadPhoto = async () => {
    if (!photoFile) return;
    setUploadingPhoto(true);
    try {
      const form = new FormData();
      form.append('photo', photoFile);
      if (photoCaption.trim()) form.append('caption', photoCaption.trim());
      const { data } = await api.post(`/claims/${claim.id}/photos`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      onUpdated({ ...claim, photos: [...(claim.photos || []), data.photo] });
      setPhotoFile(null);
      setPhotoCaption('');
      toast.success('Photo uploaded');
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to upload photo');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const deletePhoto = async (photoId) => {
    try {
      await api.delete(`/claims/${claim.id}/photos/${photoId}`);
      onUpdated({ ...claim, photos: (claim.photos || []).filter((p) => p.id !== photoId) });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to delete photo');
    }
  };

  const previewGps = async () => {
    if (!gpsFile) return;
    setGpsPreviewing(true);
    setGpsPreview(null);
    setGpsResult(null);
    try {
      const form = new FormData();
      form.append('file', gpsFile);
      const { data } = await api.post('/tracking/gps-import/preview', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setGpsPreview(data);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to read CSV');
    } finally {
      setGpsPreviewing(false);
    }
  };

  const importGps = async () => {
    if (!gpsFile) return;
    setGpsImporting(true);
    try {
      const form = new FormData();
      form.append('file', gpsFile);
      const { data } = await api.post('/tracking/gps-import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setGpsResult(data);
      setGpsPreview(null);
      setGpsFile(null);
      toast.success(`Imported ${data.imported} GPS point${data.imported === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to import GPS data');
    } finally {
      setGpsImporting(false);
    }
  };

  const generateAiSummary = async () => {
    setGeneratingAi(true);
    try {
      const { data } = await api.post(`/claims/${claim.id}/ai-summary`);
      onUpdated(data.claim);
      toast.success('AI summary generated');
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to generate AI summary');
    } finally {
      setGeneratingAi(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put(`/claims/${claim.id}`, {
        status, payout_amount: payout === '' ? null : Number(payout), notes,
        saps_case_number: sapsCaseNumber.trim() || null,
        saps_police_station: sapsPoliceStation.trim() || null,
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
            <RiskBadge level={claim.ai_risk_level} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{claim.description}</div>
          {claim.claim_type === 'theft' && claim.saps_case_number && (
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>SAPS case {claim.saps_case_number}{claim.saps_police_station ? ` · ${claim.saps_police_station}` : ''}</div>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{fmtDateTime(claim.filed_at)}</div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {claim.incident_date && <div style={{ fontSize: 12 }}><strong>Incident date:</strong> {claim.incident_date}</div>}
          {claim.filed_by_name && <div style={{ fontSize: 12 }}><strong>Filed by:</strong> {claim.filed_by_name}</div>}
          {claim.claim_type === 'theft' && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <label className="label" style={{ fontSize: 11 }}>SAPS case number</label>
                <input className="input" style={{ fontSize: 12, width: 180 }} value={sapsCaseNumber} onChange={(e) => setSapsCaseNumber(e.target.value)} placeholder="e.g. CAS 123/08/2026" />
              </div>
              <div>
                <label className="label" style={{ fontSize: 11 }}>Police station</label>
                <input className="input" style={{ fontSize: 12, width: 180 }} value={sapsPoliceStation} onChange={(e) => setSapsPoliceStation(e.target.value)} placeholder="e.g. Sandton SAPS" />
              </div>
            </div>
          )}
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
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>Photo evidence</div>
            {claim.photos?.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {claim.photos.map((p) => (
                  <div key={p.id} style={{ position: 'relative', width: 84, height: 84 }}>
                    <a href={p.url} target="_blank" rel="noreferrer">
                      <img src={p.url} alt={p.caption || 'Evidence'} title={p.caption || ''} style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                    </a>
                    <button
                      onClick={() => deletePhoto(p.id)}
                      title="Delete photo"
                      style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#ef4444', color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="file" accept="image/*" onChange={(e) => setPhotoFile(e.target.files?.[0] || null)} style={{ fontSize: 11 }} />
              <input className="input" style={{ fontSize: 12, width: 160 }} placeholder="Caption (optional)" value={photoCaption} onChange={(e) => setPhotoCaption(e.target.value)} />
              <button className="btn btn-sm btn-secondary" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }} disabled={!photoFile || uploadingPhoto} onClick={uploadPhoto}>
                <Camera size={12} /> {uploadingPhoto ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <MapPin size={13} style={{ color: '#1E88D1', flexShrink: 0 }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Import GPS data from another platform</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="file" accept=".csv" onChange={(e) => { setGpsFile(e.target.files?.[0] || null); setGpsPreview(null); setGpsResult(null); }} style={{ fontSize: 11 }} />
              <button className="btn btn-sm btn-secondary" style={{ fontSize: 11 }} disabled={!gpsFile || gpsPreviewing} onClick={previewGps}>
                {gpsPreviewing ? 'Reading…' : 'Preview'}
              </button>
            </div>
            {gpsPreview && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                <div>{gpsPreview.usable_rows} usable point{gpsPreview.usable_rows === 1 ? '' : 's'} found ({gpsPreview.skipped_rows} row{gpsPreview.skipped_rows === 1 ? '' : 's'} skipped) out of {gpsPreview.total_rows}.</div>
                {gpsPreview.usable_rows > 0 && (
                  <button className="btn btn-sm btn-primary" style={{ marginTop: 6, fontSize: 11 }} disabled={gpsImporting} onClick={importGps}>
                    {gpsImporting ? 'Importing…' : `Import ${gpsPreview.usable_rows} point${gpsPreview.usable_rows === 1 ? '' : 's'}`}
                  </button>
                )}
              </div>
            )}
            {gpsResult && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
                Imported {gpsResult.imported}, {gpsResult.duplicate} already present, {gpsResult.unresolved_bike} had no matching bike registration.
                {gpsResult.unresolved_bike > 0 && gpsResult.errors.slice(0, 3).map((e, i) => (
                  <div key={i} style={{ color: '#ef4444', marginTop: 2 }}>Row {e.row}: {e.error}</div>
                ))}
              </div>
            )}
          </div>
          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: claim.ai_summary ? 8 : 0 }}>
              <Sparkles size={13} style={{ color: '#7c3aed', flexShrink: 0 }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>AI case analysis</span>
              <RiskBadge level={claim.ai_risk_level} />
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto', fontSize: 11 }} disabled={generatingAi} onClick={generateAiSummary}>
                {generatingAi ? 'Analyzing…' : claim.ai_summary ? 'Regenerate' : 'Generate summary'}
              </button>
            </div>
            {claim.ai_summary && (
              <>
                <div style={{ fontSize: 12, lineHeight: 1.5 }}>{claim.ai_summary}</div>
                {claim.ai_risk_reasons?.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11, color: 'var(--muted)' }}>
                    {claim.ai_risk_reasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>Generated {fmtDateTime(claim.ai_summary_generated_at)} — AI-assisted, not a substitute for human review</div>
              </>
            )}
          </div>
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

function AskAiPanel() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const ask = async () => {
    if (!question.trim() || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      const { data } = await api.post('/claims/analytics/ask', { question: question.trim() });
      setAnswer(data.answer);
    } catch (err) {
      if (err?.response?.status === 400) setNotConfigured(true);
      else toast.error(err?.response?.data?.error || 'Failed to get an answer');
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 14, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <Sparkles size={15} style={{ color: '#7c3aed', flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: 13 }}>Ask AI about claims</span>
        {open ? <ChevronUp size={14} style={{ marginLeft: 'auto' }} /> : <ChevronDown size={14} style={{ marginLeft: 'auto' }} />}
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {notConfigured ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>AI isn't configured yet — set ANTHROPIC_API_KEY to enable this.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input" style={{ flex: 1 }}
                  placeholder="e.g. how many theft claims had the tracker go offline before the incident?"
                  value={question} onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && ask()}
                />
                <button className="btn btn-primary" disabled={asking || !question.trim()} onClick={ask}>{asking ? 'Thinking…' : 'Ask'}</button>
              </div>
              {answer && (
                <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {answer}
                </div>
              )}
            </>
          )}
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
      <AskAiPanel />
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

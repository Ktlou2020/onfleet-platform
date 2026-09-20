import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import toast from 'react-hot-toast';
import { ShieldAlert, Radio, RadioTower, Phone, MapPin, Zap, ZapOff, CheckCircle, XCircle, FileText } from 'lucide-react';
import api from '../../api';
import { MAP_TILES } from '../../utils/mapTiles';
import { Loading, Modal, fmtDateTime } from '../../components/ui';

// The theft playbook. A case opens itself when a bike looks like it is being
// taken; this is where the control room works it: where the bike is now, what
// has happened since, and how it ended. Closing a case with "recovered" is
// what makes the recovery rate a real number.

const TABS = [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']];

const STATUS_STYLE = {
  open: { label: 'Open', color: '#b91c1c' },
  with_police: { label: 'With police', color: '#b45309' },
  recovered: { label: 'Recovered', color: '#15803d' },
  false_alarm: { label: 'False alarm', color: '#6b7280' },
  written_off: { label: 'Written off', color: '#1f2937' },
};

const EVENT_ICON = { opened: ShieldAlert, alert: Radio, note: FileText, status: CheckCircle, closed: CheckCircle, follow: RadioTower };

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || { label: status, color: '#6b7280' };
  return <span style={{ background: s.color, color: '#fff', borderRadius: 10, padding: '2px 9px', fontSize: 11, fontWeight: 700 }}>{s.label}</span>;
}

function CaseMap({ pings, height = 260 }) {
  const points = pings.filter((p) => p.lat && p.lng).map((p) => [p.lat, p.lng]);
  if (!points.length) return <div className="muted text-sm" style={{ padding: 16 }}>No positions since this case opened.</div>;
  return (
    <MapContainer center={points[0]} zoom={14} style={{ height, width: '100%', borderRadius: 10 }}>
      <TileLayer {...MAP_TILES.street} />
      <Polyline positions={points} color="#ef4444" weight={3} opacity={0.85} />
      <Marker position={points[0]} />
      {points.length > 1 && <CircleMarker center={points[points.length - 1]} radius={6} pathOptions={{ color: '#1E88D1' }} />}
    </MapContainer>
  );
}

export default function TheftCases() {
  const [tab, setTab] = useState('open');
  const [cases, setCases] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [closing, setClosing] = useState(null); // status being closed as
  const [closeNote, setCloseNote] = useState('');
  const [policeRef, setPoliceRef] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, s] = await Promise.all([
        api.get(`/tracking/theft-cases?status=${tab}`),
        api.get('/tracking/theft-cases/stats'),
      ]);
      setCases(list.data);
      setStats(s.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load theft cases');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const loadDetail = useCallback(async (id) => {
    try {
      const { data } = await api.get(`/tracking/theft-cases/${id}`);
      setDetail(data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not open that case');
    }
  }, []);

  useEffect(() => { if (selectedId) loadDetail(selectedId); else setDetail(null); }, [selectedId, loadDetail]);

  // Cases move fast while they're open — refresh the one on screen.
  useEffect(() => {
    if (!selectedId || detail?.case?.closed_at) return undefined;
    const t = setInterval(() => loadDetail(selectedId), 20_000);
    return () => clearInterval(t);
  }, [selectedId, detail?.case?.closed_at, loadDetail]);

  const addNote = async () => {
    if (!note.trim()) return;
    setBusy('note');
    try {
      await api.post(`/tracking/theft-cases/${selectedId}/notes`, { note: note.trim() });
      setNote('');
      loadDetail(selectedId);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not add that note');
    } finally { setBusy(''); }
  };

  const setStatus = async (status, extra = {}) => {
    setBusy(status);
    try {
      await api.put(`/tracking/theft-cases/${selectedId}/status`, { status, ...extra });
      toast.success(`Case marked ${STATUS_STYLE[status]?.label?.toLowerCase() || status}`);
      setClosing(null); setCloseNote(''); setPoliceRef('');
      await Promise.all([load(), loadDetail(selectedId)]);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not update the case');
    } finally { setBusy(''); }
  };

  const follow = async (on) => {
    setBusy('follow');
    try {
      if (on) await api.post(`/tracking/theft-cases/${selectedId}/follow`, { minutes: 60 });
      else await api.delete(`/tracking/theft-cases/${selectedId}/follow`);
      loadDetail(selectedId);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not change live follow');
    } finally { setBusy(''); }
  };

  const engine = async (cut) => {
    const device = detail?.case?.device_id;
    if (!device) return;
    const reg = detail.case.registration;
    if (!window.confirm(cut
      ? `Cut the engine on ${reg}? The bike will not restart until it is restored. Only do this when the bike is stationary or the rider is safe.`
      : `Restore the engine on ${reg}?`)) return;
    setBusy('engine');
    try {
      await api.post(`/tracking/devices/${device}/commands`, { preset: cut ? 'cut_engine' : 'restore_engine', reason: `Theft case #${selectedId}` });
      await api.post(`/tracking/theft-cases/${selectedId}/notes`, { note: cut ? 'Engine cut from the theft case' : 'Engine restored from the theft case' });
      toast.success(cut ? 'Engine cut sent' : 'Engine restore sent');
      loadDetail(selectedId);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not send that command');
    } finally { setBusy(''); }
  };

  if (loading && !cases.length) return <Loading />;

  const c = detail?.case;
  const following = c?.follow_until && new Date(c.follow_until) > new Date();

  return (
    <div>
      <h1 className="page-title">Theft cases</h1>
      <p className="page-sub">Opened automatically when a bike looks like it is being taken. Close every case with what actually happened.</p>

      {stats && (
        <div className="grid grid-4 mb-4">
          <div className="card"><div className="text-xs muted">Open now</div><div style={{ fontSize: 26, fontWeight: 700 }}>{stats.open}</div></div>
          <div className="card"><div className="text-xs muted">Recovered</div><div style={{ fontSize: 26, fontWeight: 700, color: 'var(--success)' }}>{stats.recovered}</div></div>
          <div className="card"><div className="text-xs muted">Recovery rate</div><div style={{ fontSize: 26, fontWeight: 700 }}>{stats.recovery_rate_pct == null ? '—' : `${stats.recovery_rate_pct}%`}</div><div className="text-xs muted">of genuine thefts</div></div>
          <div className="card"><div className="text-xs muted">Average time to recover</div><div style={{ fontSize: 26, fontWeight: 700 }}>{stats.avg_hours_to_recover ? `${stats.avg_hours_to_recover}h` : '—'}</div></div>
        </div>
      )}

      <div className="row mb-3" style={{ gap: 8 }}>
        {TABS.map(([id, label]) => (
          <button key={id} className={`btn btn-sm ${tab === id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setTab(id); setSelectedId(null); }}>{label}</button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selectedId ? 'minmax(260px, 1fr) minmax(320px, 2fr)' : '1fr', gap: 16 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {!cases.length && <div className="muted text-sm" style={{ padding: 20 }}>No {tab === 'all' ? '' : tab} cases. A case opens itself on a tamper, towing, movement or critical theft-risk alert.</div>}
          {cases.map((item) => (
            <button key={item.id} onClick={() => setSelectedId(item.id)}
              style={{ width: '100%', textAlign: 'left', padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                background: selectedId === item.id ? 'var(--surface-2)' : 'transparent', color: 'inherit' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{item.registration}</strong>
                <StatusPill status={item.status} />
                {item.engine_cut_active && <span title="Engine cut"><ZapOff size={13} color="#b91c1c" /></span>}
                <span className="text-xs muted" style={{ marginLeft: 'auto' }}>#{item.id}</span>
              </div>
              <div className="text-xs muted" style={{ marginTop: 3 }}>{item.opened_reason}</div>
              <div className="text-xs muted">Opened {fmtDateTime(item.opened_at)}{item.closed_at ? ` · closed ${fmtDateTime(item.closed_at)}` : ''}</div>
            </button>
          ))}
        </div>

        {c && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <h2 style={{ margin: 0, fontSize: 20 }}>{c.registration} <StatusPill status={c.status} /></h2>
                <div className="text-sm muted">{c.make} {c.bike_model}{c.vin ? ` · ${c.vin}` : ''}</div>
                <div className="text-sm muted">Opened {fmtDateTime(c.opened_at)} · {c.opened_by_name || 'automatically'}</div>
                {c.police_reference && <div className="text-sm">Police reference: <strong>{c.police_reference}</strong></div>}
              </div>
              <div className="text-sm" style={{ textAlign: 'right' }}>
                {c.rider_name && <div><Phone size={12} /> {c.rider_name} · {c.rider_phone || 'no number'}</div>}
                <div className="muted text-xs">
                  {c.imei ? <>Tracker {c.connected ? 'online' : 'offline'} · last seen {fmtDateTime(c.last_seen_at)}</> : 'No tracker on this bike'}
                </div>
                <Link className="text-xs" to={`/admin/tracking?device=${c.device_id || ''}`}><MapPin size={12} /> Open on the live map</Link>
              </div>
            </div>

            {!c.closed_at && (
              <div className="row mt-3" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-secondary" disabled={busy === 'follow' || !c.imei} onClick={() => follow(!following)}>
                  <RadioTower size={13} /> {following ? 'Stop live follow' : 'Follow live for an hour'}
                </button>
                {c.device_id && (c.engine_cut_active
                  ? <button className="btn btn-sm btn-secondary" disabled={busy === 'engine'} onClick={() => engine(false)}><Zap size={13} /> Restore engine</button>
                  : <button className="btn btn-sm btn-danger" disabled={busy === 'engine'} onClick={() => engine(true)}><ZapOff size={13} /> Cut engine</button>)}
                <button className="btn btn-sm btn-secondary" disabled={busy === 'with_police'} onClick={() => setClosing('with_police')}>Hand to police</button>
                <button className="btn btn-sm btn-primary" onClick={() => setClosing('recovered')}><CheckCircle size={13} /> Bike recovered</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setClosing('false_alarm')}><XCircle size={13} /> False alarm</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setClosing('written_off')}>Written off / not recovered</button>
              </div>
            )}
            {following && <div className="text-xs muted mt-2">Asking the tracker where it is every minute until {fmtDateTime(c.follow_until)}.</div>}

            <div className="mt-3"><CaseMap pings={detail.pings} /></div>

            {!c.closed_at && (
              <div className="row mt-3" style={{ gap: 8 }}>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add what just happened — a call, a sighting, a handover"
                  style={{ flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} />
                <button className="btn btn-sm" disabled={busy === 'note' || !note.trim()} onClick={addNote}>Add note</button>
              </div>
            )}

            <h3 style={{ fontSize: 15, marginTop: 18 }}>What happened</h3>
            <div style={{ borderLeft: '2px solid var(--border)', marginLeft: 6, paddingLeft: 14 }}>
              {[...detail.events].reverse().map((e) => {
                const Icon = EVENT_ICON[e.kind] || FileText;
                return (
                  <div key={e.id} style={{ position: 'relative', padding: '8px 0' }}>
                    <span style={{ position: 'absolute', left: -21, top: 10, background: 'var(--surface)', borderRadius: '50%', padding: 2 }}><Icon size={12} /></span>
                    <div style={{ fontSize: 13 }}>{e.summary}</div>
                    <div className="text-xs muted">{fmtDateTime(e.created_at)}{e.actor_name ? ` · ${e.actor_name}` : ''}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={!!closing} onClose={() => setClosing(null)} title={closing === 'with_police' ? 'Hand to police' : `Close case as ${STATUS_STYLE[closing]?.label?.toLowerCase() || ''}`}>
        <div style={{ minWidth: 340 }}>
          {(closing === 'with_police' || closing === 'written_off') && (
            <>
              <label className="label" style={{ fontSize: 12 }}>Police / recovery reference</label>
              <input value={policeRef} onChange={(e) => setPoliceRef(e.target.value)} placeholder="e.g. CAS 123/09/2026" style={{ width: '100%' }} />
            </>
          )}
          <label className="label" style={{ fontSize: 12, marginTop: 10 }}>Note (optional)</label>
          <textarea rows={3} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} style={{ width: '100%', resize: 'vertical' }}
            placeholder={closing === 'recovered' ? 'Where was it found, and who has it now?' : 'Anything worth knowing later'} />
          <div className="row mt-3" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-sm btn-secondary" onClick={() => setClosing(null)}>Cancel</button>
            <button className="btn btn-sm btn-primary" disabled={!!busy}
              onClick={() => setStatus(closing, { note: closeNote.trim() || null, police_reference: policeRef.trim() || null })}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

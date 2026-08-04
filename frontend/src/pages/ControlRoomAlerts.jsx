'use strict';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, BellOff, CheckCircle2, Wifi, WifiOff } from 'lucide-react';
import api from '../api';
import toast from 'react-hot-toast';
import { Modal } from '../components/ui';
import { ALERT_LABELS, ALERT_COLORS, ALERT_SEVERITY, ALERT_FILTER_GROUPS, CRITICAL_ALERT_TYPES } from '../lib/alertMeta';

const SAST = { timeZone: 'Africa/Johannesburg' };
const fmtSASTtime = (d) => d
  ? new Date(d).toLocaleString('en-ZA', { ...SAST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  : '—';

const STATUS_TABS = [
  { id: 'open',     label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all',      label: 'All' },
];

function alertMeta(a) {
  let payload = {};
  try { payload = JSON.parse(a.payload || '{}'); } catch { /* skip */ }
  const isDangerZone = payload.zone_type === 'danger';
  const severity = ALERT_SEVERITY[a.alert_type];
  const isCritical = a.alert_type === 'theft_risk' ? payload.level === 'critical' : severity === 'critical';
  const label = isDangerZone && a.alert_type === 'geofence_enter' ? 'Entered no-go zone'
    : isDangerZone && a.alert_type === 'geofence_exit' ? 'Left no-go zone'
    : ALERT_LABELS[a.alert_type] || a.alert_type;
  const color = isDangerZone && (a.alert_type === 'geofence_enter' || a.alert_type === 'geofence_exit')
    ? '#E53935' : ALERT_COLORS[a.alert_type] || '#94a3b8';
  return { payload, isDangerZone, isCritical, label, color };
}

export default function ControlRoomAlerts() {
  const [statusTab, setStatusTab] = useState('open');
  const [typeFilter, setTypeFilter] = useState('');
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(null); // alert being resolved
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sseOnline, setSseOnline] = useState(false);
  const mountedRef = useRef(true);
  const statusTabRef = useRef(statusTab);
  statusTabRef.current = statusTab;

  const loadAlerts = useCallback(async (status) => {
    setLoading(true);
    try {
      const q = status && status !== 'all' ? `&status=${status}` : '';
      const { data } = await api.get(`/tracking/alerts?limit=200${q}`);
      if (mountedRef.current) setAlerts(data);
    } catch { toast.error('Failed to load alerts'); }
    finally { if (mountedRef.current) setLoading(false); }
  }, []);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { loadAlerts(statusTab); }, [statusTab, loadAlerts]);

  // ── Live updates over the shared tracking SSE channel ──────────────
  useEffect(() => {
    let abort = new AbortController();
    let retryTimer;

    async function connect() {
      try {
        const token = localStorage.getItem('of_token');
        const res = await fetch('/api/tracking/live', {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        if (!res.ok) { scheduleRetry(); return; }
        setSseOnline(true);

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const chunks = buf.split('\n\n');
          buf = chunks.pop() || '';
          for (const chunk of chunks) {
            let evtType = 'message';
            const dataLines = [];
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) evtType = line.slice(6).trim();
              else if (line.startsWith('data:'))  dataLines.push(line.slice(5).trim());
            }
            if (!dataLines.length) continue;
            try {
              const p = JSON.parse(dataLines.join(''));
              if (!mountedRef.current) continue;

              if (evtType === 'alert') {
                if (statusTabRef.current !== 'resolved') {
                  setAlerts(prev => [p, ...prev].slice(0, 200));
                }
              } else if (evtType === 'alert_resolved') {
                setAlerts(prev => {
                  if (statusTabRef.current === 'open') return prev.filter(a => a.id !== p.id);
                  const idx = prev.findIndex(a => a.id === p.id);
                  if (idx === -1) return statusTabRef.current === 'resolved' ? [p, ...prev].slice(0, 200) : prev;
                  const next = [...prev];
                  next[idx] = p;
                  return next;
                });
              }
            } catch { /* ignore parse errors */ }
          }
        }
        if (mountedRef.current) setSseOnline(false);
        if (mountedRef.current) scheduleRetry();
      } catch (err) {
        if (mountedRef.current) setSseOnline(false);
        if (err.name !== 'AbortError' && mountedRef.current) scheduleRetry();
      }
    }

    function scheduleRetry() { retryTimer = setTimeout(connect, 5_000); }
    connect();
    return () => { abort.abort(); clearTimeout(retryTimer); setSseOnline(false); };
  }, []);

  const openResolve = (alert) => { setResolving(alert); setComment(''); };
  const closeResolve = () => { if (!submitting) { setResolving(null); setComment(''); } };

  const submitResolve = useCallback(async () => {
    if (!resolving || !comment.trim()) return;
    setSubmitting(true);
    try {
      const { data } = await api.put(`/tracking/alerts/${resolving.id}/resolve`, { comment: comment.trim() });
      setAlerts(prev => statusTab === 'open' ? prev.filter(a => a.id !== data.id) : prev.map(a => a.id === data.id ? data : a));
      toast.success('Alert closed');
      setResolving(null);
      setComment('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to close alert');
    } finally {
      setSubmitting(false);
    }
  }, [resolving, comment, statusTab]);

  const group = ALERT_FILTER_GROUPS.find(g => g.id === typeFilter);
  const visible = group?.types ? alerts.filter(a => group.types.includes(a.alert_type)) : alerts;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {STATUS_TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setStatusTab(t.id)}
              style={{
                fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)',
                fontWeight: statusTab === t.id ? 700 : 400,
                background: statusTab === t.id ? 'var(--primary)' : 'transparent',
                color: statusTab === t.id ? '#fff' : 'var(--muted)',
                cursor: 'pointer',
              }}
            >{t.label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: sseOnline ? '#22c55e' : 'var(--muted)' }}>
          {sseOnline ? <Wifi size={12} /> : <WifiOff size={12} />} {sseOnline ? 'Live' : 'Reconnecting…'}
        </span>
        <button className="btn btn-sm btn-secondary" onClick={() => loadAlerts(statusTab)}><RefreshCw size={11} /></button>
      </div>

      <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {ALERT_FILTER_GROUPS.map(g => (
          <button
            key={g.id}
            onClick={() => setTypeFilter(g.id)}
            style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 12, border: '1px solid var(--border)',
              fontWeight: typeFilter === g.id ? 700 : 400,
              background: typeFilter === g.id ? 'var(--primary)' : 'transparent',
              color: typeFilter === g.id ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
            }}
          >{g.label}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '60px 20px', textAlign: 'center' }}>
            <BellOff size={32} style={{ color: 'var(--muted)', marginBottom: 10 }} />
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              {statusTab === 'open' ? 'No open alerts' : statusTab === 'resolved' ? 'No closed alerts yet' : 'No alerts yet'}
            </div>
          </div>
        ) : (
          <div style={{ maxWidth: 820, margin: '0 auto', padding: '10px 16px' }}>
            {visible.map(a => {
              const { payload, isDangerZone, isCritical, label, color } = alertMeta(a);
              const isResolved = !!a.resolved_at;
              return (
                <div key={a.id} className="card" style={{ marginBottom: 8, padding: '12px 14px', borderLeft: `3px solid ${color}` }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 4 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
                        {isCritical && <span style={{ fontSize: 9, fontWeight: 700, color: '#fff', background: color, padding: '0 5px', borderRadius: 4 }}>CRITICAL</span>}
                        {isDangerZone && a.alert_type === 'geofence_enter' && <span style={{ fontSize: 9, fontWeight: 700, color: '#fff', background: '#E53935', padding: '0 5px', borderRadius: 4 }}>NO-GO</span>}
                        {isResolved && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', border: '1px solid var(--border)', padding: '0 5px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 3 }}><CheckCircle2 size={10} /> CLOSED</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        {a.bike_registration || `Bike #${a.bike_id}`} · {fmtSASTtime(a.created_at)}
                      </div>
                      {payload.speed_kmh && <div style={{ fontSize: 11, color, marginTop: 2 }}>{Math.round(payload.speed_kmh)} km/h{payload.limit_kmh ? ` (limit ${payload.limit_kmh})` : ''}</div>}
                      {payload.geofence_name && a.alert_type !== 'engine_cut_auto' && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Zone: {payload.geofence_name}</div>}
                      {a.alert_type === 'engine_cut_auto' && <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 2 }}>{payload.queued ? 'Queued — will send on reconnect' : 'Command sent'}{payload.geofence_name ? ` · triggered by: ${payload.geofence_name}` : ''}</div>}
                      {payload.idle_sec && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Idle: {Math.round(payload.idle_sec / 60)} min</div>}
                      {payload.battery_mv && <div style={{ fontSize: 11, color: '#f97316', marginTop: 2 }}>{Math.round((payload.battery_mv - 3200) / 10)}% battery ({payload.battery_mv} mV)</div>}
                      {a.alert_type === 'theft_risk' && (
                        <>
                          <div style={{ fontSize: 11, color, marginTop: 2, fontWeight: 700 }}>Risk score: {payload.score}/100</div>
                          {Array.isArray(payload.reasons) && payload.reasons.length > 0 && (
                            <ul style={{ margin: '3px 0 0', paddingLeft: 16, fontSize: 11, color: 'var(--muted)' }}>
                              {payload.reasons.map((r, i) => <li key={i}>{r}</li>)}
                            </ul>
                          )}
                        </>
                      )}
                      {isResolved && (
                        <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6 }}>
                          <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                            Closed by <strong>{a.resolved_by_name || 'Unknown'}</strong> · {fmtSASTtime(a.resolved_at)}
                          </div>
                          <div style={{ fontSize: 11, marginTop: 3 }}>{a.resolution_comment}</div>
                        </div>
                      )}
                    </div>
                    {!isResolved && (
                      <button className="btn btn-sm btn-primary" style={{ flexShrink: 0, fontSize: 11 }} onClick={() => openResolve(a)}>Close alert</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal isOpen={!!resolving} onClose={closeResolve} title="Close alert">
        {resolving && (
          <div style={{ minWidth: 360 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
              {alertMeta(resolving).label} · {resolving.bike_registration || `Bike #${resolving.bike_id}`} · {fmtSASTtime(resolving.created_at)}
            </div>
            <label className="label" style={{ fontSize: 12 }}>Resolution comment (required, kept for audit)</label>
            <textarea
              autoFocus
              rows={4}
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="What happened and what action was taken?"
              style={{ width: '100%', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn btn-sm btn-secondary" onClick={closeResolve} disabled={submitting}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={submitResolve} disabled={submitting || !comment.trim()}>
                {submitting ? 'Closing…' : 'Close alert'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { KeyRound, Webhook, Plus, Trash2, Copy, Check, RefreshCw, Send, AlertTriangle, Database, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import api from '../../api';
import { Loading, Modal, fmtDateTime } from '../../components/ui';
import { ALERT_LABELS } from '../../lib/alertMeta';

// Shown once at creation and never again — only a hash is stored server-side.
function SecretReveal({ label, value, onDone }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { toast.error('Could not copy — select and copy manually'); }
  };
  return (
    <div style={{ minWidth: 380, maxWidth: 560 }}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start', marginBottom: 12 }}>
        <AlertTriangle size={18} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 2 }} />
        <div className="text-sm">
          Copy this now — it is shown once and cannot be retrieved again.
          If it is lost you will need to issue a replacement.
        </div>
      </div>
      <label className="label" style={{ fontSize: 12 }}>{label}</label>
      <div className="card" style={{ background: 'var(--surface-2)', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12 }}>
        {value}
      </div>
      <div className="row mt-3" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-secondary btn-sm" onClick={copy}>
          {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
        </button>
        <button className="btn btn-sm" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const SEVERITY_COLOR = { critical: 'var(--danger)', high: 'var(--warn)', medium: 'var(--primary-light)', low: 'var(--muted)' };
// Quick selections for the common cases; the checklist can still be adjusted after.
const ALERT_PRESETS = [
  { label: 'Critical only', severities: ['critical'] },
  { label: 'Critical and high', severities: ['critical', 'high'] },
  { label: 'Everything except low', severities: ['critical', 'high', 'medium'] },
];

const selectedTypes = (hook) => (hook.event_types ? String(hook.event_types).split(',').filter(Boolean) : null);

export default function AdminIntegrations() {
  const [keys, setKeys] = useState(null);
  const [hooks, setHooks] = useState(null);
  const [revealed, setRevealed] = useState(null); // { label, value }
  const [keyName, setKeyName] = useState('');
  const [hookName, setHookName] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(null);
  const [alertTypes, setAlertTypes] = useState([]);
  const [choosingFor, setChoosingFor] = useState(null);
  const [chooseAll, setChooseAll] = useState(true);
  const [chosen, setChosen] = useState(() => new Set());
  const [savingChoice, setSavingChoice] = useState(false);
  const [backups, setBackups] = useState(null);
  const [verifying, setVerifying] = useState(null);

  const load = useCallback(async () => {
    const [k, w, b, t] = await Promise.all([
      api.get('/admin/integrations/api-keys'),
      api.get('/admin/integrations/webhooks'),
      // Backup health had no interface at all — the endpoint existed and
      // nothing in the app had ever called it.
      api.get('/admin/backups').catch(() => ({ data: null })),
      api.get('/admin/integrations/alert-types').catch(() => ({ data: { alert_types: [] } })),
    ]);
    setKeys(k.data.keys);
    setHooks(w.data.webhooks);
    setBackups(b.data);
    setAlertTypes(t.data.alert_types || []);
  }, []);

  const verifyBackup = async (name) => {
    setVerifying(name);
    try {
      const { data } = await api.post(`/admin/backups/${encodeURIComponent(name)}/verify`);
      if (data.verified) toast.success('Checksum matches — this backup is intact');
      else toast.error(data.issue || 'This backup did not verify');
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not verify that backup');
    } finally {
      setVerifying(null);
    }
  };

  useEffect(() => { load().catch(() => toast.error('Could not load integrations')); }, [load]);

  const createKey = async () => {
    if (!keyName.trim()) return toast.error('Give the key a name');
    setBusy(true);
    try {
      const { data } = await api.post('/admin/integrations/api-keys', { name: keyName.trim() });
      setRevealed({ label: 'API key', value: data.key });
      setKeyName('');
      await load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not create key'); }
    finally { setBusy(false); }
  };

  const revokeKey = async (id, name) => {
    if (!window.confirm(`Revoke "${name}"? Any system using it will immediately lose access.`)) return;
    try {
      await api.delete(`/admin/integrations/api-keys/${id}`);
      toast.success('Key revoked');
      await load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not revoke key'); }
  };

  const createHook = async () => {
    if (!hookName.trim() || !hookUrl.trim()) return toast.error('Name and URL are both required');
    setBusy(true);
    try {
      const { data } = await api.post('/admin/integrations/webhooks', { name: hookName.trim(), url: hookUrl.trim() });
      setRevealed({ label: 'Signing secret', value: data.secret });
      setHookName(''); setHookUrl('');
      await load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not create webhook'); }
    finally { setBusy(false); }
  };

  const openAlertChooser = (hook) => {
    const current = selectedTypes(hook);
    setChoosingFor(hook);
    setChooseAll(!current);
    setChosen(new Set(current || alertTypes.map((t) => t.type)));
  };

  const toggleType = (type) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(type)) next.delete(type); else next.add(type);
    return next;
  });

  const setSeverityGroup = (severity, on) => setChosen((prev) => {
    const next = new Set(prev);
    alertTypes.filter((t) => t.severity === severity).forEach((t) => (on ? next.add(t.type) : next.delete(t.type)));
    return next;
  });

  const applyPreset = (severities) => {
    setChooseAll(false);
    setChosen(new Set(alertTypes.filter((t) => severities.includes(t.severity)).map((t) => t.type)));
  };

  const saveAlertChoice = async () => {
    if (!chooseAll && chosen.size === 0) return toast.error('Choose at least one alert type, or pause the webhook instead');
    setSavingChoice(true);
    try {
      await api.put(`/admin/integrations/webhooks/${choosingFor.id}`, { event_types: chooseAll ? null : [...chosen] });
      toast.success(chooseAll
        ? `${choosingFor.name} will receive every alert type`
        : `${choosingFor.name} will receive ${chosen.size} alert type${chosen.size === 1 ? '' : 's'}`);
      setChoosingFor(null);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save the alert selection');
    } finally {
      setSavingChoice(false);
    }
  };

  const toggleHook = async (hook) => {
    try {
      await api.put(`/admin/integrations/webhooks/${hook.id}`, { active: !hook.active });
      await load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not update webhook'); }
  };

  const deleteHook = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? Events will stop being sent to it.`)) return;
    try {
      await api.delete(`/admin/integrations/webhooks/${id}`);
      toast.success('Webhook deleted');
      await load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not delete webhook'); }
  };

  const testHook = async (id) => {
    setTesting(id);
    try {
      const { data } = await api.post(`/admin/integrations/webhooks/${id}/test`);
      if (data.ok) toast.success('Test event delivered');
      else toast.error(`Delivery failed: ${data.result?.last_error || 'no response'}`);
      await load();
    } catch (e) { toast.error(e.response?.data?.error || 'Test failed'); }
    finally { setTesting(null); }
  };

  if (!keys || !hooks) return <Loading />;

  const platformKeys = keys.filter((k) => k.scope === 'platform');
  const orgKeys = keys.filter((k) => k.scope !== 'platform');

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">Platform API keys and outbound event webhooks for third-party systems such as an outsourced control room.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => load()}><RefreshCw size={14} style={{ marginRight: 6 }} /> Refresh</button>
      </div>

      {/* ── Platform API keys ────────────────────────────────────────── */}
      <div className="card mb-4">
        <div className="card-title"><h3><KeyRound size={16} style={{ marginRight: 8, verticalAlign: -2 }} />Platform API keys</h3></div>
        <div className="muted text-sm mb-3">
          A platform key can read <strong>every</strong> vehicle, group, rider and alarm across all fleet owners
          and platform-owned stock. Issue one per integrator so it can be revoked independently.
        </div>

        <div className="row mb-3" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="Name, e.g. Control Room (3rd party)"
            style={{ flex: '1 1 260px' }}
          />
          <button className="btn" onClick={createKey} disabled={busy}><Plus size={14} /> Issue key</button>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th>Status</th><th /></tr></thead>
            <tbody>
              {platformKeys.length === 0 && <tr><td colSpan="5" className="muted">No platform keys yet.</td></tr>}
              {platformKeys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{k.key_prefix}…</td>
                  <td>{k.last_used_at ? fmtDateTime(k.last_used_at) : <span className="muted">never</span>}</td>
                  <td>{k.revoked_at
                    ? <span className="muted text-xs">Revoked {fmtDateTime(k.revoked_at)}</span>
                    : <span style={{ color: 'var(--success)', fontWeight: 700, fontSize: 12 }}>Active</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {!k.revoked_at && (
                      <button className="btn btn-sm btn-secondary" onClick={() => revokeKey(k.id, k.name)}>
                        <Trash2 size={13} /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {orgKeys.length > 0 && (
          <div className="muted text-xs mt-3">
            {orgKeys.length} fleet-owner key{orgKeys.length !== 1 ? 's' : ''} also exist, scoped to a single organisation
            and managed by that fleet owner in their own portal.
          </div>
        )}
      </div>

      {/* ── Webhooks ─────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title"><h3><Webhook size={16} style={{ marginRight: 8, verticalAlign: -2 }} />Event webhooks</h3></div>
        <div className="muted text-sm mb-3">
          Tracking alarms are POSTed to these endpoints as they happen, signed with HMAC-SHA256 so the
          receiver can verify they came from us. Each endpoint gets every alarm type unless you choose which
          ones it receives. Failed deliveries retry with backoff for about six hours.
          HTTPS is required — payloads carry rider names and phone numbers.
        </div>

        <div className="row mb-3" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input value={hookName} onChange={(e) => setHookName(e.target.value)} placeholder="Name, e.g. Control Room" style={{ flex: '1 1 200px' }} />
          <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://their-system.example/webhooks/onfleet" style={{ flex: '2 1 320px' }} />
          <button className="btn" onClick={createHook} disabled={busy}><Plus size={14} /> Add endpoint</button>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>URL</th><th>Alerts sent</th><th>Delivered</th><th>Pending</th><th>Failed</th><th>Last result</th><th /></tr></thead>
            <tbody>
              {hooks.length === 0 && <tr><td colSpan="8" className="muted">No webhook endpoints registered yet.</td></tr>}
              {hooks.map((h) => (
                <tr key={h.id} style={{ opacity: h.active ? 1 : 0.55 }}>
                  <td>
                    {h.name}
                    {!h.active && <div className="muted text-xs">Paused</div>}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', maxWidth: 240 }}>{h.url}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => openAlertChooser(h)}
                      title={selectedTypes(h) ? selectedTypes(h).map((t) => ALERT_LABELS[t] || t).join(', ') : 'Every alert type, including new ones'}>
                      <SlidersHorizontal size={13} />{' '}
                      {selectedTypes(h) ? `${selectedTypes(h).length} of ${alertTypes.length || '…'} types` : 'All types'}
                    </button>
                  </td>
                  <td>{h.delivered}</td>
                  <td>{h.pending > 0 ? <strong style={{ color: 'var(--warn)' }}>{h.pending}</strong> : 0}</td>
                  <td>{h.failed > 0 ? <strong style={{ color: 'var(--danger)' }}>{h.failed}</strong> : 0}</td>
                  <td style={{ fontSize: 11 }}>
                    {h.last_error
                      ? <span style={{ color: 'var(--danger)' }} title={h.last_error}>{String(h.last_error).slice(0, 40)}</span>
                      : h.last_success_at
                        ? <span className="muted">OK · {fmtDateTime(h.last_success_at)}</span>
                        : <span className="muted">no deliveries yet</span>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-secondary" disabled={testing === h.id} onClick={() => testHook(h.id)} style={{ marginRight: 6 }}>
                      <Send size={13} /> {testing === h.id ? 'Sending…' : 'Test'}
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => toggleHook(h)} style={{ marginRight: 6 }}>
                      {h.active ? 'Pause' : 'Resume'}
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => deleteHook(h.id, h.name)}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Backups ──────────────────────────────────────────────────── */}
      {backups && (
        <div className="card mb-4">
          <div className="card-title"><h3><Database size={16} style={{ marginRight: 8, verticalAlign: -2 }} />Backups</h3></div>
          <div className="muted text-sm mb-3">
            The database is dumped nightly at 03:00 to the same persistent volume the uploads live on,
            and the last 14 are kept. Each dump records a SHA-256 when it is written; verifying reads the
            file back and compares it, which is the only check that catches contents changing underneath.
          </div>

          {(backups.summary.stale || backups.summary.damaged > 0) && (
            <div className="card mb-3" style={{ borderLeft: '3px solid var(--danger)', background: 'var(--surface-2)' }}>
              <div className="text-sm" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 2 }} />
                <span>
                  {backups.summary.damaged > 0 && (
                    <><strong>{backups.summary.damaged} backup{backups.summary.damaged !== 1 ? 's are' : ' is'} damaged.</strong>{' '}</>
                  )}
                  {backups.summary.stale && (
                    <>No backup in {backups.summary.latest_age_hours ?? '—'} hours — the nightly run should never leave a gap this long.</>
                  )}
                </span>
              </div>
            </div>
          )}

          <div className="row mb-3" style={{ gap: 18, flexWrap: 'wrap' }}>
            <span className="text-sm"><span className="muted">Kept:</span> <strong>{backups.summary.count}</strong></span>
            <span className="text-sm">
              <span className="muted">Most recent:</span>{' '}
              <strong style={{ color: backups.summary.stale ? 'var(--danger)' : 'var(--success)' }}>
                {backups.summary.latest_age_hours !== null ? `${backups.summary.latest_age_hours}h ago` : 'never'}
              </strong>
            </span>
            <span className="text-sm">
              <span className="muted">Damaged:</span>{' '}
              <strong style={{ color: backups.summary.damaged ? 'var(--danger)' : 'var(--success)' }}>{backups.summary.damaged}</strong>
            </span>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Taken</th><th>Size</th><th>Tables</th><th>State</th><th style={{ width: 110 }}></th></tr></thead>
              <tbody>
                {backups.backups.map((b) => (
                  <tr key={b.name}>
                    <td className="text-xs" style={{ whiteSpace: 'nowrap' }}>{b.created_at ? fmtDateTime(b.created_at) : b.name}</td>
                    <td className="text-xs">{b.postgres?.bytes ? `${(b.postgres.bytes / 1048576).toFixed(1)} MB` : '—'}</td>
                    <td className="text-xs">{b.postgres?.table_row_counts ? Object.keys(b.postgres.table_row_counts).length : '—'}</td>
                    <td className="text-xs">
                      {b.health === 'ok'
                        ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>{b.verified ? 'verified' : 'ok'}</span>
                        : <span style={{ color: 'var(--danger)', fontWeight: 600 }} title={b.issue || ''}>{b.health.replace(/_/g, ' ')}</span>}
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => verifyBackup(b.name)}
                        disabled={verifying === b.name}
                        title="Read the dump back and compare it to its recorded checksum"
                      >
                        <ShieldCheck size={13} /> {verifying === b.name ? 'Checking…' : 'Verify'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="muted text-xs" style={{ marginTop: 10, lineHeight: 1.5 }}>
            These cover the database only. The {''}
            <strong>uploaded documents are not in any backup</strong>, and both they and these dumps sit on
            the same volume — losing it loses both at once.
          </div>
        </div>
      )}

      <Modal isOpen={!!choosingFor} onClose={() => setChoosingFor(null)}
        title={choosingFor ? `Alerts sent to ${choosingFor.name}` : ''} style={{ maxWidth: 640 }}>
        {choosingFor && (() => {
          const volume = alertTypes.reduce((sum, t) => sum + ((chooseAll || chosen.has(t.type)) ? t.last_30_days : 0), 0);
          const total = alertTypes.reduce((sum, t) => sum + t.last_30_days, 0);
          return (
            <div>
              <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
                <label className="text-sm" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input type="radio" name="alert-mode" checked={chooseAll} onChange={() => setChooseAll(true)} style={{ marginTop: 3 }} />
                  <span><strong>Every alert type</strong><span className="muted"> — including types added to OnFleet later</span></span>
                </label>
                <label className="text-sm" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input type="radio" name="alert-mode" checked={!chooseAll} onChange={() => setChooseAll(false)} style={{ marginTop: 3 }} />
                  <span><strong>Only the types I choose</strong><span className="muted"> — new types stay off until you add them</span></span>
                </label>
              </div>

              {!chooseAll && (
                <>
                  <div className="row mb-3" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {ALERT_PRESETS.map((p) => (
                      <button key={p.label} className="btn btn-sm btn-secondary" onClick={() => applyPreset(p.severities)}>{p.label}</button>
                    ))}
                  </div>
                  <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                    {SEVERITY_ORDER.map((severity) => {
                      const group = alertTypes.filter((t) => t.severity === severity);
                      if (!group.length) return null;
                      const allOn = group.every((t) => chosen.has(t.type));
                      return (
                        <div key={severity}>
                          <div className="flex-between" style={{ padding: '8px 12px', background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                            <span className="text-xs" style={{ fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: SEVERITY_COLOR[severity] }}>
                              {SEVERITY_LABEL[severity]}
                            </span>
                            <button className="btn btn-sm btn-secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setSeverityGroup(severity, !allOn)}>
                              {allOn ? 'Clear' : 'Select all'}
                            </button>
                          </div>
                          {group.map((t) => (
                            <label key={t.type} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', padding: '7px 12px', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                              <input type="checkbox" checked={chosen.has(t.type)} onChange={() => toggleType(t.type)} />
                              <span className="text-sm">
                                {ALERT_LABELS[t.type] || t.type}
                                <span className="muted" style={{ fontFamily: 'monospace', fontSize: 11, marginLeft: 8 }}>{t.type}</span>
                              </span>
                              <span className="muted text-xs" style={{ fontVariantNumeric: 'tabular-nums' }} title="Alerts of this type in the last 30 days">
                                {t.last_30_days.toLocaleString('en-ZA')}
                              </span>
                            </label>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <div className="muted text-sm" style={{ marginTop: 12 }}>
                {chooseAll
                  ? `Everything: ${total.toLocaleString('en-ZA')} alerts in the last 30 days.`
                  : `${chosen.size} of ${alertTypes.length} types — ${volume.toLocaleString('en-ZA')} of ${total.toLocaleString('en-ZA')} alerts in the last 30 days would have been sent.`}
              </div>
              <div className="row mt-3" style={{ gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setChoosingFor(null)}>Cancel</button>
                <button className="btn" onClick={saveAlertChoice} disabled={savingChoice}>{savingChoice ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          );
        })()}
      </Modal>

      <Modal isOpen={!!revealed} onClose={() => setRevealed(null)} title={revealed ? `Your ${revealed.label.toLowerCase()}` : ''}>
        {revealed && <SecretReveal label={revealed.label} value={revealed.value} onDone={() => setRevealed(null)} />}
      </Modal>
    </>
  );
}

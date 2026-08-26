import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { KeyRound, Webhook, Plus, Trash2, Copy, Check, RefreshCw, Send, AlertTriangle } from 'lucide-react';
import api from '../../api';
import { Loading, Modal, fmtDateTime } from '../../components/ui';

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

export default function AdminIntegrations() {
  const [keys, setKeys] = useState(null);
  const [hooks, setHooks] = useState(null);
  const [revealed, setRevealed] = useState(null); // { label, value }
  const [keyName, setKeyName] = useState('');
  const [hookName, setHookName] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(null);

  const load = useCallback(async () => {
    const [k, w] = await Promise.all([
      api.get('/admin/integrations/api-keys'),
      api.get('/admin/integrations/webhooks'),
    ]);
    setKeys(k.data.keys);
    setHooks(w.data.webhooks);
  }, []);

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
          Every tracking alarm is POSTed to these endpoints as it happens, signed with HMAC-SHA256 so the
          receiver can verify it came from us. Failed deliveries retry with backoff for about six hours.
          HTTPS is required — payloads carry rider names and phone numbers.
        </div>

        <div className="row mb-3" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input value={hookName} onChange={(e) => setHookName(e.target.value)} placeholder="Name, e.g. Control Room" style={{ flex: '1 1 200px' }} />
          <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://their-system.example/webhooks/onfleet" style={{ flex: '2 1 320px' }} />
          <button className="btn" onClick={createHook} disabled={busy}><Plus size={14} /> Add endpoint</button>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>URL</th><th>Delivered</th><th>Pending</th><th>Failed</th><th>Last result</th><th /></tr></thead>
            <tbody>
              {hooks.length === 0 && <tr><td colSpan="7" className="muted">No webhook endpoints registered yet.</td></tr>}
              {hooks.map((h) => (
                <tr key={h.id} style={{ opacity: h.active ? 1 : 0.55 }}>
                  <td>
                    {h.name}
                    {!h.active && <div className="muted text-xs">Paused</div>}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', maxWidth: 240 }}>{h.url}</td>
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

      <Modal isOpen={!!revealed} onClose={() => setRevealed(null)} title={revealed ? `Your ${revealed.label.toLowerCase()}` : ''}>
        {revealed && <SecretReveal label={revealed.label} value={revealed.value} onDone={() => setRevealed(null)} />}
      </Modal>
    </>
  );
}

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api';
import { EmptyState, Loading, fmtDate } from '../../components/ui';

export default function ApiKeys() {
  const [loading, setLoading] = useState(true);
  const [apiKeys, setApiKeys] = useState([]);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [generatedKey, setGeneratedKey] = useState(null);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get('/fleet/api-keys');
      setApiKeys(data.api_keys || []);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not load API keys');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const createKey = async () => {
    const name = newName.trim();
    if (!name) return toast.error('Key name is required');
    setCreating(true);
    try {
      const { data } = await api.post('/fleet/api-keys', { name });
      setGeneratedKey({ key: data.key, name: data.name, prefix: data.prefix });
      setNewName('');
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not create API key');
    } finally {
      setCreating(false);
    }
  };

  const revokeKey = async (keyItem) => {
    if (!window.confirm(`Revoke API key "${keyItem.name}"? Any integrations using it will stop working immediately.`)) return;
    try {
      await api.delete(`/fleet/api-keys/${keyItem.id}`);
      toast.success('API key revoked');
      await load({ silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not revoke key');
    }
  };

  const copyKey = async () => {
    if (!generatedKey?.key) return;
    try {
      await navigator.clipboard.writeText(generatedKey.key);
      toast.success('Key copied to clipboard');
    } catch {
      toast.error('Could not copy key');
    }
  };

  if (loading) return <Loading />;

  return (
    <>
      <div className="mb-4">
        <h1 className="page-title">API Access</h1>
        <p className="page-sub">Generate bearer token keys for read-only access to your fleet data via the OnFleet API. Keys can only be seen once when generated.</p>
      </div>

      {generatedKey && (
        <div className="card mb-4" style={{ border: '1px solid var(--success)', background: 'rgba(34,197,94,0.08)' }}>
          <div style={{ fontWeight: 700, color: 'var(--success)', marginBottom: 8 }}>API key generated — copy it now</div>
          <div className="muted text-sm mb-3">This key will not be shown again. Store it securely before closing this message.</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input value={generatedKey.key} readOnly style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }} />
            <button className="btn btn-secondary" onClick={copyKey}>Copy</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setGeneratedKey(null)}>Dismiss</button>
          </div>
          <div className="text-xs muted mt-2">Name: {generatedKey.name} · Prefix: {generatedKey.prefix}</div>
        </div>
      )}

      <div className="card mb-4">
        <h3 className="mb-3">Generate new API key</h3>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Key name, e.g. Production integration" style={{ flex: 1, minWidth: 200 }} />
          <button className="btn" disabled={creating} onClick={createKey}>{creating ? 'Generating…' : 'Generate key'}</button>
        </div>
        <div className="muted text-sm mt-2">Use the generated key as a Bearer token in the Authorization header of requests to <code>/api/v1/*</code> endpoints.</div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <strong>Active API keys</strong>
        </div>
        {!apiKeys.length ? (
          <EmptyState title="No API keys" sub="Generate a key above to get started." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((keyItem) => (
                <tr key={keyItem.id}>
                  <td>{keyItem.name}</td>
                  <td><code style={{ fontSize: 12 }}>{keyItem.key_prefix}…</code></td>
                  <td>{fmtDate(keyItem.created_at)}<div className="text-xs muted">{keyItem.created_by_name || '—'}</div></td>
                  <td>{keyItem.last_used_at ? fmtDate(keyItem.last_used_at) : <span className="muted text-xs">Never</span>}</td>
                  <td>
                    {keyItem.revoked_at ? (
                      <span style={{ color: 'var(--danger)', fontSize: 12 }}>Revoked {fmtDate(keyItem.revoked_at)}</span>
                    ) : (
                      <span style={{ color: 'var(--success)', fontSize: 12 }}>Active</span>
                    )}
                  </td>
                  <td>
                    {!keyItem.revoked_at && (
                      <button className="btn btn-sm btn-danger" onClick={() => revokeKey(keyItem)}>Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card mt-4" style={{ background: 'var(--surface-2)' }}>
        <h4 className="mb-2">API endpoints</h4>
        <div className="muted text-sm mb-2">All endpoints are read-only and require <code>Authorization: Bearer &lt;your-key&gt;</code></div>
        <table className="table">
          <thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td>GET</td><td><code>/api/v1/bikes</code></td><td>List all bikes in your fleet</td></tr>
            <tr><td>GET</td><td><code>/api/v1/agreements</code></td><td>List all agreements with payment summary</td></tr>
            <tr><td>GET</td><td><code>/api/v1/riders</code></td><td>List all riders with agreement status</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

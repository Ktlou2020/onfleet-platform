import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, Check, ExternalLink, Link2, Unlink, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api';
import { ConfirmModal, Loading, fmtDate } from '../../components/ui';

// Where a fleet's rider payments land.
//
// This is not the subscription the fleet pays us — that is on the Billing page
// and goes to our own account. This is the fleet's own Paystack account, and
// once it is connected their riders' money goes straight to them and never
// passes through us.
//
// Two things people get wrong, so both are made hard to miss: the secret key
// is write-only, and the webhook URL has to be pasted into Paystack or
// payments are taken and never recorded against the rider.

function CopyRow({ label, value, hint }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the text and copy it by hand');
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <label className="label">{label}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <code style={{
          flex: 1, minWidth: 0, padding: '9px 11px', borderRadius: 7, fontSize: 12,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          overflowX: 'auto', whiteSpace: 'nowrap',
        }}>{value}</code>
        <button type="button" className="btn btn-secondary" onClick={copy} style={{ flexShrink: 0 }}>
          {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
        </button>
      </div>
      {hint && <div className="text-xs muted" style={{ marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

export default function PaystackAccount() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [secretKey, setSecretKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/fleet/payments/account');
      setStatus(data);
      setPublicKey(data.public_key || '');
    } catch {
      toast.error('Could not load your payment account');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    if (!secretKey.trim()) return toast.error('Paste your Paystack secret key');
    setSaving(true);
    try {
      const { data } = await api.put('/fleet/payments/account', {
        secret_key: secretKey.trim(),
        public_key: publicKey.trim() || null,
      });
      setStatus(data);
      setSecretKey(''); // never held longer than the moment it is sent
      toast.success('Your Paystack account is connected');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not connect that account');
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    try {
      const { data } = await api.delete('/fleet/payments/account');
      setStatus(data);
      setPublicKey('');
      setConfirmDisconnect(false);
      toast.success('Account disconnected');
    } catch {
      toast.error('Could not disconnect');
    }
  };

  if (loading) return <Loading />;

  return (
    <div>
      <h1>Collecting rider payments</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        Connect your own Paystack account and your riders pay you directly. The money goes to your
        account, not ours — we never hold it and take nothing from it.
      </p>

      {status?.connected ? (
        <div className="card mt-3">
          <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
                <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
                Connected
              </div>
              <div className="text-sm muted" style={{ marginTop: 3 }}>
                {status.public_key ? <>Key ending <strong>{status.public_key.slice(-6)}</strong> · </> : null}
                connected {status.connected_at ? fmtDate(status.connected_at) : ''}
              </div>
            </div>
            <button className="btn btn-secondary" onClick={() => setConfirmDisconnect(true)}>
              <Unlink size={13} /> Disconnect
            </button>
          </div>

          {status.webhook_url && (
            <>
              <div style={{
                marginTop: 18, padding: 12, borderRadius: 8,
                background: 'var(--surface-2)', border: '1px solid var(--warn)',
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <AlertTriangle size={15} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 2 }} />
                  <div className="text-sm">
                    <strong>One more step, and payments will not record without it.</strong> Paystack has to be
                    told where to send confirmations. Paste the URL below into your Paystack dashboard under
                    Settings → API Keys &amp; Webhooks → Webhook URL. Until you do, riders can pay and the
                    payment will not show against their agreement.
                  </div>
                </div>
                <CopyRow label="Your webhook URL" value={status.webhook_url} />
                <a className="text-xs" href="https://dashboard.paystack.com/#/settings/developers"
                  target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 10 }}>
                  Open Paystack settings <ExternalLink size={11} />
                </a>
              </div>
              <div className="text-xs muted" style={{ marginTop: 10 }}>
                This URL is yours alone and does not change when you reconnect a different key.
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="card mt-3" style={{ background: 'var(--surface-2)' }}>
          <div className="text-sm">
            <strong>Not connected yet.</strong> Until you connect an account, your riders cannot pay by card
            through the platform.
          </div>
        </div>
      )}

      <form className="card mt-3" onSubmit={save}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>
          <Link2 size={14} /> {status?.connected ? 'Replace your keys' : 'Connect your account'}
        </h3>
        <p className="text-sm muted">
          Find these in Paystack under <strong>Settings → API Keys &amp; Webhooks</strong>. Use your live
          keys when you are ready to take real payments.
        </p>

        <div style={{ marginTop: 14 }}>
          <label className="label" htmlFor="paystack-secret">Secret key</label>
          <input
            id="paystack-secret"
            type="password"
            autoComplete="off"
            placeholder="sk_live_…"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
          />
          <div className="text-xs muted" style={{ marginTop: 5 }}>
            Stored encrypted and never shown again — not even to you. If you lose it, generate a new one in
            Paystack and paste it here.
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label className="label" htmlFor="paystack-public">Public key</label>
          <input
            id="paystack-public"
            type="text"
            autoComplete="off"
            placeholder="pk_live_…"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
          />
        </div>

        <button className="btn mt-3" type="submit" disabled={saving}>
          {saving ? 'Connecting…' : status?.connected ? 'Replace keys' : 'Connect account'}
        </button>
      </form>

      {confirmDisconnect && (
        <ConfirmModal
          title="Disconnect your Paystack account?"
          body="Your riders will not be able to pay by card until you connect an account again. Payments already taken are not affected."
          confirmLabel="Disconnect"
          danger
          onConfirm={disconnect}
          onClose={() => setConfirmDisconnect(false)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { CloudOff, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api';
import { listQueued, flushQueue, removeQueued, onQueueChange } from '../lib/offlineQueue';

// What is still waiting to reach the server.
//
// The queue exists so a technician does not lose work in a dead spot. This
// exists so they know the work is not lost — an invisible queue is just a
// slower way of losing it. It shows what is waiting, sends when the signal
// comes back, and when the server refuses something it says so and leaves it
// alone rather than retrying into the void.

export default function PendingWrites() {
  const [queued, setQueued] = useState([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setQueued(await listQueued()), []);

  const flush = useCallback(async (announce) => {
    if (busy) return;
    setBusy(true);
    try {
      const { sent, failed, stopped } = await flushQueue(api);
      if (sent > 0) toast.success(`${sent} ${sent === 1 ? 'change' : 'changes'} sent`);
      if (announce && sent === 0 && stopped) toast.error('Still no connection — your changes are safe');
      if (failed > 0 && !stopped) toast.error(`${failed} ${failed === 1 ? 'change was' : 'changes were'} refused — tap to see why`);
    } finally {
      setBusy(false);
      refresh();
    }
  }, [busy, refresh]);

  useEffect(() => {
    refresh();
    const stop = onQueueChange(refresh);
    // The moment the connection is back, without waiting to be asked.
    const onOnline = () => flush(false);
    window.addEventListener('online', onOnline);
    return () => { stop(); window.removeEventListener('online', onOnline); };
    // flush is deliberately not a dependency: re-registering the listener on
    // every busy-state change would drop the one that was about to fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // A queue left over from a previous session should go as soon as the app
  // opens, not when somebody happens to change page.
  useEffect(() => {
    if (navigator.onLine) flush(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!queued.length) return null;

  const refused = queued.filter((q) => q.error);
  const waiting = queued.filter((q) => !q.error);

  return (
    <div
      className="card"
      style={{
        padding: 12, marginBottom: 12,
        borderColor: refused.length ? 'var(--danger)' : 'var(--warn)',
      }}
    >
      <div className="flex-between" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {refused.length ? <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
            : <CloudOff size={16} style={{ color: 'var(--warn)' }} />}
          <strong className="text-sm">
            {waiting.length > 0 && `${waiting.length} ${waiting.length === 1 ? 'change' : 'changes'} waiting to send`}
            {waiting.length > 0 && refused.length > 0 && ' · '}
            {refused.length > 0 && `${refused.length} refused`}
          </strong>
        </div>
        {waiting.length > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={() => flush(true)} disabled={busy}>
            {busy ? <><RefreshCw size={13} className="spin" /> Sending…</> : 'Send now'}
          </button>
        )}
      </div>

      <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
        {queued.map((q) => (
          <div key={q.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="text-sm" style={{ wordBreak: 'break-word' }}>{q.label}</div>
              {q.error && (
                <div className="text-xs" style={{ color: 'var(--danger)' }}>
                  {q.error} — this one will not be sent again
                </div>
              )}
            </div>
            {q.error && (
              <button
                className="icon-btn"
                title="Discard this change"
                onClick={async () => { await removeQueued(q.id); toast('Discarded'); }}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {waiting.length > 0 && (
        <p className="text-xs muted" style={{ marginTop: 8, marginBottom: 0 }}>
          These are saved on this phone and will send themselves when the signal is back.
        </p>
      )}
    </div>
  );
}

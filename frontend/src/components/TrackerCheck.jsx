import { useState } from 'react';
import { Check, X, Minus, Satellite, RefreshCw } from 'lucide-react';
import api from '../api';

// Whether the tracker on this bike is actually working, asked from the job
// card the technician already has open.
//
// It does not run on load. A technician opens a job card to do the work, and
// firing a tracker query at every job card would be noise on the page and
// load on the server for the majority of jobs that have nothing to do with
// the tracker. It runs when someone asks.
//
// Every check says what it saw, not just whether it passed — a red cross with
// no reading is no use to somebody standing next to the bike trying to work
// out which wire to move.
export default function TrackerCheck({ jobCardId }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.get(`/workshop/job-cards/${jobCardId}/tracker-check`);
      setState(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not reach the tracker check');
    } finally {
      setBusy(false);
    }
  };

  const mark = (c) => {
    if (c.passed) return <Check size={15} style={{ color: 'var(--success)' }} />;
    // A failed optional check is a note, not a fault: a tracker that has not
    // recorded a trip yet is simply a tracker on a bike nobody has ridden.
    if (!c.required) return <Minus size={15} style={{ color: 'var(--muted)' }} />;
    return <X size={15} style={{ color: 'var(--danger)' }} />;
  };

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 15, display: 'flex', alignItems: 'center', gap: 7 }}>
          <Satellite size={15} /> Tracker
        </h3>
        <button className="btn btn-sm btn-secondary" onClick={run} disabled={busy}>
          {busy ? <><RefreshCw size={13} /> Checking…</> : state ? 'Check again' : 'Check the tracker'}
        </button>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</p>}

      {state && !state.has_device && (
        <p className="text-sm muted" style={{ marginTop: 10 }}>{state.message}</p>
      )}

      {state?.has_device && (
        <>
          <div className="text-sm" style={{ marginTop: 10, fontWeight: 600, color: state.ready ? 'var(--success)' : 'var(--warn)' }}>
            {state.ready ? 'Installed and reporting' : 'Not ready yet'}
          </div>
          <div className="text-xs muted" style={{ marginTop: 2 }}>
            {state.device.model ? `${state.device.model} · ` : ''}IMEI {state.device.imei}
          </div>

          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            {state.checks.map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                <span style={{ marginTop: 1, flexShrink: 0 }}>{mark(c)}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="text-sm" style={{ fontWeight: 500 }}>
                    {c.label}
                    {!c.required && <span className="text-xs muted"> · optional</span>}
                  </div>
                  <div className="text-xs muted" style={{ wordBreak: 'break-word' }}>{c.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

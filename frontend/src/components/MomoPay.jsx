import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Smartphone, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api';
import { Modal, fmt } from './ui';

// Paying the rent from the phone in your hand.
//
// The shape of this is not a card checkout and the screen should not pretend
// it is. There is no redirect and no form: MTN pushes a prompt to the rider's
// handset, and nothing happens until they approve it there. So the honest
// interface is a number, a button, and then a wait that says plainly what it
// is waiting for.
//
// The wait matters more than it looks. A rider standing next to a bike that
// will not start has just paid money and is watching a screen; "Approve the
// payment on your phone" is the difference between trusting this and pressing
// pay a second time.

const POLL_MS = 3000;
const GIVE_UP_AFTER_MS = 3 * 60 * 1000;

const STATE = {
  idle: null,
  pending: { label: 'Waiting for you to approve it on your phone…', tone: 'var(--muted)' },
  successful: { label: 'Paid', tone: 'var(--success)' },
  failed: { label: 'Not paid', tone: 'var(--danger)' },
};

export default function MomoPay({ agreementId, amount, savedMsisdn, onPaid }) {
  const [open, setOpen] = useState(false);
  const [msisdn, setMsisdn] = useState(savedMsisdn || '');
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState(null);
  const [status, setStatus] = useState('idle');
  const [unlocked, setUnlocked] = useState(false);
  const startedAt = useRef(null);

  useEffect(() => { setMsisdn(savedMsisdn || ''); }, [savedMsisdn]);

  // Polls while MTN waits for the rider. Stops on an answer, and stops on its
  // own after three minutes rather than hammering a reference that is never
  // going to move.
  useEffect(() => {
    if (!reference || status !== 'pending') return undefined;
    let live = true;
    const id = setInterval(async () => {
      if (Date.now() - startedAt.current > GIVE_UP_AFTER_MS) {
        clearInterval(id);
        if (live) setStatus('failed');
        return;
      }
      try {
        const { data } = await api.get(`/momo/transaction/${reference}`);
        if (!live || data.status === 'pending') return;
        clearInterval(id);
        setStatus(data.status);
        if (data.status === 'successful') {
          setUnlocked(true);
          onPaid?.(data);
        }
      } catch { /* keep waiting; the next tick asks again */ }
    }, POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, [reference, status, onPaid]);

  const pay = async () => {
    if (!msisdn.trim()) return toast.error('Enter the MoMo number to pay from');
    setBusy(true);
    try {
      const { data } = await api.post('/momo/pay', {
        agreement_id: agreementId, amount: Number(amount), msisdn: msisdn.trim(),
      });
      startedAt.current = Date.now();
      setReference(data.reference);
      setStatus('pending');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not reach MoMo');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setOpen(false); setReference(null); setStatus('idle'); setUnlocked(false);
  };

  const state = STATE[status];

  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        <Smartphone size={14} /> Pay with MoMo
      </button>

      <Modal isOpen={open} onClose={() => !busy && status !== 'pending' && reset()} title="Pay with MTN MoMo">
        <div style={{ minWidth: 320, maxWidth: 380 }}>
          {status === 'idle' && (
            <>
              <p className="text-sm muted" style={{ marginTop: 0 }}>
                We will send a prompt to this phone. Approve it there and the payment is done —
                no card, no redirect.
              </p>
              <label className="label" style={{ fontSize: 12 }}>MoMo number</label>
              <input value={msisdn} onChange={(e) => setMsisdn(e.target.value)} inputMode="tel"
                placeholder="082 123 4567" style={{ width: '100%' }} />
              <div className="row mt-3" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="text-sm"><strong>{fmt(amount)}</strong></span>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={pay}>
                  {busy ? <Loader2 size={13} className="spin" /> : <Smartphone size={13} />}
                  {busy ? ' Sending…' : ` Pay ${fmt(amount)}`}
                </button>
              </div>
            </>
          )}

          {status === 'pending' && (
            <div style={{ textAlign: 'center', padding: '14px 0' }}>
              <Loader2 size={30} className="spin" style={{ opacity: 0.6 }} />
              <p className="text-sm" style={{ marginBottom: 4 }}>{state.label}</p>
              <p className="text-xs muted" style={{ margin: 0 }}>
                Check your handset for the MoMo prompt. This screen updates on its own.
              </p>
            </div>
          )}

          {status === 'successful' && (
            <div style={{ textAlign: 'center', padding: '14px 0' }}>
              <Check size={30} style={{ color: 'var(--success)' }} />
              <p className="text-sm" style={{ marginBottom: 4 }}><strong>{fmt(amount)} paid</strong></p>
              {/* The whole point, said out loud. */}
              {unlocked && (
                <p className="text-sm" style={{ color: 'var(--success)', margin: '0 0 10px' }}>
                  Your bike is unlocked — you can ride.
                </p>
              )}
              <button className="btn btn-sm" onClick={reset}>Done</button>
            </div>
          )}

          {status === 'failed' && (
            <div style={{ textAlign: 'center', padding: '14px 0' }}>
              <X size={28} style={{ color: 'var(--danger)' }} />
              <p className="text-sm" style={{ marginBottom: 4 }}>That payment did not go through.</p>
              <p className="text-xs muted">Nothing has been taken. You can try again.</p>
              <button className="btn btn-sm mt-2" onClick={() => { setStatus('idle'); setReference(null); }}>
                Try again
              </button>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

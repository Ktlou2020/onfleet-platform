import { useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export default function TourModal({ steps, storageKey, onFinish }) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(() => {
    try { return !localStorage.getItem(storageKey); } catch { return true; }
  });

  if (!visible || !steps?.length) return null;

  const current = steps[step];
  const isLast = step === steps.length - 1;

  const close = () => {
    try { localStorage.setItem(storageKey, '1'); } catch {}
    setVisible(false);
    onFinish?.();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16
    }}>
      <div className="card" style={{
        maxWidth: 480, width: '100%',
        position: 'relative',
        display: 'flex', flexDirection: 'column', gap: 0,
        overflow: 'hidden'
      }}>
        {/* Progress bar */}
        <div style={{ height: 3, background: 'var(--border)', marginBottom: 0 }}>
          <div style={{
            height: '100%',
            width: `${((step + 1) / steps.length) * 100}%`,
            background: 'var(--primary)',
            transition: 'width 0.3s'
          }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px 0' }}>
          <span className="text-xs muted">{step + 1} of {steps.length}</span>
          <button onClick={close} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', textAlign: 'center' }}>
          {current.icon && (
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: 'var(--surface-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px',
              color: 'var(--primary-light)'
            }}>
              {current.icon}
            </div>
          )}
          <h3 style={{ marginBottom: 10 }}>{current.title}</h3>
          <p className="muted" style={{ lineHeight: 1.6, margin: '0 0 8px', fontSize: 14 }}>{current.description}</p>
          {current.tip && (
            <div style={{
              background: 'var(--surface-2)', borderRadius: 8,
              padding: '10px 14px', marginTop: 14, fontSize: 13,
              textAlign: 'left', color: 'var(--text)'
            }}>
              💡 {current.tip}
            </div>
          )}
        </div>

        {/* Dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, paddingBottom: 4 }}>
          {steps.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              style={{
                width: i === step ? 18 : 6, height: 6, borderRadius: 3,
                background: i === step ? 'var(--primary)' : 'var(--border)',
                border: 'none', cursor: 'pointer', padding: 0,
                transition: 'width 0.2s, background 0.2s'
              }}
            />
          ))}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px 20px' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={close}
          >
            Skip tour
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={() => setStep(step - 1)}>
                <ChevronLeft size={14} /> Back
              </button>
            )}
            {isLast ? (
              <button className="btn btn-sm" onClick={close}>
                Get started
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => setStep(step + 1)}>
                Next <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

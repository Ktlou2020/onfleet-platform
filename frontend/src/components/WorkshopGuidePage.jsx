import Guide, { TryPartsSearch, TrySchedule } from './Guide';
import { WORKSHOP_SECTIONS, ACTION_CODES, INTERVALS } from '../lib/workshopGuideContent';

// The workshop guide: the shell, the workshop's own content, and the two boxes
// that let someone try the real thing while they read about it.
export default function WorkshopGuidePage({ portal = 'workshop' }) {
  return (
    <Guide
      guide="workshop"
      sections={WORKSHOP_SECTIONS}
      portal={portal}
      title="Workshop guide"
      intro={`How to run a job card, read the service schedule, find a part${portal === 'admin' ? ' and order from Hero' : ''}.`}
      widgets={{ parts: <TryPartsSearch />, schedule: <TrySchedule /> }}
      footer={
        <>
          <div className="grid grid-2 mt-3" style={{ gap: 16 }}>
            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 15 }}>What the chart's letters mean</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' }}>
                {ACTION_CODES.map(([code, label]) => (
                  <div key={code} className="text-sm"><strong style={{ fontFamily: 'monospace' }}>{code}</strong> — {label}</div>
                ))}
              </div>
            </div>
            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 15 }}>Intervals worth knowing</h3>
              {INTERVALS.map(([item, rule]) => (
                <div key={item} className="text-sm" style={{ marginBottom: 4 }}>
                  <strong>{item}</strong> — <span className="muted">{rule}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card mt-3">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Who to contact</h3>
            <div className="text-sm">Parts orders and quotations — <strong>parts@heromotorcycles.co.za</strong></div>
            <div className="text-sm">OnFleet office, weekdays 08:00–17:00 — <strong>010 141 1165</strong></div>
            <div className="text-sm">After hours, weekends and public holidays — <strong>081 539 5612</strong></div>
          </div>
        </>
      }
    />
  );
}

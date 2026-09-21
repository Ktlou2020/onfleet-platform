import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Radio, WifiOff, ShieldAlert, Bell } from 'lucide-react';
import api from '../api';
import Guide from './Guide';
import { TRACKING_SECTIONS, ALERT_SEVERITIES, ESCALATION_ROUNDS } from '../lib/trackingGuideContent';
import { ALERT_LABELS } from '../lib/alertMeta';

// The GPS tracking guide. Two of its sections show the fleet as it is right
// now rather than describing it: what the trackers are doing, and what is
// sitting unanswered in the control room. Reading about the queue and looking
// at the queue are the same action.

function TrackerHealthNow() {
  const [health, setHealth] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.get('/tracking/device-health')
      .then(({ data }) => setHealth(data.summary))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  const tiles = health ? [
    ['Reporting', health.reporting, `${health.reporting_pct ?? 0}% in the last hour`, 'var(--success)'],
    ['Gone quiet', health.quiet + health.silent, `${health.silent} silent over a day`, health.silent ? 'var(--warn)' : undefined],
    ['Never connected', health.never_connected, 'registered but never reached us', health.never_connected ? 'var(--danger)' : 'var(--success)'],
    ['Installs unproven', health.uncommissioned, `${health.awaiting_install_proof} over a day old`, health.awaiting_install_proof ? 'var(--warn)' : undefined],
  ] : [];

  return (
    <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
      <div className="text-xs muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
        <Radio size={11} /> Your trackers, right now
      </div>
      {!health && <div className="text-sm muted">Checking…</div>}
      {health && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
            {tiles.map(([label, value, detail, colour]) => (
              <div key={label}>
                <div style={{ fontSize: 22, fontWeight: 700, color: colour }}>{value}</div>
                <div className="text-sm">{label}</div>
                <div className="text-xs muted">{detail}</div>
              </div>
            ))}
          </div>
          <div className="text-xs muted" style={{ marginTop: 8 }}>
            {health.tracked ?? health.total} trackers in total
            {health.on_inactive_bikes > 0 && <> · {health.on_inactive_bikes} on bikes that are not active</>}
            {' · '}<Link to="/admin/tracking/dashboard">open the dashboard</Link>
          </div>
        </>
      )}
    </div>
  );
}

function OpenAlertsNow() {
  const [alerts, setAlerts] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.get('/tracking/alerts', { params: { status: 'open', limit: 200 } })
      .then(({ data }) => setAlerts(data))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  const unacked = (alerts || []).filter((a) => !a.acknowledged_at);
  const byType = [...(alerts || []).reduce((map, a) => map.set(a.alert_type, (map.get(a.alert_type) || 0) + 1), new Map())]
    .sort((a, z) => z[1] - a[1]).slice(0, 5);

  return (
    <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
      <div className="text-xs muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
        <Bell size={11} /> The queue, right now
      </div>
      {!alerts && <div className="text-sm muted">Checking…</div>}
      {alerts && (
        <>
          <div className="text-sm" style={{ marginBottom: 6 }}>
            <strong>{alerts.length}</strong> open{alerts.length ? <> · <strong>{unacked.length}</strong> not yet acknowledged</> : ''}
            {!alerts.length && ' — nothing waiting'}
          </div>
          {byType.map(([type, count]) => (
            <div key={type} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '2px 0' }}>
              <span style={{ flex: 1 }}>{ALERT_LABELS[type] || type}</span>
              <span className="muted">{count}</span>
            </div>
          ))}
          <div className="text-xs muted" style={{ marginTop: 8 }}>
            <Link to="/admin/alerts">open the control room</Link> — closing these with an outcome is what makes the noise measurable
          </div>
        </>
      )}
    </div>
  );
}

export default function TrackingGuidePage({ portal = 'admin' }) {
  return (
    <Guide
      guide="tracking"
      sections={TRACKING_SECTIONS}
      portal={portal}
      title="GPS tracking guide"
      intro="How to watch the map, answer an alert, work a theft, and keep the trackers honest."
      widgets={{ trackerHealth: <TrackerHealthNow />, openAlerts: <OpenAlertsNow /> }}
      footer={
        <>
          <div className="card mt-3">
            <h3 style={{ marginTop: 0, fontSize: 15 }}><ShieldAlert size={14} /> How serious is it?</h3>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead><tr><th>Severity</th><th>Alerts</th><th>What it asks of you</th></tr></thead>
                <tbody>
                  {ALERT_SEVERITIES.map(([level, types, action]) => (
                    <tr key={level}>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{level}</td>
                      <td className="text-sm muted">{types}</td>
                      <td className="text-sm">{action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-2 mt-3" style={{ gap: 16 }}>
            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 15 }}>If nobody acknowledges</h3>
              {ESCALATION_ROUNDS.map(([when, what]) => (
                <div key={when} className="text-sm" style={{ marginBottom: 4 }}>
                  <strong>{when}</strong> — <span className="muted">{what}</span>
                </div>
              ))}
              <div className="text-xs muted" style={{ marginTop: 6 }}>
                Acknowledging ends it immediately, and records who did.
              </div>
            </div>
            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 15 }}><WifiOff size={14} /> A tracker that never connects</h3>
              <div className="text-sm">Server <strong>hayabusa.proxy.rlwy.net</strong>, port <strong>52322</strong>, TCP</div>
              <div className="text-sm muted">SIM active with data, and the network's APN set</div>
              <div className="text-sm muted">Wired to power and ignition</div>
              <div className="text-xs muted" style={{ marginTop: 6 }}>
                Quickest fix: copy the settings from a tracker that is working.
              </div>
            </div>
          </div>

          <div className="card mt-3">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Who to call</h3>
            <div className="text-sm">Weekdays 08:00–17:00 — <strong>010 141 1165</strong></div>
            <div className="text-sm">After hours, weekends and public holidays — <strong>081 539 5612</strong></div>
            <div className="text-xs muted">An alert sent to the control room's systems carries whichever of these was on duty when it was raised.</div>
          </div>
        </>
      }
    />
  );
}

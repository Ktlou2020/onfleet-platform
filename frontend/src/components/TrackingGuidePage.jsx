import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Radio, WifiOff, ShieldAlert, Bell } from 'lucide-react';
import api from '../api';
import Guide from './Guide';
import { TRACKING_SECTIONS, ALERT_SEVERITIES, ESCALATION_ROUNDS } from '../lib/trackingGuideContent';
import { ALERT_LABELS } from '../lib/alertMeta';
import SupportContact from './SupportContact';
import { brandName } from '../brand';

// The GPS tracking guide. Two of its sections show the fleet as it is right
// now rather than describing it: what the trackers are doing, and what is
// sitting unanswered in the control room. Reading about the queue and looking
// at the queue are the same action.

function TrackerHealthNow({ fleet = false }) {
  const [health, setHealth] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // The operator has a device-health endpoint that counts the whole estate.
    // A fleet owner may not call it — and should not, since it counts other
    // people's bikes — so theirs is derived from their own device list, which
    // already carries the same status for each tracker.
    if (fleet) {
      api.get('/fleet/tracking/devices')
        .then(({ data }) => {
          const devices = Array.isArray(data) ? data : (data.devices || []);
          const by = (p) => devices.filter(p).length;
          const total = devices.length || 1;
          const reporting = by((d) => d.device_status === 'active');
          setHealth({
            reporting,
            reporting_pct: Math.round((reporting / total) * 100),
            quiet: by((d) => d.device_status === 'sleeping'),
            silent: by((d) => d.device_status === 'offline' && d.last_seen_at),
            never_connected: by((d) => !d.last_seen_at),
            uncommissioned: 0,
            awaiting_install_proof: 0,
          });
        })
        .catch(() => setFailed(true));
      return;
    }
    api.get('/tracking/device-health')
      .then(({ data }) => setHealth(data.summary))
      .catch(() => setFailed(true));
  }, [fleet]);

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

function OpenAlertsNow({ fleet = false }) {
  const [alerts, setAlerts] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.get(fleet ? '/fleet/tracking/alerts' : '/tracking/alerts', { params: { status: 'open', limit: 200 } })
      .then(({ data }) => setAlerts(data))
      .catch(() => setFailed(true));
  }, [fleet]);

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

// The address a tracker has to be given. Asked for rather than written down:
// a device sent to the wrong one cannot be fixed from here, and this is the
// only place that knows what the server is actually answering on today.
function TrackerEndpointLine() {
  const [endpoint, setEndpoint] = useState(null);

  useEffect(() => {
    api.get('/tracking/endpoint').then(({ data }) => setEndpoint(data)).catch(() => {});
  }, []);

  if (!endpoint) return <div className="text-sm muted">Checking the server address…</div>;

  return (
    <>
      <div className="text-sm">
        Server <strong>{endpoint.host}</strong>, port <strong>{endpoint.port}</strong>, {endpoint.protocol}
      </div>
      {endpoint.drift && (
        <div className="text-xs" style={{ color: 'var(--danger)', marginTop: 4 }}>
          {endpoint.drift} Trackers already in the field cannot reach us until this is put right.
        </div>
      )}
      {!endpoint.own_hostname && (
        <div className="text-xs muted" style={{ marginTop: 4 }}>
          This is the hosting provider's own address. It can change.
        </div>
      )}
    </>
  );
}

export default function TrackingGuidePage({ portal = 'admin' }) {
  // A fleet owner is reading this about their own bikes, not about a fleet
  // they are operating on somebody's behalf, so the guide is addressed to them
  // and named after the product they are signed into.
  const isFleet = portal === 'fleet';

  return (
    <Guide
      guide="tracking"
      sections={TRACKING_SECTIONS}
      portal={portal}
      title={isFleet ? `${brandName} Guide` : 'GPS tracking guide'}
      intro={isFleet
        ? 'How to watch your bikes on the map, answer an alert, work a theft, and keep your trackers honest.'
        : 'How to watch the map, answer an alert, work a theft, and keep the trackers honest.'}
      widgets={{
        trackerHealth: <TrackerHealthNow fleet={isFleet} />,
        openAlerts: <OpenAlertsNow fleet={isFleet} />,
      }}
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
              {/* The ingest host and port are the operator's fitment detail.
                  A fleet owner cannot act on them and does not need them. */}
              {!isFleet && <TrackerEndpointLine />}
              <div className="text-sm muted">SIM active with data, and the network's APN set</div>
              <div className="text-sm muted">Wired to power and ignition</div>
              <div className="text-xs muted" style={{ marginTop: 6 }}>
                Quickest fix: copy the settings from a tracker that is working.
              </div>
            </div>
          </div>

          {isFleet ? (
            <div className="mt-3">
              <SupportContact
                title="Need a hand?"
                sub="Anything you cannot sort out from these screens."
              />
            </div>
          ) : (
            <div className="card mt-3">
              <h3 style={{ marginTop: 0, fontSize: 15 }}>Who to call</h3>
              <div className="text-sm">Weekdays 08:00–17:00 — <strong>010 141 1165</strong></div>
              <div className="text-sm">After hours, weekends and public holidays — <strong>081 539 5612</strong></div>
              <div className="text-xs muted">An alert sent to the control room&apos;s systems carries whichever of these was on duty when it was raised.</div>
            </div>
          )}
        </>
      }
    />
  );
}

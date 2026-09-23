import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { Radio, ShieldAlert, Bell, Zap, ZapOff, Route, Gauge, AlertTriangle, WifiOff, BatteryWarning, MapPinOff, RefreshCw } from 'lucide-react';
import api from '../../api';
import { Stat, Loading, Modal } from '../../components/ui';
import { ALERT_LABELS, ALERT_COLORS } from '../../lib/alertMeta';
import { computeDeviceHealth, healthReasonText } from '../../lib/trackingHelpers';

const RISK_LEVEL_COLOR = { critical: '#dc2626', elevated: '#f97316', watch: '#eab308', normal: '#94a3b8' };
const HEALTH_SEVERITY_COLOR = { high: '#ef4444', medium: '#f97316', low: '#94a3b8' };
const REFRESH_MS = 30_000;

function AttentionRow({ to, title, subtitle, dotColor }) {
  return (
    <Link to={to} className="row" style={{
      justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8,
      background: 'var(--surface-2)', textDecoration: 'none', color: 'inherit', gap: 12,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
        <div className="muted text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>
      </div>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0, marginTop: 5 }} />
    </Link>
  );
}

export default function TrackingDashboard() {
  const [stats, setStats] = useState(null);
  const [devices, setDevices] = useState([]);
  const [mapDevices, setMapDevices] = useState([]);
  const [health, setHealth] = useState(null);
  // The devices behind the health counts, so a tile can open its own list.
  const [healthDevices, setHealthDevices] = useState([]);
  const [drill, setDrill] = useState(null); // { title, note, devices }
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [statsRes, devicesRes, mapRes, healthRes] = await Promise.all([
        api.get('/tracking/dashboard'),
        api.get('/tracking/devices'),
        api.get('/tracking/map'),
        api.get('/tracking/device-health'),
      ]);
      setStats(statsRes.data);
      setDevices(devicesRes.data);
      setMapDevices(mapRes.data);
      setHealth(healthRes.data.summary);
      setHealthDevices(healthRes.data.devices || []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (loading || !stats) return <Loading />;

  const needsAttention = computeDeviceHealth(devices, mapDevices);
  const alertsChartData = stats.alerts.today_by_type.map((r) => ({
    name: ALERT_LABELS[r.alert_type] || r.alert_type,
    count: r.count,
    color: ALERT_COLORS[r.alert_type] || '#94a3b8',
  }));
  const coverageGap = stats.fleet_coverage.total_in_service - stats.fleet_coverage.with_device;

  // Open a tile's list. `note` says what the reader is looking at and what to
  // do about it, so the list is not just names.
  const openDrill = (title, note, filter) =>
    setDrill({ title, note, devices: healthDevices.filter(filter) });

  return (
    <>
      <div className="flex-between mb-3" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">GPS Tracking Dashboard</h1>
          <p className="page-sub">Vital fleet-tracking stats at a glance — refreshes every 30s.</p>
        </div>
        <div className="row">
          <button className="btn btn-secondary" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} style={{ marginRight: 6 }} /> Refresh
          </button>
          <Link to="/admin/tracking" className="btn btn-primary">Open live map</Link>
        </div>
      </div>

      <div className="grid grid-4 mb-4">
        <Stat
          label="Tracker coverage" value={`${stats.fleet_coverage.with_device}/${stats.fleet_coverage.total_in_service}`}
          delta={coverageGap > 0 ? `${coverageGap} active bike${coverageGap === 1 ? '' : 's'} without a tracker` : 'Every active bike covered'}
          icon={<Radio size={16} />} accent={coverageGap > 0 ? 'var(--danger)' : 'var(--success)'}
        />
        <Stat label="Online now" value={stats.devices.active} delta={`${stats.devices.total} devices total`} icon={<Zap size={16} />} accent="var(--success)" />
        <Stat label="Sleeping" value={stats.devices.sleeping} delta="Idle 10min–1hr" icon={<Radio size={16} />} accent="var(--warn)" />
        <Stat label="Offline" value={stats.devices.offline} delta={`${stats.devices.never_connected} never connected`} icon={<WifiOff size={16} />} accent={stats.devices.offline ? 'var(--danger)' : 'var(--success)'} />
      </div>

      {health && (
        <div className="grid grid-4 mb-4">
          <Stat label="Trackers reporting" value={`${health.reporting}/${health.total}`}
            delta={health.reporting_pct == null ? '—' : `${health.reporting_pct}% reported in the last hour`}
            icon={<Radio size={16} />} accent={health.reporting_pct >= 90 ? 'var(--success)' : 'var(--warn)'}
            onClick={() => openDrill('Trackers reporting', 'Reported in the last hour — these are fine.', (d) => d.state === 'reporting')} />
          <Stat label="Gone quiet" value={health.silent + health.quiet}
            delta={`${health.silent} silent over 24h`} icon={<WifiOff size={16} />}
            accent={health.silent ? 'var(--danger)' : undefined}
            onClick={() => openDrill('Gone quiet', 'Nothing heard for over an hour. Silence on a bike that is being ridden is the one to chase.', (d) => d.state === 'quiet' || d.state === 'silent')} />
          <Stat label="Never connected" value={health.never_connected}
            delta="Registered but never reached the server" icon={<WifiOff size={16} />}
            accent={health.never_connected ? 'var(--danger)' : 'var(--success)'}
            onClick={() => openDrill('Never connected', 'Registered but never reached us at all — not installed, whatever it looks like. Check power, the SIM\u2019s data and APN, and that it points at the server address shown in the tracking guide, over TCP.', (d) => d.state === 'never_connected')} />
          <Stat label="Installs not signed off" value={health.uncommissioned}
            delta={health.awaiting_install_proof ? `${health.awaiting_install_proof} overdue by more than a day` : 'All recent'}
            icon={<ShieldAlert size={16} />} accent={health.awaiting_install_proof ? 'var(--warn)' : undefined}
            onClick={() => openDrill('Installs not signed off', 'Fitted but never proved. Run the install check from the tracker\u2019s Controls.', (d) => !d.commissioned)} />
          {/* A tracker whose ignition line was never wired reports a dead 0 for
              ever, so every ordinary ride reads as a tow. Towing and movement
              alerts stay off for these until somebody turns a key. */}
          <Stat label="Ignition line not wired" value={health.ignition_unwired ?? 0}
            delta={health.ignition_unwired ? 'Never seen on — towing alerts off for these' : 'Every tracker has proved its ignition'}
            icon={<ZapOff size={16} />} accent={health.ignition_unwired ? 'var(--warn)' : 'var(--success)'}
            onClick={() => openDrill('Ignition line not wired', 'These have never once reported the ignition on, so their wire is almost certainly not connected. Their odometers are not moving and their services will not come due. Towing and unauthorised-movement alerts stay off until one reads on.', (d) => d.bike_id && !d.ignition_wired)} />
        </div>
      )}

      <div className="grid grid-4 mb-4">
        <Stat label="Open alerts" value={stats.alerts.open_total} delta={`${stats.alerts.unacknowledged} unacknowledged`} icon={<Bell size={16} />} accent={stats.alerts.open_total ? 'var(--warn)' : 'var(--success)'} />
        <Stat label="Critical alerts open" value={stats.alerts.critical_open} delta="Panic, tamper, theft risk & more" icon={<ShieldAlert size={16} />} accent={stats.alerts.critical_open ? 'var(--danger)' : 'var(--success)'} />
        <Stat label="Alerts today" value={stats.alerts.today_total} delta={`${stats.alerts.resolved_today} resolved today`} icon={<AlertTriangle size={16} />} />
        <Stat label="Engine cuts active" value={stats.engine_cuts_active} delta="Bikes remotely immobilised" icon={<Zap size={16} />} accent={stats.engine_cuts_active ? 'var(--warn)' : undefined} />
      </div>

      <div className="grid grid-4 mb-4">
        <Stat label="Trips today" value={stats.trips.today_trips} delta={`${stats.trips.week_trips} this week`} icon={<Route size={16} />} />
        <Stat label="Distance today" value={`${stats.trips.today_km.toFixed(0)} km`} delta={`${stats.trips.week_km.toFixed(0)} km this week`} icon={<Gauge size={16} />} />
        <Stat label="Needs attention" value={needsAttention.length} delta="Offline, low battery, weak signal…" icon={<BatteryWarning size={16} />} accent={needsAttention.length ? 'var(--warn)' : 'var(--success)'} />
        <Stat label="Stolen bikes" value={stats.stolen_bikes} delta="Flagged in the fleet" icon={<MapPinOff size={16} />} accent={stats.stolen_bikes ? 'var(--danger)' : 'var(--success)'} />
      </div>

      <div className="grid grid-2 mb-4">
        <div className="card">
          <div className="card-title"><h3>Alerts today by type</h3></div>
          {alertsChartData.length === 0
            ? <div className="muted text-sm">No alerts fired today.</div>
            : (
              <ResponsiveContainer width="100%" height={Math.max(160, alertsChartData.length * 34)}>
                <BarChart data={alertsChartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={170} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {alertsChartData.map((row, i) => <Cell key={i} fill={row.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        <div className="card">
          <div className="card-title"><h3>Highest risk bikes</h3></div>
          {stats.top_risk_bikes.length === 0
            ? <div className="muted text-sm">No bikes currently flagged above normal risk.</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {stats.top_risk_bikes.map((r) => (
                  <Link key={r.bike_id} to={`/admin/tracking?bike=${r.bike_id}`} className="row" style={{
                    justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8,
                    background: 'var(--surface-2)', textDecoration: 'none', color: 'inherit',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{r.registration || `Bike #${r.bike_id}`}</div>
                      <div className="muted text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(r.reasons || []).slice(0, 2).join(', ') || '—'}</div>
                    </div>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, color: '#fff',
                      background: RISK_LEVEL_COLOR[r.level] || '#94a3b8', textTransform: 'capitalize', flexShrink: 0,
                    }}>{r.level} · {r.score}</span>
                  </Link>
                ))}
              </div>
            )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h3>Devices needing attention</h3>
          <Link to="/admin/tracking" className="text-sm">Open Health tab →</Link>
        </div>
        {needsAttention.length === 0
          ? <div className="muted text-sm">Every device looks healthy.</div>
          : (
            <div className="grid grid-2" style={{ gap: 8 }}>
              {needsAttention.map((h) => (
                <AttentionRow
                  key={h.device.id}
                  to={h.device.bike_id ? `/admin/tracking?bike=${h.device.bike_id}` : '/admin/tracking'}
                  title={h.device.registration || h.device.label || h.device.imei}
                  subtitle={h.reasons.map(healthReasonText).join(' · ')}
                  dotColor={HEALTH_SEVERITY_COLOR[h.reasons[0]?.severity] || '#94a3b8'}
                />
              ))}
            </div>
          )}
      </div>

      {drill && (
        <Modal onClose={() => setDrill(null)} title={drill.title}>
          <div className="text-sm muted" style={{ marginBottom: 14 }}>{drill.note}</div>
          {!drill.devices.length && <div className="text-sm muted">Nothing here — nothing to do.</div>}
          {drill.devices.map((d) => (
            <Link
              key={d.id}
              to={d.bike_id ? `/admin/tracking?bike=${d.bike_id}` : '/admin/tracking'}
              onClick={() => setDrill(null)}
              className="row"
              style={{
                justifyContent: 'space-between', alignItems: 'center', gap: 12,
                padding: '9px 10px', borderRadius: 8, marginBottom: 6,
                background: 'var(--surface-2)', textDecoration: 'none', color: 'inherit',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {d.registration || d.label || 'Not linked to a bike'}
                </div>
                <div className="muted text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.imei}{d.model ? ` · ${d.model}` : ''}
                </div>
              </div>
              <div className="muted text-xs" style={{ textAlign: 'right', flexShrink: 0 }}>
                {d.minutes_since_ping == null ? 'never seen' : lastSeenText(d.minutes_since_ping)}
              </div>
            </Link>
          ))}
          <div className="text-xs muted" style={{ marginTop: 10 }}>
            {drill.devices.length} tracker{drill.devices.length === 1 ? '' : 's'} · choose one to open it on the map
          </div>
        </Modal>
      )}
    </>
  );
}

// Minutes since the last ping, read the way somebody would say it out loud.
function lastSeenText(minutes) {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

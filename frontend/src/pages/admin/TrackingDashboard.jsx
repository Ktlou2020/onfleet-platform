import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { Radio, ShieldAlert, Bell, Zap, Route, Gauge, AlertTriangle, WifiOff, BatteryWarning, MapPinOff, RefreshCw } from 'lucide-react';
import api from '../../api';
import { Stat, Loading } from '../../components/ui';
import { ALERT_LABELS, ALERT_COLORS } from '../../lib/alertMeta';
import { computeDeviceHealth } from '../../lib/trackingHelpers';

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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [statsRes, devicesRes, mapRes] = await Promise.all([
        api.get('/tracking/dashboard'),
        api.get('/tracking/devices'),
        api.get('/tracking/map'),
      ]);
      setStats(statsRes.data);
      setDevices(devicesRes.data);
      setMapDevices(mapRes.data);
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
          delta={coverageGap > 0 ? `${coverageGap} bike${coverageGap === 1 ? '' : 's'} without a tracker` : 'Full fleet covered'}
          icon={<Radio size={16} />} accent={coverageGap > 0 ? 'var(--danger)' : 'var(--success)'}
        />
        <Stat label="Online now" value={stats.devices.active} delta={`${stats.devices.total} devices total`} icon={<Zap size={16} />} accent="var(--success)" />
        <Stat label="Sleeping" value={stats.devices.sleeping} delta="Idle 10min–1hr" icon={<Radio size={16} />} accent="var(--warn)" />
        <Stat label="Offline" value={stats.devices.offline} delta={`${stats.devices.never_connected} never connected`} icon={<WifiOff size={16} />} accent={stats.devices.offline ? 'var(--danger)' : 'var(--success)'} />
      </div>

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
                  subtitle={h.reasons.map((r) => r.text).join(' · ')}
                  dotColor={HEALTH_SEVERITY_COLOR[h.reasons[0]?.severity] || '#94a3b8'}
                />
              ))}
            </div>
          )}
      </div>
    </>
  );
}

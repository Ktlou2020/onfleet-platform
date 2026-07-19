import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Wifi, WifiOff, Zap, ZapOff, Bell, BellOff, RefreshCw,
  Navigation, Gauge, Satellite, AlertCircle, Layers, Maximize2,
  Signal, SignalZero, SignalLow, SignalMedium, SignalHigh,
  Battery, BatteryLow, BatteryMedium, BatteryFull, X,
  CheckCircle, Clock, Route, Activity,
} from 'lucide-react';
import api from '../../api';
import toast from 'react-hot-toast';
import { canManageFleetSection } from './access';
import { useAuth } from '../../auth';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
  shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
});

let _pulseCSSInjected = false;
function ensurePulseCSS() {
  if (_pulseCSSInjected) return;
  _pulseCSSInjected = true;
  const s = document.createElement('style');
  s.textContent = `@keyframes gps-pulse{0%{transform:translate(-50%,-50%) scale(.5);opacity:.8}100%{transform:translate(-50%,-50%) scale(2.8);opacity:0}}.gps-pulse-ring{position:absolute;top:50%;left:50%;width:14px;height:14px;border-radius:50%;animation:gps-pulse 1.8s ease-out infinite;}`;
  document.head.appendChild(s);
}

function makeIcon(color, pulse = false) {
  ensurePulseCSS();
  const ring = pulse ? `<div class="gps-pulse-ring" style="background:${color};"></div>` : '';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:14px;height:14px;">${ring}<div style="position:absolute;inset:0;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,.9);box-shadow:0 1px 6px rgba(0,0,0,.55);"></div></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function speedColor(kmh) {
  const s = Number(kmh) || 0;
  if (s < 5)  return '#94a3b8';
  if (s < 30) return '#22c55e';
  if (s < 70) return '#f97316';
  return '#ef4444';
}

const TILES = {
  street:    { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap' },
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: '© Esri' },
};

const ALERT_TYPE_LABELS = {
  speeding: 'Speeding', harsh_acceleration: 'Harsh accel', harsh_braking: 'Harsh brake',
  harsh_cornering: 'Cornering', panic: 'Panic', geofence_exit: 'Geofence exit',
  geofence_entry: 'Geofence entry', power_disconnect: 'Power cut', movement: 'Movement',
  idle_too_long: 'Idle too long', tamper: 'Tamper',
};

function getBatteryIcon(mV) {
  const v = Number(mV) || 0;
  if (v === 0) return <Battery size={13} style={{ color: 'var(--muted)' }} />;
  if (v < 3600) return <BatteryLow size={13} style={{ color: 'var(--danger)' }} />;
  if (v < 3800) return <BatteryMedium size={13} style={{ color: '#f59e0b' }} />;
  return <BatteryFull size={13} style={{ color: 'var(--success)' }} />;
}

function getSignalIcon(bars) {
  const b = Number(bars) || 0;
  if (b === 0) return <SignalZero size={13} style={{ color: 'var(--muted)' }} />;
  if (b <= 1)  return <SignalLow size={13} style={{ color: 'var(--danger)' }} />;
  if (b <= 2)  return <SignalMedium size={13} style={{ color: '#f59e0b' }} />;
  return <SignalHigh size={13} style={{ color: 'var(--success)' }} />;
}

function parseIOField(ioData, key) {
  if (!ioData) return null;
  try {
    const d = typeof ioData === 'string' ? JSON.parse(ioData) : ioData;
    return d[key] ?? null;
  } catch { return null; }
}

function FitBounds({ devices }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    const pts = devices.filter(d => d.lat && d.lng).map(d => [d.lat, d.lng]);
    if (pts.length > 0) {
      map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      fitted.current = true;
    }
  }, [devices, map]);
  return null;
}

function SpeedTrail({ trail }) {
  if (!trail || trail.length < 2) return null;
  const segments = [];
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    if (a.lat && a.lng && b.lat && b.lng) {
      segments.push({ positions: [[a.lat, a.lng], [b.lat, b.lng]], color: speedColor(b.speed_kmh) });
    }
  }
  return segments.map((s, i) => <Polyline key={i} positions={s.positions} color={s.color} weight={3} opacity={0.85} />);
}

export default function FleetTracking() {
  const { user } = useAuth();
  const canManage = canManageFleetSection(user?.role, 'tracking');

  const [devices, setDevices] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [trail, setTrail] = useState([]);
  const [commands, setCommands] = useState([]);
  const [cmdBusy, setCmdBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [tileMode, setTileMode] = useState('street');
  const [tab, setTab] = useState('devices'); // devices | alerts
  const [detailTab, setDetailTab] = useState('controls'); // controls | history
  const [trailRange, setTrailRange] = useState('1h');
  const sseRef = useRef(null);

  const loadDevices = useCallback(async () => {
    const { data } = await api.get('/fleet/tracking/map');
    setDevices(data);
  }, []);

  const loadAlerts = useCallback(async () => {
    const { data } = await api.get('/fleet/tracking/alerts?limit=100');
    setAlerts(data);
  }, []);

  useEffect(() => {
    Promise.all([loadDevices(), loadAlerts()]).finally(() => setLoading(false));

    const connect = () => {
      const token = localStorage.getItem('fleet_token') || localStorage.getItem('token');
      const url = `/api/fleet/tracking/live${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const es = new EventSource(url);
      sseRef.current = es;
      es.addEventListener('ping', (e) => {
        try {
          const p = JSON.parse(e.data);
          setDevices(prev => prev.map(d => d.bike_id === p.bike_id ? { ...d, lat: p.lat, lng: p.lng, speed_kmh: p.speed_kmh, heading: p.heading, ignition: p.ignition, satellites: p.satellites, altitude: p.altitude, io_data: p.io_data, connected: 1, last_location_at: p.recorded_at } : d));
          setTrail(prev => prev.length > 0 && prev[0].bike_id === p.bike_id ? [...prev, p] : prev);
        } catch (_) {}
      });
      es.addEventListener('alert', (e) => {
        try { setAlerts(prev => [JSON.parse(e.data), ...prev].slice(0, 100)); } catch (_) {}
      });
      es.onerror = () => { es.close(); setTimeout(connect, 5000); };
    };
    connect();
    const poll = setInterval(loadDevices, 30_000);
    return () => { sseRef.current?.close(); clearInterval(poll); };
  }, [loadDevices]);

  async function loadTrail(bikeId, range) {
    const now = new Date();
    const offsets = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
    const from = new Date(now.getTime() - (offsets[range] || 1) * 3600_000).toISOString();
    try {
      const { data: dev } = await api.get('/fleet/tracking/devices');
      const device = dev.find(d => d.bike_id === bikeId);
      if (!device) return;
      const { data } = await api.get(`/fleet/tracking/devices/${device.id}/positions?limit=500&from=${encodeURIComponent(from)}`);
      setTrail(data.map(p => ({ ...p, bike_id: bikeId })));
    } catch (_) {}
  }

  async function loadCommands(deviceId) {
    const { data } = await api.get(`/fleet/tracking/devices/${deviceId}/commands`);
    setCommands(data);
  }

  async function selectDevice(device) {
    setSelected(device);
    setDetailTab('controls');
    await loadTrail(device.bike_id, trailRange);
    const devList = (await api.get('/fleet/tracking/devices')).data;
    const d = devList.find(x => x.bike_id === device.bike_id);
    if (d) loadCommands(d.id);
  }

  async function sendCommand(preset, label) {
    if (!selected || !canManage) return;
    const devList = (await api.get('/fleet/tracking/devices')).data;
    const device = devList.find(d => d.bike_id === selected.bike_id);
    if (!device) { toast.error('Device not found'); return; }
    if (preset === 'cut_engine' && !window.confirm(`Cut the engine on ${selected.registration}? The rider will be unable to start the bike.`)) return;
    setCmdBusy(preset);
    try {
      const { data } = await api.post(`/fleet/tracking/devices/${device.id}/commands`, { preset });
      toast.success(`${label}: ${data.status === 'sent' ? 'command sent' : 'queued — device offline'}`);
      loadCommands(device.id);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Command failed');
    } finally { setCmdBusy(''); }
  }

  async function ackAlert(id) {
    await api.put(`/fleet/tracking/alerts/${id}/acknowledge`);
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged_at: new Date().toISOString() } : a));
  }

  async function ackAll() {
    await api.post('/fleet/tracking/alerts/acknowledge-all');
    setAlerts(prev => prev.map(a => ({ ...a, acknowledged_at: a.acknowledged_at || new Date().toISOString() })));
  }

  const unackedCount = alerts.filter(a => !a.acknowledged_at).length;
  const onlineCount = devices.filter(d => d.connected).length;

  function deviceColor(d) {
    if (!d.connected) return '#94a3b8';
    if (d.ignition) return '#22c55e';
    return '#f97316';
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }} className="muted">Loading GPS tracking…</div>;

  if (devices.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div className="muted" style={{ marginBottom: 8 }}>No GPS trackers are linked to your bikes yet.</div>
        <p className="text-sm muted">Contact OnFleet to have devices installed and allocated to your fleet.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)', overflow: 'hidden', margin: '-24px' }}>

      {/* ── Left sidebar ── */}
      <div style={{ width: 260, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ borderBottom: '1px solid var(--border)', display: 'flex' }}>
          <button
            onClick={() => setTab('devices')}
            style={{ flex: 1, padding: '10px 0', fontSize: 12, fontWeight: 600, background: tab === 'devices' ? 'var(--primary)' : 'transparent', color: tab === 'devices' ? '#fff' : 'var(--muted)', border: 'none', cursor: 'pointer' }}>
            Bikes ({devices.length})
          </button>
          <button
            onClick={() => { setTab('alerts'); loadAlerts(); }}
            style={{ flex: 1, padding: '10px 0', fontSize: 12, fontWeight: 600, background: tab === 'alerts' ? 'var(--primary)' : 'transparent', color: tab === 'alerts' ? '#fff' : 'var(--muted)', border: 'none', cursor: 'pointer', position: 'relative' }}>
            Alerts
            {unackedCount > 0 && <span style={{ position: 'absolute', top: 6, right: 12, background: 'var(--danger)', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 5px' }}>{unackedCount}</span>}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {tab === 'devices' && devices.map(d => (
            <div key={d.id}
              onClick={() => selectDevice(d)}
              style={{ padding: '10px 10px', borderRadius: 10, marginBottom: 4, cursor: 'pointer', background: selected?.bike_id === d.bike_id ? 'var(--primary)' : 'var(--surface-2)', transition: 'background 0.15s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                {d.connected ? <Wifi size={12} style={{ color: selected?.bike_id === d.bike_id ? '#fff' : '#22c55e', flexShrink: 0 }} /> : <WifiOff size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                <span style={{ fontWeight: 700, fontSize: 12, color: selected?.bike_id === d.bike_id ? '#fff' : 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.registration || d.label || d.imei}
                </span>
              </div>
              <div style={{ fontSize: 11, color: selected?.bike_id === d.bike_id ? 'rgba(255,255,255,0.75)' : 'var(--muted)', display: 'flex', gap: 8 }}>
                {d.bike_model && <span>{d.make} {d.bike_model}</span>}
                {d.ignition ? <span style={{ color: selected?.bike_id === d.bike_id ? '#bbf7d0' : '#22c55e' }}><Zap size={10} style={{ display: 'inline' }} /> On</span> : <span><ZapOff size={10} style={{ display: 'inline' }} /> Off</span>}
                {d.speed_kmh > 0 && <span>{Math.round(d.speed_kmh)} km/h</span>}
              </div>
              {d.rider_name && <div style={{ fontSize: 10, color: selected?.bike_id === d.bike_id ? 'rgba(255,255,255,0.6)' : 'var(--muted)', marginTop: 2 }}>{d.rider_name}</div>}
            </div>
          ))}

          {tab === 'alerts' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                {canManage && unackedCount > 0 && (
                  <button className="btn btn-secondary btn-sm" onClick={ackAll} style={{ fontSize: 11 }}>
                    <BellOff size={11} /> Ack all
                  </button>
                )}
              </div>
              {alerts.length === 0 && <div className="muted text-sm" style={{ textAlign: 'center', paddingTop: 24 }}>No alerts</div>}
              {alerts.map(a => (
                <div key={a.id} style={{ padding: '8px 10px', borderRadius: 10, marginBottom: 4, background: 'var(--surface-2)', opacity: a.acknowledged_at ? 0.55 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 12 }}>{ALERT_TYPE_LABELS[a.alert_type] || a.alert_type}</div>
                      <div className="text-xs muted">{a.bike_registration}</div>
                      <div className="text-xs muted">{new Date(a.created_at).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })}</div>
                    </div>
                    {canManage && !a.acknowledged_at && (
                      <button onClick={() => ackAlert(a.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2 }} title="Acknowledge">
                        <CheckCircle size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px', fontSize: 11, color: 'var(--muted)' }}>
          {onlineCount} of {devices.length} online
        </div>
      </div>

      {/* ── Map ── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <MapContainer center={[-26.2, 28.0]} zoom={10} style={{ height: '100%', width: '100%' }}>
          <TileLayer key={tileMode} url={TILES[tileMode].url} attribution={TILES[tileMode].attribution} />
          <FitBounds devices={devices} />
          <SpeedTrail trail={trail} />
          {devices.filter(d => d.lat && d.lng).map(d => (
            <Marker
              key={d.bike_id}
              position={[d.lat, d.lng]}
              icon={makeIcon(deviceColor(d), !!(d.connected && d.ignition && d.speed_kmh > 5))}>
              <Popup>
                <div style={{ fontSize: 13, minWidth: 160 }}>
                  <strong>{d.registration}</strong><br />
                  {d.make} {d.bike_model}<br />
                  {d.rider_name && <><span className="muted">Rider:</span> {d.rider_name}<br /></>}
                  {d.speed_kmh > 0 && <><span className="muted">Speed:</span> {Math.round(d.speed_kmh)} km/h<br /></>}
                  <button className="btn btn-sm" style={{ marginTop: 8, width: '100%' }} onClick={() => selectDevice(d)}>View details</button>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>

        {/* Map controls */}
        <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            onClick={() => setTileMode(m => m === 'street' ? 'satellite' : 'street')}
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title={tileMode === 'street' ? 'Switch to satellite' : 'Switch to street'}>
            <Layers size={16} />
          </button>
          <button
            onClick={() => loadDevices().then()}
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* ── Right detail panel ── */}
      {selected && (
        <div style={{ width: 300, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
          {/* Header */}
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{selected.registration}</div>
                <div className="text-xs muted">{selected.make} {selected.bike_model} {selected.bike_year ? `· ${selected.bike_year}` : ''}</div>
              </div>
              <button onClick={() => { setSelected(null); setTrail([]); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={16} /></button>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              {['controls', 'history'].map(t => (
                <button key={t} onClick={() => setDetailTab(t)} style={{ flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600, background: detailTab === t ? 'var(--primary)' : 'var(--surface-2)', color: detailTab === t ? '#fff' : 'var(--muted)', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                  {t === 'controls' ? 'Controls' : 'History'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {detailTab === 'controls' && (
              <>
                {/* Live telemetry */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
                  {[
                    { label: 'Speed', value: selected.speed_kmh > 0 ? `${Math.round(selected.speed_kmh)} km/h` : '— km/h', icon: <Gauge size={13} /> },
                    { label: 'Heading', value: selected.heading != null ? `${selected.heading}°` : '—', icon: <Navigation size={13} /> },
                    { label: 'Satellites', value: selected.satellites ?? '—', icon: <Satellite size={13} /> },
                    { label: 'Ignition', value: selected.ignition ? 'ON' : 'OFF', icon: selected.ignition ? <Zap size={13} style={{ color: '#22c55e' }} /> : <ZapOff size={13} style={{ color: 'var(--muted)' }} /> },
                  ].map(item => (
                    <div key={item.label} className="card" style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', marginBottom: 2 }}>{item.icon}<span style={{ fontSize: 10 }}>{item.label}</span></div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{item.value}</div>
                    </div>
                  ))}
                </div>

                {/* Signal / battery */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 16, fontSize: 12, color: 'var(--muted)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {getSignalIcon(parseIOField(selected.io_data, 21))}
                    GSM {parseIOField(selected.io_data, 21) ?? '—'}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {getBatteryIcon(parseIOField(selected.io_data, 67))}
                    {parseIOField(selected.io_data, 67) ? `${Math.round(parseIOField(selected.io_data, 67) / 1000 * 10) / 10}V` : '—'}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                    {selected.connected ? <Wifi size={12} style={{ color: '#22c55e' }} /> : <WifiOff size={12} style={{ color: 'var(--muted)' }} />}
                    {selected.connected ? 'Online' : 'Offline'}
                  </span>
                </div>

                {selected.rider_name && (
                  <div className="card" style={{ padding: '10px 12px', marginBottom: 16 }}>
                    <div className="text-xs muted" style={{ marginBottom: 4 }}>Current rider</div>
                    <div style={{ fontWeight: 600 }}>{selected.rider_name}</div>
                    {selected.rider_phone && <div className="text-xs muted">{selected.rider_phone}</div>}
                  </div>
                )}

                {/* Trail range */}
                <div style={{ marginBottom: 16 }}>
                  <div className="text-xs muted" style={{ marginBottom: 6 }}>Trail history</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {['1h', '6h', '24h', '7d'].map(r => (
                      <button key={r} onClick={() => { setTrailRange(r); loadTrail(selected.bike_id, r); }}
                        style={{ flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600, background: trailRange === r ? 'var(--primary)' : 'var(--surface-2)', color: trailRange === r ? '#fff' : 'var(--muted)', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Engine controls */}
                {canManage && (
                  <div style={{ marginBottom: 16 }}>
                    <div className="text-xs muted" style={{ marginBottom: 8 }}>Engine control</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-sm" style={{ flex: 1, background: 'var(--danger)', fontSize: 12 }} disabled={!!cmdBusy} onClick={() => sendCommand('cut_engine', 'Cut engine')}>
                        <ZapOff size={13} /> {cmdBusy === 'cut_engine' ? 'Sending…' : 'Cut engine'}
                      </button>
                      <button className="btn btn-sm btn-secondary" style={{ flex: 1, fontSize: 12 }} disabled={!!cmdBusy} onClick={() => sendCommand('restore_engine', 'Restore engine')}>
                        <Zap size={13} /> {cmdBusy === 'restore_engine' ? 'Sending…' : 'Restore'}
                      </button>
                    </div>
                    <div className="text-xs muted" style={{ marginTop: 6 }}>Cutting the engine prevents the bike from starting. The rider will not receive a notification.</div>
                  </div>
                )}

                {/* Diagnostics */}
                {canManage && (
                  <div>
                    <div className="text-xs muted" style={{ marginBottom: 8 }}>Diagnostics</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {[
                        { preset: 'get_status', label: 'Status' },
                        { preset: 'get_info', label: 'Device info' },
                      ].map(({ preset, label }) => (
                        <button key={preset} className="btn btn-secondary btn-sm" style={{ fontSize: 11 }} disabled={!!cmdBusy} onClick={() => sendCommand(preset, label)}>
                          <Activity size={11} /> {cmdBusy === preset ? '…' : label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {detailTab === 'history' && (
              <div>
                <div className="text-xs muted" style={{ marginBottom: 10 }}>Last 50 commands</div>
                {commands.length === 0 && <div className="muted text-sm">No commands sent yet.</div>}
                {commands.map(c => (
                  <div key={c.id} style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)', marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{c.command}</code>
                      {c.sent_at ? <CheckCircle size={12} style={{ color: 'var(--success)', flexShrink: 0 }} /> : <Clock size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                    </div>
                    {c.response && <div className="text-xs muted" style={{ marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all' }}>{c.response}</div>}
                    <div className="text-xs muted" style={{ marginTop: 4 }}>{c.created_by_name} · {new Date(c.created_at).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

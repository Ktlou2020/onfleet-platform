import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Wifi, WifiOff, Zap, ZapOff, Radio, Info, RefreshCw, Plus, Trash2,
  CheckCircle, Clock, XCircle, AlertCircle, X, Search, Layers,
  Maximize2, Navigation, Gauge, Mountain, MapPin, Activity,
} from 'lucide-react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
  shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
});

// Pulsing marker animation (injected once)
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

function deviceIcon(d) {
  if (!d.connected) return makeIcon('#94a3b8');
  const moving = (Number(d.speed_kmh) || 0) > 5;
  return d.ignition ? makeIcon('#22c55e', moving) : makeIcon('#f97316');
}

function FlyTo({ position }) {
  const map = useMap();
  useEffect(() => { if (position) map.flyTo(position, 15, { duration: 1.2 }); }, [position, map]);
  return null;
}

function FitBounds({ trigger, positions }) {
  const map = useMap();
  const posRef = useRef(positions);
  posRef.current = positions;
  useEffect(() => {
    if (!trigger || !posRef.current.length) return;
    map.fitBounds(L.latLngBounds(posRef.current), { padding: [50, 50], maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, map]);
  return null;
}

function SpeedTrail({ positions }) {
  if (positions.length < 2) return null;
  const segments = [];
  let color = speedColor(positions[0].speed_kmh);
  let seg = [[positions[0].lat, positions[0].lng]];
  for (let i = 1; i < positions.length; i++) {
    const c = speedColor(positions[i].speed_kmh);
    seg.push([positions[i].lat, positions[i].lng]);
    if (c !== color) {
      if (seg.length > 1) segments.push({ pts: seg, color });
      color = c;
      seg = [[positions[i].lat, positions[i].lng]];
    }
  }
  if (seg.length > 1) segments.push({ pts: seg, color });
  return <>{segments.map((s, i) => <Polyline key={i} positions={s.pts} color={s.color} weight={3} opacity={0.85} />)}</>;
}

const TILES = {
  street:    { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',                                                         attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>' },
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: '&copy; Esri' },
};

const TRAIL_RANGES = [
  { id: '1h',  label: '1 h',   hours: 1 },
  { id: '6h',  label: '6 h',   hours: 6 },
  { id: '24h', label: '24 h',  hours: 24 },
  { id: '7d',  label: '7 d',   hours: 168 },
];

const ENGINE_CMDS = [
  { id: 'cut_engine',     label: 'Cut engine',     desc: 'Disable ignition',  icon: ZapOff, danger: true },
  { id: 'restore_engine', label: 'Restore engine', desc: 'Re-enable ignition', icon: Zap,   danger: false },
];
const DIAG_CMDS = [
  { id: 'get_status',   label: 'Status',      icon: Info },
  { id: 'get_info',     label: 'Device info', icon: Info },
  { id: 'get_ver',      label: 'Firmware',    icon: Info },
  { id: 'fota_connect', label: 'FOTA update', icon: Radio },
];
const MODELS = [
  { value: 'FMB920', label: 'FMB920 — standard GPS tracker' },
  { value: 'FMB965', label: 'FMB965 — advanced tracker (LTE)' },
  { value: 'FMC920', label: 'FMC920 — compact 4G tracker' },
  { value: 'other',  label: 'Other model' },
];
const STATUS_ICON = {
  pending:   <Clock size={12} style={{ color: '#f97316' }} />,
  sent:      <Clock size={12} style={{ color: '#4FA8E0' }} />,
  delivered: <CheckCircle size={12} style={{ color: '#22c55e' }} />,
  failed:    <XCircle size={12} style={{ color: '#ef4444' }} />,
};
const EMPTY_FORM = { imei: '', model: 'FMB920', bike_id: '', label: '' };

async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, { headers: { 'Accept-Language': 'en' } });
    const j = await r.json();
    return j.display_name?.split(',').slice(0, 3).join(', ') || null;
  } catch { return null; }
}

export default function Tracking() {
  const [devices,      setDevices]      = useState([]);
  const [mapDevices,   setMapDevices]   = useState([]);
  const [selected,     setSelected]     = useState(null);
  const [trail,        setTrail]        = useState([]);
  const [commands,     setCommands]     = useState([]);
  const [flyTo,        setFlyTo]        = useState(null);
  const [fitTrigger,   setFitTrigger]   = useState(0);
  const [loading,      setLoading]      = useState(true);
  const [showAdd,      setShowAdd]      = useState(false);
  const [bikes,        setBikes]        = useState([]);
  const [addForm,      setAddForm]      = useState(EMPTY_FORM);
  const [adding,       setAdding]       = useState(false);
  const [sendingCmd,   setSendingCmd]   = useState(null);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [tileMode,     setTileMode]     = useState('street');
  const [trailRange,   setTrailRange]   = useState('6h');
  const [address,      setAddress]      = useState(null);
  const [sseOnline,    setSseOnline]    = useState(false);
  const selectedRef = useRef(null);
  const mountedRef = useRef(true);
  const geocodeVersionRef = useRef(0);

  // Keep selectedRef in sync for SSE handler (avoids stale closure)
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Remove .content padding for edge-to-edge layout
  useEffect(() => {
    const el = document.querySelector('.content');
    if (!el) return;
    const prev = { padding: el.style.padding, overflow: el.style.overflow };
    el.style.padding = '0';
    el.style.overflow = 'hidden';
    return () => { el.style.padding = prev.padding; el.style.overflow = prev.overflow; };
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const [{ data: devs }, { data: map }] = await Promise.all([
        api.get('/tracking/devices'),
        api.get('/tracking/map'),
      ]);
      setDevices(devs);
      setMapDevices(map);
    } catch { /* silent */ }
  }, []);

  const loadBikes = useCallback(async () => {
    try {
      const { data } = await api.get('/bikes?limit=500');
      setBikes(data.bikes || data || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadDevices(), loadBikes()]).finally(() => setLoading(false));
  }, [loadDevices, loadBikes]);

  // SSE real-time feed
  useEffect(() => {
    let abort = new AbortController();
    let retryTimer;

    async function connect() {
      try {
        const token = localStorage.getItem('of_token');
        const res = await fetch('/api/tracking/live', {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        if (!res.ok) { scheduleRetry(); return; }
        setSseOnline(true);

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const chunks = buf.split('\n\n');
          buf = chunks.pop() || '';
          for (const chunk of chunks) {
            let evtType = 'message';
            const dataLines = [];
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) evtType = line.slice(6).trim();
              else if (line.startsWith('data:'))  dataLines.push(line.slice(5).trim());
            }
            if (!dataLines.length) continue;
            try {
              const p = JSON.parse(dataLines.join(''));
              if (evtType === 'ping' && mountedRef.current) {
                setMapDevices(prev => {
                  const idx = prev.findIndex(d => d.id === p.device_id);
                  if (idx === -1) return prev;
                  const next = [...prev];
                  next[idx] = { ...next[idx], lat: p.lat, lng: p.lng, speed_kmh: p.speed, heading: p.heading, altitude: p.altitude, satellites: p.satellites, ignition: p.ignition, last_location_at: new Date(p.ts).toISOString(), connected: 1 };
                  return next;
                });
                if (selectedRef.current === p.device_id) {
                  setTrail(t => {
                    const pt = { lat: p.lat, lng: p.lng, speed_kmh: p.speed };
                    if (t.length && t[t.length - 1].lat === pt.lat && t[t.length - 1].lng === pt.lng) return t;
                    return [...t, pt];
                  });
                }
              }
            } catch { /* ignore parse errors */ }
          }
        }
        if (mountedRef.current) setSseOnline(false);
        if (mountedRef.current) scheduleRetry();
      } catch (err) {
        if (mountedRef.current) setSseOnline(false);
        if (err.name !== 'AbortError' && mountedRef.current) scheduleRetry();
      }
    }

    function scheduleRetry() { retryTimer = setTimeout(connect, 5_000); }

    connect();
    return () => { abort.abort(); clearTimeout(retryTimer); setSseOnline(false); };
  }, []);

  const loadTrail = useCallback(async (deviceId, range) => {
    const hours = TRAIL_RANGES.find(r => r.id === range)?.hours || 6;
    const from = new Date(Date.now() - hours * 3_600_000).toISOString();
    try {
      const { data } = await api.get(`/tracking/devices/${deviceId}/positions?limit=500&from=${encodeURIComponent(from)}`);
      setTrail(data.map(p => ({ lat: p.lat, lng: p.lng, speed_kmh: p.speed_kmh })));
    } catch { /* silent */ }
  }, []);

  const selectDevice = useCallback(async (device) => {
    setSelected(device.id);
    setAddress(null);
    if (device.lat && device.lng) {
      setFlyTo([device.lat, device.lng]);
      const version = ++geocodeVersionRef.current;
      reverseGeocode(device.lat, device.lng).then(addr => {
        if (mountedRef.current && geocodeVersionRef.current === version) setAddress(addr);
      });
    }
    try {
      const [, { data: cmds }] = await Promise.all([
        loadTrail(device.id, trailRange),
        api.get(`/tracking/devices/${device.id}/commands`),
      ]);
      setCommands(cmds);
    } catch { /* silent */ }
  }, [loadTrail, trailRange]);

  // Reload trail when range changes (if a device is selected)
  useEffect(() => {
    if (selected) loadTrail(selected, trailRange);
  }, [trailRange, selected, loadTrail]);

  const refreshCommands = useCallback(async () => {
    if (!selected) return;
    try {
      const { data } = await api.get(`/tracking/devices/${selected}/commands`);
      setCommands(data);
    } catch { /* silent */ }
  }, [selected]);

  const sendPreset = useCallback(async (presetId) => {
    if (!selected) return;
    if (presetId === 'cut_engine') {
      const dev = devices.find(d => d.id === selected);
      if (!window.confirm(`Cut the engine on ${dev?.label || dev?.registration || 'this device'}?\nThe rider will lose ignition power.`)) return;
    }
    setSendingCmd(presetId);
    try {
      const { data } = await api.post(`/tracking/devices/${selected}/commands`, { preset: presetId });
      toast.success(data.note || 'Command queued');
      await refreshCommands();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send command');
    } finally {
      setSendingCmd(null);
    }
  }, [selected, devices, refreshCommands]);

  const addDevice = useCallback(async () => {
    const imei = addForm.imei.trim();
    if (!imei) return toast.error('IMEI is required');
    if (!/^\d{15,17}$/.test(imei)) return toast.error('IMEI must be 15–17 digits');
    setAdding(true);
    try {
      await api.post('/tracking/devices', { ...addForm, imei, bike_id: addForm.bike_id || null });
      toast.success('Device registered');
      setShowAdd(false);
      setAddForm(EMPTY_FORM);
      await loadDevices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to register device');
    } finally {
      setAdding(false);
    }
  }, [addForm, loadDevices]);

  const deleteDevice = useCallback(async (e, id) => {
    e.stopPropagation();
    const dev = devices.find(d => d.id === id);
    if (!window.confirm(`Remove ${dev?.label || dev?.imei}?`)) return;
    try {
      await api.delete(`/tracking/devices/${id}`);
      if (selected === id) { setSelected(null); setTrail([]); setCommands([]); setAddress(null); }
      await loadDevices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  }, [selected, devices, loadDevices]);

  const selectedDevice    = devices.find(d => d.id === selected);
  const selectedMapDevice = mapDevices.find(d => d.id === selected);
  const allPositions      = mapDevices.filter(d => d.lat && d.lng).map(d => [d.lat, d.lng]);

  const filteredDevices = deviceSearch
    ? devices.filter(d => [d.label, d.imei, d.registration, d.model].some(v => String(v || '').toLowerCase().includes(deviceSearch.toLowerCase())))
    : devices;

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - 64px)' }}>
      <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading tracking…</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)', overflow: 'hidden' }}>

      {/* ── Device sidebar ──────────────────────────────────────────── */}
      <div style={{ width: 272, minWidth: 272, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--surface-2)' }}>

        {/* Header */}
        <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>GPS Devices</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: sseOnline ? '#22c55e' : '#94a3b8', flexShrink: 0 }} title={sseOnline ? 'Live feed active' : 'Reconnecting…'} />
              <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>{sseOnline ? 'LIVE' : 'offline'}</span>
            </div>
            <button className="btn btn-sm btn-secondary" title="Refresh" onClick={loadDevices}><RefreshCw size={12} /></button>
            <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(true)}><Plus size={12} /> Add</button>
          </div>
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
            <input
              value={deviceSearch}
              onChange={e => setDeviceSearch(e.target.value)}
              placeholder="Search devices…"
              style={{ width: '100%', paddingLeft: 26, paddingRight: 8, fontSize: 12, height: 30, boxSizing: 'border-box' }}
            />
          </div>
        </div>

        {/* Device list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filteredDevices.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              {devices.length === 0 ? (
                <>
                  <div style={{ fontSize: 36, marginBottom: 10 }}>📡</div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>No trackers yet</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>Register a Teltonika device to start tracking bikes</div>
                  <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(true)}><Plus size={12} /> Register device</button>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No devices match "{deviceSearch}"</div>
              )}
            </div>
          ) : filteredDevices.map(d => {
            const isSelected = d.id === selected;
            const mapD = mapDevices.find(m => m.id === d.id);
            const kmh = Number(mapD?.speed_kmh) || 0;
            return (
              <div
                key={d.id}
                onClick={() => selectDevice(mapD || d)}
                style={{
                  padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                  borderLeft: `3px solid ${isSelected ? 'var(--primary)' : 'transparent'}`,
                  background: isSelected ? 'rgba(30,136,209,.08)' : 'transparent',
                  transition: 'background 0.12s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {d.connected ? <Wifi size={12} color="#22c55e" /> : <WifiOff size={12} color="#94a3b8" />}
                  <span style={{ fontWeight: 600, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.label || d.registration || d.imei}
                  </span>
                  {d.connected && kmh > 5 && (
                    <span style={{ fontSize: 10, color: speedColor(kmh), fontWeight: 700, flexShrink: 0 }}>{Math.round(kmh)} km/h</span>
                  )}
                  {d.connected && kmh <= 5 && mapD?.ignition !== null && (
                    <span style={{ fontSize: 10, color: mapD?.ignition ? '#22c55e' : 'var(--muted)', flexShrink: 0 }}>{mapD?.ignition ? 'IGN' : 'idle'}</span>
                  )}
                  <button className="btn btn-sm" style={{ padding: '2px 4px', opacity: 0.45, background: 'transparent', minWidth: 0 }}
                    onClick={e => deleteDevice(e, d.id)} title="Remove"><Trash2 size={10} /></button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, paddingLeft: 18, fontFamily: 'monospace', letterSpacing: '.3px' }}>{d.imei}</div>
                <div style={{ fontSize: 10, marginTop: 1, paddingLeft: 18 }}>
                  {d.connected
                    ? <span style={{ color: '#22c55e' }}>● Online · {d.model}</span>
                    : <span style={{ color: 'var(--muted)' }}>Last seen {d.last_seen_at ? new Date(d.last_seen_at).toLocaleTimeString() : 'never'}</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '7px 12px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)' }}>
          <span><span style={{ color: '#22c55e', fontWeight: 700 }}>{devices.filter(d => d.connected).length}</span> online</span>
          <span><span style={{ color: 'var(--text)', fontWeight: 600 }}>{devices.length}</span> total</span>
        </div>
      </div>

      {/* ── Map ────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', isolation: 'isolate' }}>
        <MapContainer center={[-26.2, 28.0]} zoom={10} style={{ height: '100%', width: '100%' }}>
          <TileLayer key={tileMode} url={TILES[tileMode].url} attribution={TILES[tileMode].attribution} />
          {flyTo && <FlyTo position={flyTo} />}
          <FitBounds trigger={fitTrigger} positions={allPositions} />

          {mapDevices.map(d => d.lat && d.lng ? (
            <Marker key={d.id} position={[d.lat, d.lng]} icon={deviceIcon(d)} eventHandlers={{ click: () => selectDevice(d) }}>
              <Popup>
                <strong>{d.label || d.registration || d.imei}</strong><br />
                {d.bike_model} {d.registration}<br />
                {d.connected ? (
                  <>🟢 Online<br />
                  {Math.round(d.speed_kmh || 0)} km/h · {d.heading || 0}° · {d.satellites || '?'} sats</>
                ) : '⚫ Offline'}<br />
                {d.last_location_at ? new Date(d.last_location_at).toLocaleString() : '—'}
              </Popup>
            </Marker>
          ) : null)}

          <SpeedTrail positions={trail} />
          {trail.length > 0 && (
            <Marker position={[trail[0].lat, trail[0].lng]} icon={makeIcon('#1E88D1')}>
              <Popup>Trail start</Popup>
            </Marker>
          )}
          {trail.length > 1 && (
            <Marker position={[trail[trail.length - 1].lat, trail[trail.length - 1].lng]} icon={deviceIcon(selectedMapDevice || {})}>
              <Popup>Latest position</Popup>
            </Marker>
          )}
        </MapContainer>

        {/* Map controls */}
        <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            className="btn btn-sm btn-secondary"
            style={{ fontSize: 11, padding: '6px 10px', background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => setTileMode(m => m === 'street' ? 'satellite' : 'street')}
            title="Toggle map layer"
          >
            <Layers size={13} />
            {tileMode === 'street' ? 'Satellite' : 'Street'}
          </button>
          {allPositions.length > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              style={{ fontSize: 11, padding: '6px 10px', background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={() => setFitTrigger(t => t + 1)}
              title="Fit all devices in view"
            >
              <Maximize2 size={13} />
              Fit all
            </button>
          )}
        </div>

        {/* Legend */}
        <div style={{ position: 'absolute', bottom: 30, right: 10, zIndex: 1000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 11, backdropFilter: 'blur(8px)' }}>
          <div style={{ fontWeight: 700, color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Markers</div>
          {[['#22c55e', 'Online · ignition on'], ['#f97316', 'Online · idle'], ['#94a3b8', 'Offline']].map(([c, l]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: c, flexShrink: 0 }} />
              {l}
            </div>
          ))}
          <div style={{ fontWeight: 700, color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px', marginTop: 8, marginBottom: 5 }}>Trail speed</div>
          {[['#94a3b8', '< 5 km/h'], ['#22c55e', '5–30'], ['#f97316', '30–70'], ['#ef4444', '> 70']].map(([c, l]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <div style={{ width: 18, height: 3, background: c, flexShrink: 0, borderRadius: 2 }} />
              {l}
            </div>
          ))}
        </div>
      </div>

      {/* ── Device detail panel ──────────────────────────────────────── */}
      {selectedDevice && (
        <div style={{ width: 310, minWidth: 310, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)', background: 'var(--surface-2)', overflowY: 'auto' }}>

          {/* Device header */}
          <div style={{ padding: 14, borderBottom: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 2 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  {selectedDevice.connected ? <Wifi size={13} color="#22c55e" /> : <WifiOff size={13} color="#94a3b8" />}
                  <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedDevice.label || selectedDevice.registration || selectedDevice.imei}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace', marginBottom: 1 }}>{selectedDevice.imei}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{selectedDevice.model}{selectedDevice.registration ? ` · ${selectedDevice.registration}` : ''}</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>
                  {selectedDevice.connected
                    ? <span style={{ color: '#22c55e', fontWeight: 600 }}>● Online</span>
                    : <span style={{ color: 'var(--muted)' }}>Last seen {selectedDevice.last_seen_at ? new Date(selectedDevice.last_seen_at).toLocaleString() : 'never'}</span>}
                </div>
              </div>
              <button className="btn btn-sm btn-secondary" style={{ padding: '3px 6px', flexShrink: 0 }}
                onClick={() => { setSelected(null); setTrail([]); setCommands([]); setAddress(null); }} title="Close">
                <X size={12} />
              </button>
            </div>
          </div>

          {/* Location */}
          {selectedMapDevice?.lat && (
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Location</div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <MapPin size={12} style={{ color: 'var(--primary)', marginTop: 2, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 12, lineHeight: 1.4, color: address ? 'var(--text)' : 'var(--muted)' }}>
                    {address || 'Resolving address…'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, fontFamily: 'monospace' }}>
                    {selectedMapDevice.lat.toFixed(6)}, {selectedMapDevice.lng.toFixed(6)}
                  </div>
                  {selectedMapDevice.last_location_at && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
                      Updated {new Date(selectedMapDevice.last_location_at).toLocaleTimeString()}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Live telemetry */}
          {selectedDevice.connected && selectedMapDevice && (
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>Live telemetry</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {[
                  { icon: <Gauge size={13} />,      label: 'Speed',      value: `${Math.round(selectedMapDevice.speed_kmh || 0)} km/h`, color: speedColor(selectedMapDevice.speed_kmh) },
                  { icon: <Navigation size={13} />,  label: 'Heading',    value: `${selectedMapDevice.heading || 0}°`,                  color: 'var(--text)' },
                  { icon: <Mountain size={13} />,    label: 'Altitude',   value: `${selectedMapDevice.altitude || 0} m`,                color: 'var(--text)' },
                  { icon: <Activity size={13} />,    label: 'Satellites', value: `${selectedMapDevice.satellites || '?'}`,              color: (selectedMapDevice.satellites || 0) >= 6 ? '#22c55e' : '#f97316' },
                ].map(({ icon, label, value, color }) => (
                  <div key={label} style={{ background: 'var(--surface)', borderRadius: 8, padding: '8px 10px', border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', marginBottom: 4 }}>
                      {icon}
                      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</span>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 16, color }}>{value}</div>
                  </div>
                ))}
              </div>
              <div style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: 6 }}>
                {selectedMapDevice.ignition ? <Zap size={13} color="#22c55e" /> : <ZapOff size={13} color="var(--muted)" />}
                <span style={{ fontSize: 12, color: selectedMapDevice.ignition ? '#22c55e' : 'var(--muted)' }}>
                  Ignition {selectedMapDevice.ignition ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
          )}

          {/* Trail range */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Trail history</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {TRAIL_RANGES.map(r => (
                <button key={r.id} className={`btn btn-sm ${trailRange === r.id ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ fontSize: 11, padding: '3px 8px', flex: 1 }}
                  onClick={() => setTrailRange(r.id)}>{r.label}</button>
              ))}
            </div>
            {trail.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>{trail.length} positions</div>
            )}
          </div>

          {/* Engine control */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>Engine control</div>
            {!selectedDevice.connected && (
              <div style={{ fontSize: 11, color: '#f97316', marginBottom: 8, padding: '6px 8px', background: 'rgba(249,115,22,.1)', borderRadius: 6, border: '1px solid rgba(249,115,22,.2)' }}>
                Offline — commands will be queued and sent when it reconnects
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {ENGINE_CMDS.map(({ id, label, desc, icon: Icon, danger }) => (
                <button key={id} className={`btn btn-sm${danger ? ' btn-danger' : ' btn-secondary'}`}
                  style={{ flexDirection: 'column', alignItems: 'center', gap: 4, padding: '10px 6px', height: 'auto' }}
                  disabled={!!sendingCmd} onClick={() => sendPreset(id)}>
                  <Icon size={16} />
                  <span style={{ fontSize: 11, fontWeight: 600 }}>{sendingCmd === id ? '…' : label}</span>
                  <span style={{ fontSize: 10, opacity: .7, fontWeight: 400 }}>{desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Diagnostics */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>Diagnostics</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              {DIAG_CMDS.map(({ id, label, icon: Icon }) => (
                <button key={id} className="btn btn-sm btn-secondary"
                  style={{ justifyContent: 'center', gap: 5, fontSize: 11 }}
                  disabled={!!sendingCmd} onClick={() => sendPreset(id)}>
                  <Icon size={11} />
                  {sendingCmd === id ? '…' : label}
                </button>
              ))}
            </div>
          </div>

          {/* Command history */}
          <div style={{ padding: '10px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8, display: 'flex', alignItems: 'center' }}>
              Command history
              <button className="btn btn-sm" style={{ padding: '1px 5px', marginLeft: 'auto', background: 'transparent' }}
                onClick={refreshCommands} title="Refresh"><RefreshCw size={10} /></button>
            </div>
            {commands.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No commands sent yet.</div>
              : commands.map(c => (
                <div key={c.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {STATUS_ICON[c.status] || <AlertCircle size={12} />}
                    <code style={{ fontSize: 10, background: 'var(--surface)', padding: '1px 5px', borderRadius: 3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.command}</code>
                    <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>{c.status}</span>
                  </div>
                  {c.response && (
                    <div style={{ marginTop: 3, padding: '3px 6px', background: 'var(--surface)', borderRadius: 4, fontSize: 10, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {c.response}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                    {new Date(c.created_at).toLocaleString()}{c.created_by_name ? ` · ${c.created_by_name}` : ''}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── Add device modal ─────────────────────────────────────────── */}
      {showAdd && (
        <Modal onClose={() => { setShowAdd(false); setAddForm(EMPTY_FORM); }} title="Register a GPS tracker">
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18, marginTop: -4, lineHeight: 1.5 }}>
            Enter the IMEI printed on the device label. Once registered, the tracker will connect automatically and appear on the map.
          </p>

          <div className="field">
            <label className="label">IMEI number <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input
              className="input"
              placeholder="15–17 digit number printed on the device"
              value={addForm.imei}
              onChange={e => setAddForm(f => ({ ...f, imei: e.target.value.replace(/\D/g, '') }))}
              maxLength={17}
              autoFocus
            />
            {addForm.imei && !/^\d{15,17}$/.test(addForm.imei) && (
              <div style={{ fontSize: 11, color: '#f97316', marginTop: 4 }}>Must be 15–17 digits</div>
            )}
          </div>

          <div className="field">
            <label className="label">Device model <span style={{ color: 'var(--danger)' }}>*</span></label>
            <select className="input" value={addForm.model} onChange={e => setAddForm(f => ({ ...f, model: e.target.value }))}>
              {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Model determines which engine-cut command is used</div>
          </div>

          <div className="field">
            <label className="label">Assign to bike <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
            <select className="input" value={addForm.bike_id} onChange={e => setAddForm(f => ({ ...f, bike_id: e.target.value }))}>
              <option value="">— not assigned yet —</option>
              {bikes.map(b => <option key={b.id} value={b.id}>{b.registration} — {b.make} {b.model}</option>)}
            </select>
          </div>

          <div className="field">
            <label className="label">Friendly name <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
            <input className="input" placeholder="e.g. Sipho's Honda" value={addForm.label}
              onChange={e => setAddForm(f => ({ ...f, label: e.target.value }))} />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button className="btn btn-primary" onClick={addDevice} disabled={adding}>
              {adding ? 'Registering…' : 'Register device'}
            </button>
            <button className="btn btn-secondary" onClick={() => { setShowAdd(false); setAddForm(EMPTY_FORM); }}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

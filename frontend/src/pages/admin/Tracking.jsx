import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Wifi, WifiOff, Zap, ZapOff, Radio, Info, RefreshCw, Plus, Trash2,
  CheckCircle, Clock, XCircle, AlertCircle, X, Search, Layers,
  Maximize2, Navigation, Gauge, Mountain, MapPin, Activity,
  Shield, Bell, Route, BellOff, Pencil,
  Battery, BatteryLow, BatteryMedium, BatteryFull, BatteryCharging,
  Signal, SignalZero, SignalLow, SignalMedium, SignalHigh, Satellite,
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

function MapClickHandler({ onMapClick }) {
  useMapEvents({ click: (e) => onMapClick(e.latlng) });
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
  { id: 'cut_engine',     label: 'Cut engine',     desc: 'Disable ignition',   icon: ZapOff, danger: true },
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

const ALERT_LABELS = {
  geofence_enter:   'Entered geofence',
  geofence_exit:    'Left geofence',
  harsh_brake:      'Harsh braking',
  harsh_accel:      'Harsh acceleration',
  harsh_cornering:  'Harsh cornering',
  idle:             'Extended idle',
  speeding:         'Speeding',
};
const ALERT_COLORS = {
  geofence_enter:   '#22c55e',
  geofence_exit:    '#f97316',
  harsh_brake:      '#ef4444',
  harsh_accel:      '#f97316',
  harsh_cornering:  '#eab308',
  idle:             '#94a3b8',
  speeding:         '#ef4444',
};

const EMPTY_FORM = { imei: '', model: 'FMB920', bike_id: '', label: '' };
const EMPTY_GEO  = { name: '', lat: '', lng: '', radius_m: 500, bike_id: '' };

function BikeCombobox({ bikes, value, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const close = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const selected = value ? bikes.find(b => String(b.id) === String(value)) : null;
  const inputDisplay = open ? query : (selected ? `${selected.registration} — ${selected.make} ${selected.model}` : '');

  const filtered = bikes.filter(b => {
    if (!query) return true;
    const q = query.toLowerCase();
    return [b.registration, b.make, b.model].some(v => v && String(v).toLowerCase().includes(q));
  }).slice(0, 80);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        className="input"
        placeholder="Search by registration, make or model…"
        value={inputDisplay}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setQuery(''); setOpen(true); }}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
        autoComplete="off"
      />
      {open && (
        <div style={{ position: 'absolute', zIndex: 9999, top: '100%', left: 0, right: 0, marginTop: 2, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, maxHeight: 220, overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,.18)' }}>
          <div
            onMouseDown={e => { e.preventDefault(); onChange(null); setQuery(''); setOpen(false); }}
            style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 12, color: 'var(--muted)', borderBottom: '1px solid var(--border)', fontStyle: 'italic' }}
          >— Not assigned —</div>
          {filtered.length === 0
            ? <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--muted)' }}>No bikes match "{query}"</div>
            : filtered.map(b => (
              <div
                key={b.id}
                onMouseDown={e => { e.preventDefault(); onChange(b.id); setQuery(''); setOpen(false); }}
                style={{
                  padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                  background: String(value) === String(b.id) ? 'var(--primary)' : 'transparent',
                  color: String(value) === String(b.id) ? '#fff' : 'var(--text)',
                }}
              >
                <strong>{b.registration}</strong>
                <span style={{ opacity: .7, marginLeft: 6 }}>{b.make} {b.model}</span>
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, { headers: { 'Accept-Language': 'en' } });
    const j = await r.json();
    return j.display_name?.split(',').slice(0, 3).join(', ') || null;
  } catch { return null; }
}

function fmtDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

// ── SAST time formatting (Africa/Johannesburg = UTC+2, no DST) ───────────────
const SAST = { timeZone: 'Africa/Johannesburg' };
const fmtSASTtime = (d) => d ? new Date(d).toLocaleTimeString('en-ZA', { ...SAST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
const fmtSAST     = (d) => d ? new Date(d).toLocaleString('en-ZA',     { ...SAST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
const fmtSASTshort = (d) => d ? new Date(d).toLocaleString('en-ZA',    { ...SAST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

// ── Parse Teltonika IO data JSON to useful values ─────────────────────────────
function parseIo(ioData) {
  try {
    const io = typeof ioData === 'string' ? JSON.parse(ioData) : (ioData || {});
    return {
      gsm:    io[21] != null ? Number(io[21]) : null,   // 0–5 signal level
      battMv: io[66] != null ? Number(io[66]) : null,   // internal battery mV
      extMv:  io[67] != null ? Number(io[67]) : null,   // external power mV
    };
  } catch { return { gsm: null, battMv: null, extMv: null }; }
}

// Battery % from mV (3200 mV = 0 %, 4200 mV = 100 %)
function battPct(mv) { return Math.min(100, Math.max(0, Math.round((mv - 3200) / 10))); }

function DeviceBatteryIcon({ battMv, extMv, size = 12 }) {
  if (extMv != null && extMv > 9000) return <BatteryCharging size={size} color="#22c55e" title={`External power: ${(extMv / 1000).toFixed(1)} V`} />;
  if (battMv == null) return <Battery size={size} color="var(--muted)" title="No battery data" />;
  const pct = battPct(battMv);
  if (pct <= 20) return <BatteryLow   size={size} color="#ef4444" title={`Battery: ${pct}%`} />;
  if (pct <= 50) return <BatteryMedium size={size} color="#f97316" title={`Battery: ${pct}%`} />;
  if (pct <= 80) return <BatteryFull   size={size} color="#eab308" title={`Battery: ${pct}%`} />;
  return <BatteryCharging size={size} color="#22c55e" title={`Battery: ${pct}%`} />;
}

function DeviceSignalIcon({ gsm, size = 12 }) {
  if (gsm == null) return <SignalZero size={size} color="var(--muted)" title="No signal data" />;
  if (gsm === 0)   return <SignalZero size={size} color="#ef4444"      title="No signal" />;
  if (gsm <= 1)    return <SignalLow    size={size} color="#ef4444"    title={`Signal: ${gsm}/5`} />;
  if (gsm <= 2)    return <SignalMedium size={size} color="#f97316"    title={`Signal: ${gsm}/5`} />;
  if (gsm <= 3)    return <SignalMedium size={size} color="#eab308"    title={`Signal: ${gsm}/5`} />;
  return <SignalHigh size={size} color="#22c55e" title={`Signal: ${gsm}/5`} />;
}

// ── Command label mapping ─────────────────────────────────────────────────────
const CMD_LABEL_MAP = {
  'fota connect':   'FOTA Update',
  'getinfo':        'Device Info',
  'getstatus':      'Connection Status',
  'getver':         'Firmware Version',
  'getparam 2004':  'Server Domain',
  'setdigout 1 1':  'Cut Engine',
  'setdigout 1 0':  'Restore Engine',
  'setdigout 2 1':  'Cut Engine',
  'setdigout 2 0':  'Restore Engine',
};
function getCmdLabel(raw) { return CMD_LABEL_MAP[String(raw || '').trim()] || raw || '—'; }

// ── Parse raw Teltonika command responses into readable key-value rows ─────────
function parseCommandResponse(command, raw) {
  if (!raw) return null;
  const r = raw.trim();

  // Error responses
  if (/unknown command|invalid format|invalid command/i.test(r)) {
    return [{ label: 'Error', value: r, error: true }];
  }

  // getver — "Ver:04.00.00_13 GPS:AXN_5.1.9 Hw:FMB920 Md:13 IMEI:... Uptime:21846 ..."
  if (r.startsWith('Ver:')) {
    const v   = r.match(/Ver:([\S]+)/)?.[1];
    const gps = r.match(/GPS:([\S]+)/)?.[1];
    const hw  = r.match(/Hw:([\S]+)/)?.[1];
    const ut  = r.match(/Uptime:(\d+)/)?.[1];
    const bl  = r.match(/BL:([\S]+)/)?.[1];
    const rows = [];
    if (hw)  rows.push({ label: 'Hardware',  value: hw });
    if (v)   rows.push({ label: 'Firmware',  value: v });
    if (gps) rows.push({ label: 'GPS chip',  value: gps });
    if (bl)  rows.push({ label: 'Bootloader', value: bl });
    if (ut)  { const s = Number(ut); rows.push({ label: 'Uptime', value: `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m` }); }
    return rows.length ? rows : null;
  }

  // getinfo — "RTC:... UpTime:21816s PWR:SoftReset RST:0 GPS:3 SAT:17 TTFF:8 ..."
  if (r.startsWith('RTC:') || /UpTime:/i.test(r)) {
    const ut   = r.match(/UpTime:(\d+)/i)?.[1];
    const sat  = r.match(/SAT:(\d+)/)?.[1];
    const fix  = r.match(/GPS:(\d+)/)?.[1];
    const rec  = r.match(/REC:(\d+)/)?.[1];
    const pwr  = r.match(/PWR:([\S]+)/)?.[1];
    const rows = [];
    if (ut)  { const s = Number(ut); rows.push({ label: 'Uptime', value: `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m` }); }
    if (fix) rows.push({ label: 'GPS fix',    value: fix === '3' ? '3D (good)' : fix === '2' ? '2D (weak)' : 'No fix', warn: fix !== '3' });
    if (sat) rows.push({ label: 'Satellites', value: `${sat} visible` });
    if (pwr) rows.push({ label: 'Last reset', value: pwr });
    if (rec) rows.push({ label: 'Records queued', value: rec });
    return rows.length ? rows : null;
  }

  // getstatus — "Data Link: 1 GPRS: 1 Phone: 0 SIM: 0 OP: 6 5501 Signal: 3 ..."
  if (/Data Link:|GPRS:|Signal:/i.test(r)) {
    const gprs   = r.match(/GPRS:\s*(\d+)/)?.[1];
    const signal = r.match(/Signal:\s*(\d+)/)?.[1];
    const sim    = r.match(/SIM:\s*(\d+)/)?.[1];
    const roam   = r.match(/Roaming:\s*(\d+)/)?.[1];
    const rows = [];
    if (gprs)   rows.push({ label: 'GPRS data',  value: gprs === '1'   ? 'Connected' : 'Disconnected', warn: gprs !== '1' });
    if (signal) rows.push({ label: 'GSM signal', value: `${signal} / 5`, warn: Number(signal) < 2 });
    if (sim)    rows.push({ label: 'SIM',        value: sim === '1' ? 'Ready' : 'Not ready', warn: sim !== '1' });
    if (roam)   rows.push({ label: 'Roaming',    value: roam === '1' ? 'Yes' : 'No' });
    return rows.length ? rows : null;
  }

  // setdigout (engine cut/restore) — no meaningful response body
  if (/setdigout/.test(String(command))) {
    return [{ label: 'Result', value: r || 'Command applied' }];
  }

  return null; // fall back to raw monospace display
}

export default function Tracking() {
  // ── device list & selection ──────────────────────────────────────
  const [devices,      setDevices]      = useState([]);
  const [mapDevices,   setMapDevices]   = useState([]);
  const [selected,     setSelected]     = useState(null);
  const [trail,        setTrail]        = useState([]);
  const [commands,     setCommands]     = useState([]);
  const [flyTo,        setFlyTo]        = useState(null);
  const [fitTrigger,   setFitTrigger]   = useState(0);
  const [loading,      setLoading]      = useState(true);
  const [bikes,        setBikes]        = useState([]);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [tileMode,     setTileMode]     = useState('street');
  const [trailRange,   setTrailRange]   = useState('6h');
  const [address,      setAddress]      = useState(null);
  const [sseOnline,    setSseOnline]    = useState(false);
  const [sendingCmd,   setSendingCmd]   = useState(null);

  // ── add-device modal ─────────────────────────────────────────────
  const [showAdd,  setShowAdd]  = useState(false);
  const [addForm,  setAddForm]  = useState(EMPTY_FORM);
  const [adding,   setAdding]   = useState(false);

  // ── edit-device modal ─────────────────────────────────────────────
  const [showEditDevice, setShowEditDevice] = useState(false);
  const [editDeviceForm, setEditDeviceForm] = useState({ model: 'FMB920', label: '', bike_id: null });
  const [savingEdit, setSavingEdit] = useState(false);

  // ── sidebar tabs ─────────────────────────────────────────────────
  const [sideTab, setSideTab] = useState('devices');

  // ── alerts ───────────────────────────────────────────────────────
  const [alerts,       setAlerts]       = useState([]);
  const [alertsUnread, setAlertsUnread] = useState(0);

  // ── geofences ────────────────────────────────────────────────────
  const [geofences,     setGeofences]     = useState([]);
  const [showGeoForm,   setShowGeoForm]   = useState(false);
  const [geoForm,       setGeoForm]       = useState(EMPTY_GEO);
  const [geoSubmitting, setGeoSubmitting] = useState(false);
  const [pickingCenter, setPickingCenter] = useState(false);

  // ── detail panel tabs ─────────────────────────────────────────────
  const [detailTab, setDetailTab] = useState('activity');
  const [trips,     setTrips]     = useState([]);

  const selectedRef       = useRef(null);
  const mountedRef        = useRef(true);
  const geocodeVersionRef = useRef(0);
  const selectVersionRef  = useRef(0);

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

  // Escape cancels center picking
  useEffect(() => {
    if (!pickingCenter) return;
    const handler = (e) => {
      if (e.key === 'Escape') { setPickingCenter(false); setShowGeoForm(true); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pickingCenter]);

  // ── data loaders ─────────────────────────────────────────────────

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

  const loadGeofences = useCallback(async () => {
    try {
      const { data } = await api.get('/tracking/geofences');
      setGeofences(data);
    } catch { /* silent */ }
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const { data } = await api.get('/tracking/alerts?limit=100');
      setAlerts(data);
    } catch { /* silent */ }
  }, []);

  const loadTrips = useCallback(async (bikeId) => {
    try {
      const { data } = await api.get(`/tracking/trips?bike_id=${bikeId}&limit=30`);
      setTrips(data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadDevices(), loadBikes(), loadGeofences()]).finally(() => setLoading(false));
  }, [loadDevices, loadBikes, loadGeofences]);

  // ── SSE real-time feed ───────────────────────────────────────────
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
              if (!mountedRef.current) continue;

              if (evtType === 'ping') {
                setMapDevices(prev => {
                  const idx = prev.findIndex(d => d.id === p.device_id);
                  if (idx === -1) return prev;
                  const next = [...prev];
                  next[idx] = { ...next[idx], lat: p.lat, lng: p.lng, speed_kmh: p.speed, heading: p.heading, altitude: p.altitude, satellites: p.satellites, ignition: p.ignition, last_location_at: new Date(p.ts).toISOString(), connected: 1, gsm_signal: p.gsm_signal, battery_mv: p.battery_mv, ext_voltage_mv: p.ext_voltage_mv };
                  return next;
                });
                if (selectedRef.current === p.device_id) {
                  setTrail(t => {
                    const pt = { lat: p.lat, lng: p.lng, speed_kmh: p.speed };
                    if (t.length && t[t.length - 1].lat === pt.lat && t[t.length - 1].lng === pt.lng) return t;
                    return [...t, pt];
                  });
                }
              } else if (evtType === 'alert') {
                setAlertsUnread(n => n + 1);
                setAlerts(prev => [p, ...prev].slice(0, 200));
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

  // ── 3-second device list refresh (connected status, io data) ────
  useEffect(() => {
    const tick = setInterval(async () => {
      if (!mountedRef.current) return;
      if (document.hidden) return; // don't poll when tab is not visible
      try {
        const [{ data: devs }, { data: map }] = await Promise.all([
          api.get('/tracking/devices'),
          api.get('/tracking/map'),
        ]);
        if (!mountedRef.current) return;
        setDevices(devs);
        // Merge map refresh without overwriting SSE-written fields that are newer
        setMapDevices(prev => map.map(incoming => {
          const live = prev.find(p => p.id === incoming.id);
          if (!live) return incoming;
          // Keep SSE-pushed fields if they exist (SSE gives real-time; API gives stale lat/lng)
          return { ...incoming, lat: live.lat ?? incoming.lat, lng: live.lng ?? incoming.lng, speed_kmh: live.speed_kmh ?? incoming.speed_kmh, heading: live.heading ?? incoming.heading, satellites: live.satellites ?? incoming.satellites, ignition: live.ignition ?? incoming.ignition, gsm_signal: live.gsm_signal ?? incoming.gsm_signal, battery_mv: live.battery_mv ?? incoming.battery_mv, ext_voltage_mv: live.ext_voltage_mv ?? incoming.ext_voltage_mv };
        }));
      } catch { /* silent */ }
    }, 10000);
    return () => clearInterval(tick);
  }, []);

  // ── trail ────────────────────────────────────────────────────────

  const loadTrail = useCallback(async (deviceId, range, version) => {
    const hours = TRAIL_RANGES.find(r => r.id === range)?.hours || 6;
    const from = new Date(Date.now() - hours * 3_600_000).toISOString();
    try {
      const { data } = await api.get(`/tracking/devices/${deviceId}/positions?limit=500&from=${encodeURIComponent(from)}`);
      if (version === undefined || selectVersionRef.current === version) {
        setTrail(data.map(p => ({ lat: p.lat, lng: p.lng, speed_kmh: p.speed_kmh })));
      }
    } catch { /* silent */ }
  }, []);

  const selectDevice = useCallback(async (device) => {
    const version = ++selectVersionRef.current;
    setSelected(device.id);
    setDetailTab('activity');
    setTrips([]);
    setAddress(null);
    if (device.lat && device.lng) {
      setFlyTo([device.lat, device.lng]);
      const geocodeVersion = ++geocodeVersionRef.current;
      reverseGeocode(device.lat, device.lng).then(addr => {
        if (mountedRef.current && geocodeVersionRef.current === geocodeVersion) setAddress(addr);
      });
    }
    try {
      const deviceBikeId = device.bike_id;
      const [, { data: cmds }, tripsRes] = await Promise.all([
        loadTrail(device.id, trailRange, version),
        api.get(`/tracking/devices/${device.id}/commands`),
        deviceBikeId ? api.get(`/tracking/trips?bike_id=${deviceBikeId}&limit=30`) : Promise.resolve({ data: [] }),
      ]);
      if (mountedRef.current && selectVersionRef.current === version) {
        setCommands(cmds);
        setTrips(tripsRes.data);
      }
    } catch { /* silent */ }
  }, [loadTrail, trailRange]);

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

  // ── commands ─────────────────────────────────────────────────────

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

  // ── add device ───────────────────────────────────────────────────

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

  const saveDeviceEdit = useCallback(async () => {
    setSavingEdit(true);
    try {
      await api.put(`/tracking/devices/${selected}`, { ...editDeviceForm, bike_id: editDeviceForm.bike_id || null });
      toast.success('Device updated');
      setShowEditDevice(false);
      await loadDevices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update device');
    } finally {
      setSavingEdit(false);
    }
  }, [selected, editDeviceForm, loadDevices]);

  const deleteDevice = useCallback(async (e, id) => {
    e.stopPropagation();
    const dev = devices.find(d => d.id === id);
    if (!window.confirm(`Remove ${dev?.label || dev?.imei}?`)) return;
    try {
      await api.delete(`/tracking/devices/${id}`);
      if (selected === id) { setSelected(null); setTrail([]); setCommands([]); setAddress(null); setTrips([]); }
      await loadDevices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  }, [selected, devices, loadDevices]);

  // ── geofences ────────────────────────────────────────────────────

  const saveGeofence = useCallback(async () => {
    if (!geoForm.name.trim()) return toast.error('Name is required');
    if (!geoForm.lat || !geoForm.lng) return toast.error('Pick a center on the map or enter coordinates');
    setGeoSubmitting(true);
    try {
      await api.post('/tracking/geofences', {
        name: geoForm.name.trim(),
        lat: Number(geoForm.lat),
        lng: Number(geoForm.lng),
        radius_m: Number(geoForm.radius_m),
        bike_id: geoForm.bike_id || null,
      });
      toast.success('Geofence created');
      setShowGeoForm(false);
      setGeoForm(EMPTY_GEO);
      await loadGeofences();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    } finally {
      setGeoSubmitting(false);
    }
  }, [geoForm, loadGeofences]);

  const deleteGeofence = useCallback(async (id) => {
    if (!window.confirm('Delete this geofence?')) return;
    try {
      await api.delete(`/tracking/geofences/${id}`);
      setGeofences(prev => prev.filter(g => g.id !== id));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  }, []);

  const handleMapClick = useCallback((latlng) => {
    if (!pickingCenter) return;
    setGeoForm(f => ({ ...f, lat: latlng.lat.toFixed(6), lng: latlng.lng.toFixed(6) }));
    setPickingCenter(false);
    setShowGeoForm(true);
  }, [pickingCenter]);

  // ── alerts ───────────────────────────────────────────────────────

  const acknowledgeAlert = useCallback(async (id) => {
    try {
      await api.put(`/tracking/alerts/${id}/acknowledge`);
      setAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged_at: new Date().toISOString() } : a));
    } catch { toast.error('Failed'); }
  }, []);

  const acknowledgeAll = useCallback(async () => {
    try {
      await api.post('/tracking/alerts/acknowledge-all');
      setAlerts(prev => prev.map(a => ({ ...a, acknowledged_at: a.acknowledged_at || new Date().toISOString() })));
      setAlertsUnread(0);
    } catch { toast.error('Failed'); }
  }, []);

  // ── derived ──────────────────────────────────────────────────────

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

  // ── render ───────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)', overflow: 'hidden' }}>

      {/* ── Left sidebar ──────────────────────────────────────────── */}
      <div style={{ width: 272, minWidth: 272, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--surface-2)' }}>

        {/* Header */}
        <div style={{ padding: '10px 12px 0', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>GPS Tracking</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: sseOnline ? '#22c55e' : '#94a3b8' }} title={sseOnline ? 'Live feed active' : 'Reconnecting…'} />
              <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>{sseOnline ? 'LIVE' : 'offline'}</span>
            </div>
            <button className="btn btn-sm btn-secondary" title="Refresh" onClick={loadDevices}><RefreshCw size={12} /></button>
            <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(true)}><Plus size={12} /> Add</button>
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', marginBottom: 0 }}>
            {[
              ['devices',   'Devices',    null],
              ['alerts',    'Alerts',     alertsUnread || null],
              ['geofences', 'Geofences',  null],
            ].map(([tab, label, badge]) => (
              <button
                key={tab}
                onClick={() => {
                  setSideTab(tab);
                  if (tab === 'alerts') { setAlertsUnread(0); loadAlerts(); }
                  if (tab === 'geofences') loadGeofences();
                }}
                style={{
                  flex: 1, padding: '6px 2px 7px', fontSize: 11,
                  fontWeight: sideTab === tab ? 700 : 400,
                  color: sideTab === tab ? 'var(--primary)' : 'var(--muted)',
                  background: 'none', border: 'none',
                  borderBottom: sideTab === tab ? '2px solid var(--primary)' : '2px solid transparent',
                  marginBottom: -1, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                }}
              >
                {label}
                {badge ? <span style={{ background: '#ef4444', color: '#fff', borderRadius: 8, fontSize: 9, padding: '0 4px', fontWeight: 700, lineHeight: '14px' }}>{badge}</span> : null}
              </button>
            ))}
          </div>
        </div>

        {/* ── Devices tab ─────────────────────────────────────────── */}
        {sideTab === 'devices' && <>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
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
                  {!d.bike_id && <div style={{ fontSize: 10, color: '#f97316', marginTop: 2, paddingLeft: 18 }}>⚠ No bike linked — positions not stored</div>}
                  <div style={{ fontSize: 10, marginTop: 2, paddingLeft: 18, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {d.connected ? (
                      <>
                        <span style={{ color: '#22c55e' }}>● Online · {d.model}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 2 }}>
                          {(() => { const io = parseIo(mapD?.io_data); return (<>
                            <DeviceSignalIcon gsm={mapD?.gsm_signal ?? io.gsm} size={11} />
                            <DeviceBatteryIcon battMv={mapD?.battery_mv ?? io.battMv} extMv={mapD?.ext_voltage_mv ?? io.extMv} size={11} />
                            {(mapD?.satellites ?? 0) > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 2, color: (mapD?.satellites || 0) >= 6 ? '#22c55e' : '#f97316' }}><Satellite size={10} /><span style={{ fontSize: 9 }}>{mapD.satellites}</span></span>}
                          </>); })()}
                        </span>
                      </>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>Last seen {d.last_seen_at ? fmtSASTshort(d.last_seen_at) : 'never'}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: '7px 12px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)' }}>
            <span><span style={{ color: '#22c55e', fontWeight: 700 }}>{devices.filter(d => d.connected).length}</span> online</span>
            <span><span style={{ color: 'var(--text)', fontWeight: 600 }}>{devices.length}</span> total</span>
          </div>
        </>}

        {/* ── Alerts tab ──────────────────────────────────────────── */}
        {sideTab === 'alerts' && <>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>Recent events</span>
            <button className="btn btn-sm btn-secondary" onClick={loadAlerts}><RefreshCw size={11} /></button>
            {alerts.some(a => !a.acknowledged_at) && (
              <button className="btn btn-sm btn-secondary" style={{ fontSize: 11 }} onClick={acknowledgeAll}>Ack all</button>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {alerts.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                <BellOff size={28} style={{ color: 'var(--muted)', marginBottom: 8 }} />
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No alerts yet</div>
              </div>
            ) : alerts.map(a => {
              let payload = {};
              try { payload = JSON.parse(a.payload || '{}'); } catch { /* skip */ }
              const isUnread = !a.acknowledged_at;
              return (
                <div key={a.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', opacity: isUnread ? 1 : 0.55 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: ALERT_COLORS[a.alert_type] || '#94a3b8', flexShrink: 0, marginTop: 3 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: isUnread ? 700 : 400 }}>{ALERT_LABELS[a.alert_type] || a.alert_type}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
                        {a.bike_registration || `Bike #${a.bike_id}`} · {fmtSASTtime(a.created_at)}
                      </div>
                      {payload.speed_kmh && <div style={{ fontSize: 10, color: ALERT_COLORS[a.alert_type], marginTop: 1 }}>{Math.round(payload.speed_kmh)} km/h</div>}
                      {payload.geofence_name && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>Zone: {payload.geofence_name}</div>}
                      {payload.idle_sec && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>Idle: {Math.round(payload.idle_sec / 60)} min</div>}
                    </div>
                    {isUnread && (
                      <button className="btn btn-sm" style={{ padding: '2px 6px', fontSize: 10, flexShrink: 0 }} onClick={() => acknowledgeAlert(a.id)}>Ack</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>}

        {/* ── Geofences tab ────────────────────────────────────────── */}
        {sideTab === 'geofences' && <>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>{geofences.length} geofence{geofences.length !== 1 ? 's' : ''}</span>
            <button className="btn btn-sm btn-secondary" onClick={loadGeofences}><RefreshCw size={11} /></button>
            <button className="btn btn-sm btn-primary" onClick={() => setShowGeoForm(true)}><Plus size={11} /> Add</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {geofences.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                <Shield size={28} style={{ color: 'var(--muted)', marginBottom: 8 }} />
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>No geofences</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>Add zones to get entry/exit alerts when bikes cross the boundary</div>
                <button className="btn btn-sm btn-primary" onClick={() => setShowGeoForm(true)}><Plus size={11} /> Add geofence</button>
              </div>
            ) : geofences.map(gf => (
              <div key={gf.id} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 7 }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #1E88D1', background: 'rgba(30,136,209,.12)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gf.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
                    r={gf.radius_m}m{gf.bike_registration ? ` · ${gf.bike_registration}` : ' · all bikes'}
                  </div>
                </div>
                <button className="btn btn-sm" style={{ padding: '2px 4px', opacity: 0.5, background: 'transparent', minWidth: 0 }}
                  onClick={() => deleteGeofence(gf.id)} title="Delete"><Trash2 size={10} /></button>
              </div>
            ))}
          </div>
        </>}
      </div>

      {/* ── Map ────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', isolation: 'isolate' }}>

        {pickingCenter && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1100, background: '#1E88D1', color: '#fff', padding: '7px 14px', textAlign: 'center', fontSize: 12, fontWeight: 600 }}>
            Click the map to set the geofence center &nbsp;·&nbsp; Press Esc to cancel
          </div>
        )}

        <MapContainer center={[-26.2, 28.0]} zoom={10} style={{ height: '100%', width: '100%', cursor: pickingCenter ? 'crosshair' : undefined }}>
          <TileLayer key={tileMode} url={TILES[tileMode].url} attribution={TILES[tileMode].attribution} />
          {flyTo && <FlyTo position={flyTo} />}
          <FitBounds trigger={fitTrigger} positions={allPositions} />
          {pickingCenter && <MapClickHandler onMapClick={handleMapClick} />}

          {/* Geofence circles */}
          {geofences.map(gf => gf.lat && gf.lng ? (
            <Circle
              key={gf.id}
              center={[gf.lat, gf.lng]}
              radius={gf.radius_m}
              pathOptions={{ color: '#1E88D1', fillColor: '#1E88D1', fillOpacity: 0.07, weight: 2, dashArray: '6 4' }}
            >
              <Popup><strong>{gf.name}</strong><br />Radius: {gf.radius_m}m{gf.bike_registration ? `\nBike: ${gf.bike_registration}` : ''}</Popup>
            </Circle>
          ) : null)}

          {/* Device markers */}
          {mapDevices.map(d => d.lat && d.lng ? (
            <Marker key={d.id} position={[d.lat, d.lng]} icon={deviceIcon(d)} eventHandlers={{ click: () => selectDevice(d) }}>
              <Popup>
                <strong>{d.label || d.registration || d.imei}</strong><br />
                {d.bike_model} {d.registration}<br />
                {d.connected ? (
                  <>🟢 Online<br />{Math.round(d.speed_kmh || 0)} km/h · {d.heading || 0}° · {d.satellites || '?'} sats</>
                ) : '⚫ Offline'}<br />
                {d.last_location_at ? fmtSAST(d.last_location_at) : '—'}
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
          >
            <Layers size={13} />{tileMode === 'street' ? 'Satellite' : 'Street'}
          </button>
          {allPositions.length > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              style={{ fontSize: 11, padding: '6px 10px', background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={() => setFitTrigger(t => t + 1)}
            >
              <Maximize2 size={13} />Fit all
            </button>
          )}
        </div>

        {/* Legend */}
        <div style={{ position: 'absolute', bottom: 30, right: 10, zIndex: 1000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 11, backdropFilter: 'blur(8px)' }}>
          <div style={{ fontWeight: 700, color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Markers</div>
          {[['#22c55e', 'Online · ignition on'], ['#f97316', 'Online · idle'], ['#94a3b8', 'Offline']].map(([c, l]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: c, flexShrink: 0 }} />{l}
            </div>
          ))}
          <div style={{ fontWeight: 700, color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px', marginTop: 8, marginBottom: 5 }}>Trail speed</div>
          {[['#94a3b8', '< 5 km/h'], ['#22c55e', '5–30'], ['#f97316', '30–70'], ['#ef4444', '> 70']].map(([c, l]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <div style={{ width: 18, height: 3, background: c, flexShrink: 0, borderRadius: 2 }} />{l}
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
                    : <span style={{ color: 'var(--muted)' }}>Last seen {selectedDevice.last_seen_at ? fmtSAST(selectedDevice.last_seen_at) : 'never'}</span>}
                </div>
              </div>
              <button className="btn btn-sm btn-secondary" style={{ padding: '3px 6px', flexShrink: 0 }}
                title="Edit device"
                onClick={() => {
                  setEditDeviceForm({ model: selectedDevice.model || 'FMB920', label: selectedDevice.label || '', bike_id: selectedDevice.bike_id || null });
                  setShowEditDevice(true);
                }}>
                <Pencil size={12} />
              </button>
              <button className="btn btn-sm btn-secondary" style={{ padding: '3px 6px', flexShrink: 0 }}
                onClick={() => { setSelected(null); setTrail([]); setCommands([]); setAddress(null); setTrips([]); }} title="Close">
                <X size={12} />
              </button>
            </div>

            {/* Detail tabs */}
            <div style={{ display: 'flex', marginTop: 10, marginBottom: -14, marginLeft: -14, marginRight: -14, borderTop: '1px solid var(--border)', paddingTop: 2 }}>
              {[['activity', 'Activity'], ['trips', 'Trips'], ['bike', 'Bike'], ['driver', 'Driver'], ['info', 'Controls']].map(([tab, label]) => (
                <button
                  key={tab}
                  onClick={() => {
                    setDetailTab(tab);
                    if (tab === 'trips' && selectedDevice.bike_id) loadTrips(selectedDevice.bike_id);
                  }}
                  style={{
                    flex: 1, padding: '6px 8px 8px', fontSize: 11,
                    fontWeight: detailTab === tab ? 700 : 400,
                    color: detailTab === tab ? 'var(--primary)' : 'var(--muted)',
                    background: 'none', border: 'none',
                    borderBottom: detailTab === tab ? '2px solid var(--primary)' : '2px solid transparent',
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Activity tab ─────────────────────────────────────── */}
          {detailTab === 'activity' && (() => {
            const io     = parseIo(selectedMapDevice?.io_data);
            const gsm    = selectedMapDevice?.gsm_signal    ?? io.gsm;
            const battMv = selectedMapDevice?.battery_mv    ?? io.battMv;
            const extMv  = selectedMapDevice?.ext_voltage_mv ?? io.extMv;
            const ts     = selectedMapDevice?.last_location_at;
            const todayTrips = trips.filter(t => {
              const d = new Date(t.started_at);
              const now = new Date();
              return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
            });
            const todayKm   = todayTrips.reduce((s, t) => s + (t.distance_km || 0), 0);
            const todaySec  = todayTrips.reduce((s, t) => s + (t.duration_sec || 0), 0);
            const telemetryRows = [
              {
                icon: extMv != null && extMv > 9000
                  ? <BatteryCharging size={18} color="#22c55e" />
                  : battMv != null && battPct(battMv) <= 20
                    ? <BatteryLow size={18} color="#ef4444" />
                    : battMv != null && battPct(battMv) <= 50
                      ? <BatteryMedium size={18} color="#f97316" />
                      : <BatteryFull size={18} color="#22c55e" />,
                value: extMv != null && extMv > 9000 ? `${(extMv / 1000).toFixed(0)}v` : null,
                label: 'External Battery',
                show: extMv != null,
              },
              {
                icon: battMv != null && battPct(battMv) <= 20
                  ? <BatteryLow size={18} color="#ef4444" />
                  : battMv != null && battPct(battMv) <= 50
                    ? <BatteryMedium size={18} color="#f97316" />
                    : battMv != null && battPct(battMv) <= 80
                      ? <BatteryFull size={18} color="#eab308" />
                      : <BatteryFull size={18} color="#22c55e" />,
                value: battMv != null ? `${battPct(battMv)}%` : null,
                label: 'Internal Battery',
                show: battMv != null,
              },
              {
                icon: <Satellite size={18} color={(selectedMapDevice?.satellites || 0) >= 6 ? '#22c55e' : '#f97316'} />,
                value: selectedMapDevice?.satellites ?? null,
                label: 'Satellite Count',
                show: selectedMapDevice?.satellites != null,
              },
              {
                icon: <DeviceSignalIcon gsm={gsm} size={18} />,
                value: gsm != null ? `${gsm}` : null,
                label: 'GSM Signal Strength',
                show: gsm != null,
              },
            ].filter(r => r.show);

            return (
              <div>
                {/* Telemetry rows */}
                <div style={{ borderBottom: '1px solid var(--border)' }}>
                  {telemetryRows.length === 0 ? (
                    <div style={{ padding: '16px 14px', fontSize: 12, color: 'var(--muted)' }}>
                      No telemetry data yet — waiting for the device to send a ping.
                    </div>
                  ) : telemetryRows.map((row, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: i < telemetryRows.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <div style={{ width: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{row.icon}</div>
                      <div style={{ width: 44, fontWeight: 700, fontSize: 15, flexShrink: 0 }}>{row.value}</div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{row.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{ts ? fmtSASTtime(ts) : '—'}</div>
                    </div>
                  ))}
                </div>

                {/* Rider + location + odometer */}
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {selectedMapDevice?.rider_name && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Activity size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{selectedMapDevice.rider_name}</span>
                    </div>
                  )}
                  {ts && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Clock size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtSAST(ts)}</span>
                    </div>
                  )}
                  {(address || (selectedMapDevice?.lat && selectedMapDevice?.lng)) && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <MapPin size={14} style={{ color: 'var(--primary)', flexShrink: 0, marginTop: 2 }} />
                      <div>
                        <div style={{ fontSize: 12, lineHeight: 1.4 }}>{address || 'Resolving address…'}</div>
                        {selectedMapDevice?.lat && (
                          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace', marginTop: 2 }}>
                            [{selectedMapDevice.lat.toFixed(4)}, {selectedMapDevice.lng.toFixed(4)}]
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {selectedMapDevice?.odometer_km != null && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 2 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600 }}>
                        <Route size={13} style={{ color: 'var(--muted)' }} />{Number(selectedMapDevice.odometer_km).toLocaleString()} km
                      </span>
                    </div>
                  )}
                </div>

                {/* Today's activity */}
                <div style={{ padding: '10px 14px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    Today's activity
                    <button className="btn btn-sm" style={{ padding: '1px 5px', marginLeft: 'auto', background: 'transparent' }}
                      onClick={() => selectedDevice.bike_id && loadTrips(selectedDevice.bike_id)}><RefreshCw size={10} /></button>
                  </div>
                  {!selectedDevice.bike_id ? (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>No bike assigned to this device.</div>
                  ) : trips.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>No trips loaded — select this device to load trips.</div>
                  ) : todayTrips.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>No trips recorded today.</div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: '#22c55e' }}>
                          <Route size={12} />{todayKm.toFixed(1)} km
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>
                          <Clock size={12} />{fmtDuration(todaySec)}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                          {todayTrips.length} trip{todayTrips.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {todayTrips.slice(0, 5).map(t => {
                        const ongoing = !t.ended_at;
                        return (
                          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--border)', fontSize: 11 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: ongoing ? '#22c55e' : 'var(--muted)', flexShrink: 0 }} />
                            <span style={{ color: 'var(--muted)', minWidth: 42 }}>{fmtSASTtime(t.started_at)}</span>
                            <span style={{ flex: 1, color: 'var(--text)', fontWeight: 600 }}>{t.distance_km != null ? `${Number(t.distance_km).toFixed(1)} km` : '—'}</span>
                            <span style={{ color: 'var(--muted)' }}>{fmtDuration(t.duration_sec)}</span>
                            {ongoing && <span style={{ fontSize: 9, fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,.12)', padding: '1px 5px', borderRadius: 6 }}>live</span>}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ── Bike tab ─────────────────────────────────────────── */}
          {detailTab === 'bike' && (
            <div style={{ padding: '14px' }}>
              {!selectedDevice.bike_id ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No bike linked to this device.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {[
                    { label: 'Registration', value: selectedDevice.registration },
                    { label: 'Make', value: selectedDevice.make },
                    { label: 'Model', value: selectedDevice.bike_model },
                    { label: 'Year', value: selectedDevice.bike_year },
                    { label: 'Colour', value: selectedDevice.bike_color },
                    { label: 'VIN', value: selectedDevice.bike_vin, mono: true },
                  ].map(({ label, value, mono }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'baseline', padding: '10px 0', borderBottom: '1px solid var(--border)', gap: 12 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)', width: 90, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>{value || '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Driver tab ───────────────────────────────────────── */}
          {detailTab === 'driver' && (
            <div style={{ padding: '14px' }}>
              {!selectedDevice.rider_name ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No active rider assigned to this bike.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {[
                    { label: 'Full name', value: selectedDevice.rider_name },
                    { label: 'Phone', value: selectedDevice.rider_phone },
                    { label: 'Address', value: selectedDevice.rider_address },
                    { label: 'City', value: selectedDevice.rider_city },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)', gap: 12 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)', width: 90, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '.4px', paddingTop: 1 }}>{label}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>{value || '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Info tab ─────────────────────────────────────────── */}
          {detailTab === 'info' && <>

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
                        Updated {fmtSASTtime(selectedMapDevice.last_location_at)}
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
                    { icon: <Satellite size={13} />,   label: 'Satellites', value: `${selectedMapDevice.satellites || '?'}`,              color: (selectedMapDevice.satellites || 0) >= 6 ? '#22c55e' : '#f97316' },
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
                {/* Signal / battery row */}
                {(() => {
                  const io = parseIo(selectedMapDevice.io_data);
                  const gsm    = selectedMapDevice.gsm_signal    ?? io.gsm;
                  const battMv = selectedMapDevice.battery_mv    ?? io.battMv;
                  const extMv  = selectedMapDevice.ext_voltage_mv ?? io.extMv;
                  const hasBatt = battMv != null || extMv != null;
                  const hasGsm  = gsm != null;
                  if (!hasBatt && !hasGsm) return null;
                  const battLabel = extMv != null && extMv > 9000
                    ? `External power (${(extMv/1000).toFixed(1)} V)`
                    : battMv != null ? `Battery ${battPct(battMv)}%` : null;
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: hasGsm && hasBatt ? '1fr 1fr' : '1fr', gap: 8, marginBottom: 8 }}>
                      {hasGsm && (
                        <div style={{ background: 'var(--surface)', borderRadius: 8, padding: '8px 10px', border: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', marginBottom: 4 }}>
                            <DeviceSignalIcon gsm={gsm} size={13} />
                            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px' }}>GSM signal</span>
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 16, color: gsm >= 3 ? '#22c55e' : gsm >= 2 ? '#eab308' : '#ef4444' }}>{gsm} / 5</div>
                        </div>
                      )}
                      {hasBatt && (
                        <div style={{ background: 'var(--surface)', borderRadius: 8, padding: '8px 10px', border: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', marginBottom: 4 }}>
                            <DeviceBatteryIcon battMv={battMv} extMv={extMv} size={13} />
                            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px' }}>Power</span>
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: extMv != null && extMv > 9000 ? '#22c55e' : battMv != null && battPct(battMv) <= 20 ? '#ef4444' : 'var(--text)' }}>{battLabel}</div>
                        </div>
                      )}
                    </div>
                  );
                })()}
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
                    <Icon size={11} />{sendingCmd === id ? '…' : label}
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
                : commands.map(c => {
                  const parsed = parseCommandResponse(c.command, c.response);
                  return (
                    <div key={c.id} style={{ marginBottom: 12, padding: '8px 10px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                        {STATUS_ICON[c.status] || <AlertCircle size={12} />}
                        <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{getCmdLabel(c.command)}</span>
                        <span style={{ fontSize: 10, color: c.status === 'delivered' ? '#22c55e' : c.status === 'failed' ? '#ef4444' : 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>
                          {c.status === 'delivered' ? 'Delivered' : c.status === 'sent' ? 'Sent' : c.status === 'pending' ? 'Queued' : 'Failed'}
                        </span>
                      </div>
                      {c.response && (
                        parsed ? (
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {parsed.map((row, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                <span style={{ fontSize: 10, color: 'var(--muted)', minWidth: 80, flexShrink: 0 }}>{row.label}</span>
                                <span style={{ fontSize: 11, fontWeight: 600, color: row.error ? '#ef4444' : row.warn ? '#f97316' : 'var(--text)' }}>{row.value}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ marginTop: 4, padding: '3px 6px', background: 'rgba(0,0,0,.04)', borderRadius: 4, fontSize: 10, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--muted)' }}>
                            {c.response}
                          </div>
                        )
                      )}
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 5 }}>
                        {fmtSAST(c.created_at)}{c.created_by_name ? ` · ${c.created_by_name}` : ''}
                      </div>
                    </div>
                  );
                })}
            </div>
          </>}

          {/* ── Trips tab ────────────────────────────────────────── */}
          {detailTab === 'trips' && (
            <div style={{ padding: '10px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10, display: 'flex', alignItems: 'center' }}>
                Recent trips
                <button className="btn btn-sm" style={{ padding: '1px 5px', marginLeft: 'auto', background: 'transparent' }}
                  onClick={() => selectedDevice.bike_id && loadTrips(selectedDevice.bike_id)}><RefreshCw size={10} /></button>
              </div>
              {!selectedDevice.bike_id ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>This device has no bike assigned. Assign a bike to record trips.</div>
              ) : trips.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No trips recorded yet. Trips start when the ignition turns on and the bike moves.</div>
              ) : trips.map(t => {
                const dist = t.distance_km != null ? `${Number(t.distance_km).toFixed(1)} km` : '—';
                const dur  = fmtDuration(t.duration_sec);
                const maxS = t.max_speed_kmh != null ? `${Math.round(t.max_speed_kmh)} km/h` : '—';
                const ongoing = !t.ended_at;
                return (
                  <div key={t.id} style={{ marginBottom: 8, padding: '9px 10px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)', borderLeft: `3px solid ${ongoing ? '#22c55e' : 'var(--border)'}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>{fmtSAST(t.started_at)}</span>
                      {ongoing && <span style={{ fontSize: 10, fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,.12)', padding: '1px 6px', borderRadius: 8 }}>active</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      {[
                        { icon: <Route size={11} />,  val: dist },
                        { icon: <Clock size={11} />,  val: dur },
                        { icon: <Gauge size={11} />,  val: `max ${maxS}` },
                      ].map(({ icon, val }) => (
                        <span key={val} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
                          {icon}{val}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Add device modal ──────────────────────────────────────── */}
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
            <BikeCombobox bikes={bikes} value={addForm.bike_id} onChange={v => setAddForm(f => ({ ...f, bike_id: v }))} />
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

      {/* ── Edit device modal ────────────────────────────────────── */}
      {showEditDevice && selected && (() => {
        const dev = devices.find(d => d.id === selected);
        return (
          <Modal onClose={() => setShowEditDevice(false)} title={`Edit device · ${dev?.label || dev?.registration || dev?.imei}`}>
            <div className="field">
              <label className="label">Device model</label>
              <select className="input" value={editDeviceForm.model} onChange={e => setEditDeviceForm(f => ({ ...f, model: e.target.value }))}>
                {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Determines which engine-cut command is used</div>
            </div>

            <div className="field">
              <label className="label">Linked bike</label>
              <BikeCombobox
                bikes={bikes}
                value={editDeviceForm.bike_id}
                onChange={v => setEditDeviceForm(f => ({ ...f, bike_id: v }))}
              />
              {editDeviceForm.bike_id && (
                <div style={{ fontSize: 11, color: '#22c55e', marginTop: 4 }}>
                  ✓ Linked — GPS positions will be stored for this bike
                </div>
              )}
              {!editDeviceForm.bike_id && (
                <div style={{ fontSize: 11, color: '#f97316', marginTop: 4 }}>
                  No bike linked — positions will not be stored until you assign one
                </div>
              )}
            </div>

            <div className="field">
              <label className="label">Friendly name <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
              <input className="input" placeholder="e.g. Sipho's Honda" value={editDeviceForm.label}
                onChange={e => setEditDeviceForm(f => ({ ...f, label: e.target.value }))} />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button className="btn btn-primary" onClick={saveDeviceEdit} disabled={savingEdit}>
                {savingEdit ? 'Saving…' : 'Save changes'}
              </button>
              <button className="btn btn-secondary" onClick={() => setShowEditDevice(false)}>Cancel</button>
            </div>
          </Modal>
        );
      })()}

      {/* ── Add geofence modal ───────────────────────────────────── */}
      {showGeoForm && (
        <Modal onClose={() => { setShowGeoForm(false); setGeoForm(EMPTY_GEO); }} title="Add geofence">
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, marginTop: -4, lineHeight: 1.5 }}>
            Define a zone. You will get an alert whenever a bike enters or exits the boundary.
          </p>

          <div className="field">
            <label className="label">Zone name <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input className="input" placeholder="e.g. Depot, School zone, Client site" value={geoForm.name}
              onChange={e => setGeoForm(f => ({ ...f, name: e.target.value }))} autoFocus />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="field">
              <label className="label">Latitude</label>
              <input className="input" value={geoForm.lat} placeholder="-26.2044"
                onChange={e => setGeoForm(f => ({ ...f, lat: e.target.value }))} />
            </div>
            <div className="field">
              <label className="label">Longitude</label>
              <input className="input" value={geoForm.lng} placeholder="28.0456"
                onChange={e => setGeoForm(f => ({ ...f, lng: e.target.value }))} />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <button
              className="btn btn-sm btn-secondary"
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
              onClick={() => { setShowGeoForm(false); setPickingCenter(true); setSideTab('geofences'); }}
            >
              <MapPin size={11} />Pick center from map
            </button>
            {geoForm.lat && geoForm.lng && (
              <div style={{ fontSize: 10, color: '#22c55e', marginTop: 4 }}>Center set: {Number(geoForm.lat).toFixed(5)}, {Number(geoForm.lng).toFixed(5)}</div>
            )}
          </div>

          <div className="field">
            <label className="label">Radius: {geoForm.radius_m >= 1000 ? `${(geoForm.radius_m / 1000).toFixed(1)} km` : `${geoForm.radius_m} m`}</label>
            <input type="range" min={50} max={10000} step={50} value={geoForm.radius_m}
              onChange={e => setGeoForm(f => ({ ...f, radius_m: Number(e.target.value) }))}
              style={{ width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
              <span>50 m</span><span>10 km</span>
            </div>
          </div>

          <div className="field">
            <label className="label">Scope to bike <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
            <select className="input" value={geoForm.bike_id} onChange={e => setGeoForm(f => ({ ...f, bike_id: e.target.value }))}>
              <option value="">All bikes</option>
              {bikes.map(b => <option key={b.id} value={b.id}>{b.registration} — {b.make} {b.model}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <button className="btn btn-primary" onClick={saveGeofence} disabled={geoSubmitting}>
              {geoSubmitting ? 'Saving…' : 'Save geofence'}
            </button>
            <button className="btn btn-secondary" onClick={() => { setShowGeoForm(false); setGeoForm(EMPTY_GEO); }}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

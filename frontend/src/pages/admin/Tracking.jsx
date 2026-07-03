import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Wifi, WifiOff, Zap, ZapOff, Radio, Info, RefreshCw, Plus, Trash2, Settings, Terminal, CheckCircle, Clock, XCircle, AlertCircle } from 'lucide-react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui';

// Fix Leaflet default marker icons with Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
  shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
});

function makeIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

const ICONS = {
  online_ignition: makeIcon('#22c55e'),   // green — online + ignition on
  online_idle: makeIcon('#f97316'),       // orange — online + ignition off
  offline: makeIcon('#94a3b8'),           // gray — offline
};

function deviceIcon(d) {
  if (!d.connected) return ICONS.offline;
  return d.ignition ? ICONS.online_ignition : ICONS.online_idle;
}

function FlyTo({ position }) {
  const map = useMap();
  useEffect(() => { if (position) map.flyTo(position, 14, { duration: 1 }); }, [position, map]);
  return null;
}

const PRESETS = [
  { id: 'cut_engine', label: 'Cut engine', icon: ZapOff, danger: true },
  { id: 'restore_engine', label: 'Restore engine', icon: Zap },
  { id: 'fota_connect', label: 'FOTA connect', icon: Radio },
  { id: 'get_status', label: 'Get status', icon: Info },
  { id: 'get_info', label: 'Get info', icon: Info },
  { id: 'get_ver', label: 'Get version', icon: Info },
];

const MODELS = ['FMB920', 'FMB965', 'FMC920', 'other'];

const STATUS_ICON = {
  pending: <Clock size={13} style={{ color: '#f97316' }} />,
  sent: <Clock size={13} style={{ color: '#4FA8E0' }} />,
  delivered: <CheckCircle size={13} style={{ color: '#22c55e' }} />,
  failed: <XCircle size={13} style={{ color: '#ef4444' }} />,
};

export default function Tracking() {
  const [devices, setDevices] = useState([]);
  const [mapDevices, setMapDevices] = useState([]);
  const [selected, setSelected] = useState(null);      // tracking_device id
  const [trail, setTrail] = useState([]);
  const [commands, setCommands] = useState([]);
  const [flyTo, setFlyTo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showCmd, setShowCmd] = useState(false);
  const [customCmd, setCustomCmd] = useState('');
  const [bikes, setBikes] = useState([]);
  const [addForm, setAddForm] = useState({ imei: '', model: 'FMB920', bike_id: '', label: '' });
  const [sendingCmd, setSendingCmd] = useState(null);
  const refreshRef = useRef(null);

  // Remove .content padding/scroll so the tracking layout fills edge-to-edge
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
    } catch { /* ignore */ }
  }, []);

  const loadBikes = useCallback(async () => {
    const { data } = await api.get('/bikes?limit=500');
    setBikes(data.bikes || data || []);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadDevices(), loadBikes()]).finally(() => setLoading(false));
    refreshRef.current = setInterval(loadDevices, 15_000);
    return () => clearInterval(refreshRef.current);
  }, [loadDevices, loadBikes]);

  const selectDevice = useCallback(async (device) => {
    setSelected(device.id);
    if (device.lat && device.lng) setFlyTo([device.lat, device.lng]);
    try {
      const [{ data: pos }, { data: cmds }] = await Promise.all([
        api.get(`/tracking/devices/${device.id}/positions?limit=300`),
        api.get(`/tracking/devices/${device.id}/commands`),
      ]);
      setTrail(pos.map((p) => [p.lat, p.lng]));
      setCommands(cmds);
    } catch { /* ignore */ }
  }, []);

  const refreshCommands = useCallback(async () => {
    if (!selected) return;
    const { data } = await api.get(`/tracking/devices/${selected}/commands`);
    setCommands(data);
  }, [selected]);

  const sendPreset = useCallback(async (presetId) => {
    if (!selected) return;
    setSendingCmd(presetId);
    try {
      const { data } = await api.post(`/tracking/devices/${selected}/commands`, { preset: presetId });
      toast.success(data.note || 'Command queued');
      await refreshCommands();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    } finally {
      setSendingCmd(null);
    }
  }, [selected, refreshCommands]);

  const sendCustom = useCallback(async () => {
    if (!customCmd.trim() || !selected) return;
    setSendingCmd('custom');
    try {
      const { data } = await api.post(`/tracking/devices/${selected}/commands`, { command: customCmd.trim() });
      toast.success(data.note || 'Command queued');
      setCustomCmd('');
      setShowCmd(false);
      await refreshCommands();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    } finally {
      setSendingCmd(null);
    }
  }, [customCmd, selected, refreshCommands]);

  const addDevice = useCallback(async () => {
    if (!addForm.imei) return toast.error('IMEI required');
    try {
      await api.post('/tracking/devices', { ...addForm, bike_id: addForm.bike_id || null });
      toast.success('Device registered');
      setShowAdd(false);
      setAddForm({ imei: '', model: 'FMB920', bike_id: '', label: '' });
      await loadDevices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  }, [addForm, loadDevices]);

  const deleteDevice = useCallback(async (id) => {
    if (!window.confirm('Remove this device?')) return;
    try {
      await api.delete(`/tracking/devices/${id}`);
      if (selected === id) { setSelected(null); setTrail([]); setCommands([]); }
      await loadDevices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  }, [selected, loadDevices]);

  const selectedDevice = devices.find((d) => d.id === selected);
  const selectedMapDevice = mapDevices.find((d) => d.id === selected);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - 64px)' }}>
      <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading tracking…</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{ width: 280, minWidth: 280, overflowY: 'auto', borderRight: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 12px 10px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', background: 'var(--surface)' }}>
          <span style={{ fontWeight: 700, fontSize: 14, flex: 1, color: 'var(--text)' }}>GPS Devices</span>
          <button className="btn btn-sm btn-secondary" title="Refresh" onClick={loadDevices}><RefreshCw size={13} /></button>
          <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(true)} title="Register device"><Plus size={13} /> Add</button>
        </div>

        {devices.length === 0 && (
          <div style={{ padding: '32px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📡</div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>No devices registered</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>Add a Teltonika tracker to get started</div>
            <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(true)}><Plus size={12} /> Register device</button>
          </div>
        )}

        {devices.map((d) => {
          const isSelected = d.id === selected;
          const md = mapDevices.find((m) => m.id === d.id);
          return (
            <div
              key={d.id}
              onClick={() => selectDevice(md || d)}
              style={{
                padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                background: isSelected ? 'rgba(30,136,209,.12)' : 'transparent',
                borderLeft: isSelected ? '3px solid var(--primary)' : '3px solid transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {d.connected
                  ? <Wifi size={13} color="#22c55e" />
                  : <WifiOff size={13} color="#94a3b8" />}
                <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
                  {d.label || d.registration || d.imei}
                </span>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{d.model}</span>
                <button
                  className="btn btn-sm"
                  style={{ padding: '1px 4px', opacity: 0.6 }}
                  onClick={(e) => { e.stopPropagation(); deleteDevice(d.id); }}
                  title="Remove device"
                ><Trash2 size={11} /></button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, paddingLeft: 19 }}>
                {d.registration && <span>{d.registration} · </span>}
                {d.imei}
              </div>
              {d.last_seen_at && (
                <div style={{ fontSize: 10, color: 'var(--muted)', paddingLeft: 19, marginTop: 1 }}>
                  Last seen {new Date(d.last_seen_at).toLocaleString()}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Map */}
      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer
          center={[-26.2, 28.0]}
          zoom={10}
          style={{ height: '100%', width: '100%' }}
          zoomControl={true}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
          />
          {flyTo && <FlyTo position={flyTo} />}

          {mapDevices.map((d) => (
            d.lat && d.lng ? (
              <Marker
                key={d.id}
                position={[d.lat, d.lng]}
                icon={deviceIcon({ connected: d.connected, ignition: d.ignition })}
                eventHandlers={{ click: () => selectDevice(d) }}
              >
                <Popup>
                  <strong>{d.label || d.registration || d.imei}</strong><br />
                  {d.model} · {d.connected ? '🟢 Online' : '⚫ Offline'}<br />
                  {d.bike_model} {d.registration}<br />
                  Last: {d.last_location_at ? new Date(d.last_location_at).toLocaleString() : '—'}
                </Popup>
              </Marker>
            ) : null
          ))}

          {trail.length > 1 && (
            <Polyline positions={trail} color="#6366f1" weight={2} opacity={0.7} />
          )}
          {trail.length > 0 && (
            <Marker position={trail[0]} icon={makeIcon('#6366f1')}>
              <Popup>Start of trail</Popup>
            </Marker>
          )}
          {trail.length > 1 && (
            <Marker position={trail[trail.length - 1]} icon={deviceIcon(selectedMapDevice || {})}>
              <Popup>Latest position</Popup>
            </Marker>
          )}
        </MapContainer>

        {/* Legend */}
        <div style={{
          position: 'absolute', bottom: 30, right: 10, zIndex: 1000,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 12px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', border: '1px solid #fff' }} />
            Online · ignition on
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#f97316', border: '1px solid #fff' }} />
            Online · ignition off
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#94a3b8', border: '1px solid #fff' }} />
            Offline
          </div>
        </div>
      </div>

      {/* Right panel — selected device */}
      {selectedDevice && (
        <div style={{ width: 300, minWidth: 300, overflowY: 'auto', borderLeft: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              {selectedDevice.connected
                ? <Wifi size={14} color="#22c55e" />
                : <WifiOff size={14} color="#94a3b8" />}
              <span style={{ fontWeight: 700, fontSize: 14 }}>{selectedDevice.label || selectedDevice.registration || selectedDevice.imei}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {selectedDevice.model} · IMEI: {selectedDevice.imei}
            </div>
            {selectedDevice.registration && (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {selectedDevice.make} {selectedDevice.bike_model} · {selectedDevice.registration}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              {selectedDevice.connected ? '🟢 Connected' : `⚫ Last seen ${selectedDevice.last_seen_at ? new Date(selectedDevice.last_seen_at).toLocaleString() : 'never'}`}
            </div>
          </div>

          {/* Commands */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Settings size={13} /> Commands
              {!selectedDevice.connected && (
                <span style={{ fontSize: 10, color: '#f97316', fontWeight: 400 }}>(queued — device offline)</span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {PRESETS.map(({ id, label, icon: Icon, danger }) => (
                <button
                  key={id}
                  className={`btn btn-sm${danger ? ' btn-danger' : ''}`}
                  style={{ justifyContent: 'flex-start', gap: 6, textAlign: 'left' }}
                  disabled={sendingCmd === id}
                  onClick={() => sendPreset(id)}
                >
                  <Icon size={12} />
                  {sendingCmd === id ? 'Sending…' : label}
                </button>
              ))}
              <button
                className="btn btn-sm"
                style={{ justifyContent: 'flex-start', gap: 6 }}
                onClick={() => setShowCmd(true)}
              >
                <Terminal size={12} /> Custom command…
              </button>
            </div>
          </div>

          {/* Command history */}
          <div style={{ padding: '10px 14px', flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Clock size={13} /> Command history
              <button className="btn btn-sm" style={{ padding: '1px 5px', marginLeft: 'auto' }} onClick={refreshCommands} title="Refresh"><RefreshCw size={11} /></button>
            </div>
            {commands.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No commands yet.</div>}
            {commands.map((c) => (
              <div key={c.id} style={{ marginBottom: 10, fontSize: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {STATUS_ICON[c.status] || <AlertCircle size={13} />}
                  <code style={{ fontSize: 11, background: 'var(--surface)', padding: '1px 4px', borderRadius: 3 }}>{c.command}</code>
                  <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 'auto' }}>{c.status}</span>
                </div>
                {c.response && (
                  <div style={{ marginTop: 2, padding: '3px 6px', background: 'var(--surface)', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {c.response}
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
                  {new Date(c.created_at).toLocaleString()}
                  {c.created_by_name && ` · ${c.created_by_name}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add device modal */}
      <Modal isOpen={showAdd} onClose={() => setShowAdd(false)} title="Register Teltonika device">
        <div className="field">
          <label className="label">IMEI *</label>
          <input className="input" placeholder="e.g. 356173060025489" value={addForm.imei} onChange={(e) => setAddForm((f) => ({ ...f, imei: e.target.value }))} />
        </div>
        <div className="field">
          <label className="label">Device model *</label>
          <select className="input" value={addForm.model} onChange={(e) => setAddForm((f) => ({ ...f, model: e.target.value }))}>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label">Assign to bike</label>
          <select className="input" value={addForm.bike_id} onChange={(e) => setAddForm((f) => ({ ...f, bike_id: e.target.value }))}>
            <option value="">— unassigned —</option>
            {bikes.map((b) => (
              <option key={b.id} value={b.id}>{b.registration} — {b.make} {b.model}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label">Label (optional)</label>
          <input className="input" placeholder="e.g. Sipho's bike" value={addForm.label} onChange={(e) => setAddForm((f) => ({ ...f, label: e.target.value }))} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={addDevice}>Register device</button>
          <button className="btn" onClick={() => setShowAdd(false)}>Cancel</button>
        </div>
      </Modal>

      {/* Custom command modal */}
      <Modal isOpen={showCmd} onClose={() => setShowCmd(false)} title="Send custom GPRS command">
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          Device: {selectedDevice?.label || selectedDevice?.imei}
        </div>
        <div className="field">
          <label className="label">Command</label>
          <input
            className="input"
            placeholder="e.g. getparam 2001"
            value={customCmd}
            onChange={(e) => setCustomCmd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendCustom()}
            autoFocus
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" disabled={sendingCmd === 'custom'} onClick={sendCustom}>
            {sendingCmd === 'custom' ? 'Sending…' : 'Send'}
          </button>
          <button className="btn" onClick={() => setShowCmd(false)}>Cancel</button>
        </div>
      </Modal>
    </div>
  );
}

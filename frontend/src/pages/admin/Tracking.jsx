import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Wifi, WifiOff, Zap, ZapOff, Radio, Info, RefreshCw, Plus, Trash2, CheckCircle, Clock, XCircle, AlertCircle, X } from 'lucide-react';
import api from '../../api';
import toast from 'react-hot-toast';
import { Modal } from '../../components/ui';

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
  online_ignition: makeIcon('#22c55e'),
  online_idle:     makeIcon('#f97316'),
  offline:         makeIcon('#94a3b8'),
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

const ENGINE_CMDS = [
  { id: 'cut_engine',     label: 'Cut engine',     desc: 'Disable ignition',  icon: ZapOff, danger: true },
  { id: 'restore_engine', label: 'Restore engine', desc: 'Re-enable ignition', icon: Zap,    danger: false },
];

const DIAG_CMDS = [
  { id: 'get_status',   label: 'Status',       icon: Info },
  { id: 'get_info',     label: 'Device info',  icon: Info },
  { id: 'get_ver',      label: 'Firmware ver', icon: Info },
  { id: 'fota_connect', label: 'FOTA update',  icon: Radio },
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

export default function Tracking() {
  const [devices,    setDevices]    = useState([]);
  const [mapDevices, setMapDevices] = useState([]);
  const [selected,   setSelected]   = useState(null);
  const [trail,      setTrail]      = useState([]);
  const [commands,   setCommands]   = useState([]);
  const [flyTo,      setFlyTo]      = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [showAdd,    setShowAdd]    = useState(false);
  const [bikes,      setBikes]      = useState([]);
  const [addForm,    setAddForm]    = useState(EMPTY_FORM);
  const [adding,     setAdding]     = useState(false);
  const [sendingCmd, setSendingCmd] = useState(null);
  const refreshRef = useRef(null);

  // Remove .content padding so the layout fills edge-to-edge
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
    } catch { /* silent */ }
  }, []);

  const refreshCommands = useCallback(async () => {
    if (!selected) return;
    const { data } = await api.get(`/tracking/devices/${selected}/commands`);
    setCommands(data);
  }, [selected]);

  const sendPreset = useCallback(async (presetId) => {
    if (!selected) return;
    if (presetId === 'cut_engine') {
      const dev = devices.find((d) => d.id === selected);
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
    const dev = devices.find((d) => d.id === id);
    if (!window.confirm(`Remove ${dev?.label || dev?.imei}?`)) return;
    try {
      await api.delete(`/tracking/devices/${id}`);
      if (selected === id) { setSelected(null); setTrail([]); setCommands([]); }
      await loadDevices();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  }, [selected, devices, loadDevices]);

  const selectedDevice    = devices.find((d) => d.id === selected);
  const selectedMapDevice = mapDevices.find((d) => d.id === selected);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - 64px)' }}>
      <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading tracking…</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)', overflow: 'hidden' }}>

      {/* ── Device list sidebar ─────────────────────────────────────── */}
      <div style={{ width: 260, minWidth: 260, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--surface-2)' }}>
        <div style={{ padding: '12px 12px 10px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', background: 'var(--surface)' }}>
          <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>GPS Devices</span>
          <button className="btn btn-sm btn-secondary" title="Refresh" onClick={loadDevices}><RefreshCw size={12} /></button>
          <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(true)}><Plus size={12} /> Add</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {devices.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>📡</div>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>No trackers yet</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
                Register a Teltonika device to start tracking bikes
              </div>
              <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(true)}><Plus size={12} /> Register device</button>
            </div>
          ) : devices.map((d) => {
            const isSelected = d.id === selected;
            return (
              <div
                key={d.id}
                onClick={() => selectDevice(mapDevices.find((m) => m.id === d.id) || d)}
                style={{
                  padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                  borderLeft: `3px solid ${isSelected ? 'var(--primary)' : 'transparent'}`,
                  background: isSelected ? 'rgba(30,136,209,.1)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {d.connected ? <Wifi size={12} color="#22c55e" /> : <WifiOff size={12} color="#94a3b8" />}
                  <span style={{ fontWeight: 600, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.label || d.registration || d.imei}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>{d.model}</span>
                  <button
                    className="btn btn-sm"
                    style={{ padding: '2px 4px', opacity: 0.5, background: 'transparent', minWidth: 0 }}
                    onClick={(e) => deleteDevice(e, d.id)}
                    title="Remove"
                  ><Trash2 size={10} /></button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, paddingLeft: 18, fontFamily: 'monospace' }}>
                  {d.imei}
                </div>
                {d.last_seen_at && (
                  <div style={{ fontSize: 10, color: 'var(--muted)', paddingLeft: 18, marginTop: 1 }}>
                    {d.connected ? '🟢 Online' : `Last seen ${new Date(d.last_seen_at).toLocaleString()}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Map ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', isolation: 'isolate' }}>
        <MapContainer center={[-26.2, 28.0]} zoom={10} style={{ height: '100%', width: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
          />
          {flyTo && <FlyTo position={flyTo} />}

          {mapDevices.map((d) => d.lat && d.lng ? (
            <Marker
              key={d.id}
              position={[d.lat, d.lng]}
              icon={deviceIcon(d)}
              eventHandlers={{ click: () => selectDevice(d) }}
            >
              <Popup>
                <strong>{d.label || d.registration || d.imei}</strong><br />
                {d.model} · {d.connected ? '🟢 Online' : '⚫ Offline'}<br />
                {d.bike_model} {d.registration}<br />
                Last ping: {d.last_location_at ? new Date(d.last_location_at).toLocaleString() : '—'}
              </Popup>
            </Marker>
          ) : null)}

          {trail.length > 1 && <Polyline positions={trail} color="#1E88D1" weight={2} opacity={0.7} />}
          {trail.length > 0 && <Marker position={trail[0]} icon={makeIcon('#1E88D1')}><Popup>Start of trail</Popup></Marker>}
          {trail.length > 1 && <Marker position={trail[trail.length - 1]} icon={deviceIcon(selectedMapDevice || {})}><Popup>Latest position</Popup></Marker>}
        </MapContainer>

        <div style={{
          position: 'absolute', bottom: 30, right: 10, zIndex: 1000,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 12px', fontSize: 11,
          display: 'flex', flexDirection: 'column', gap: 5,
        }}>
          {[['#22c55e', 'Online · ignition on'], ['#f97316', 'Online · ignition off'], ['#94a3b8', 'Offline']].map(([color, label]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, border: '1.5px solid rgba(255,255,255,.3)', flexShrink: 0 }} />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* ── Right panel: device detail + commands ───────────────────── */}
      {selectedDevice && (
        <div style={{ width: 300, minWidth: 300, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)', background: 'var(--surface-2)' }}>

          {/* Device header */}
          <div style={{ padding: '14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  {selectedDevice.connected ? <Wifi size={13} color="#22c55e" /> : <WifiOff size={13} color="#94a3b8" />}
                  <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedDevice.label || selectedDevice.registration || selectedDevice.imei}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{selectedDevice.imei}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{selectedDevice.model}{selectedDevice.registration ? ` · ${selectedDevice.registration}` : ''}</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>
                  {selectedDevice.connected
                    ? <span style={{ color: '#22c55e', fontWeight: 600 }}>● Online</span>
                    : <span style={{ color: 'var(--muted)' }}>● Last seen {selectedDevice.last_seen_at ? new Date(selectedDevice.last_seen_at).toLocaleString() : 'never'}</span>}
                </div>
              </div>
              <button className="btn btn-sm btn-secondary" style={{ padding: '3px 6px', flexShrink: 0 }} onClick={() => { setSelected(null); setTrail([]); setCommands([]); }} title="Close"><X size={12} /></button>
            </div>
          </div>

          {/* Engine control */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>Engine control</div>
            {!selectedDevice.connected && (
              <div style={{ fontSize: 11, color: '#f97316', marginBottom: 8, padding: '6px 8px', background: 'rgba(249,115,22,.1)', borderRadius: 6, border: '1px solid rgba(249,115,22,.2)' }}>
                Device offline — commands will be queued and sent when it reconnects
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {ENGINE_CMDS.map(({ id, label, desc, icon: Icon, danger }) => (
                <button
                  key={id}
                  className={`btn btn-sm${danger ? ' btn-danger' : ' btn-secondary'}`}
                  style={{ flexDirection: 'column', alignItems: 'center', gap: 4, padding: '10px 6px', height: 'auto' }}
                  disabled={!!sendingCmd}
                  onClick={() => sendPreset(id)}
                >
                  <Icon size={16} />
                  <span style={{ fontSize: 11, fontWeight: 600 }}>{sendingCmd === id ? '…' : label}</span>
                  <span style={{ fontSize: 10, opacity: .7, fontWeight: 400 }}>{desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Diagnostics */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>Diagnostics</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              {DIAG_CMDS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className="btn btn-sm btn-secondary"
                  style={{ justifyContent: 'center', gap: 5, fontSize: 11 }}
                  disabled={!!sendingCmd}
                  onClick={() => sendPreset(id)}
                >
                  <Icon size={11} />
                  {sendingCmd === id ? '…' : label}
                </button>
              ))}
            </div>
          </div>

          {/* Command history */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8, display: 'flex', alignItems: 'center' }}>
              History
              <button className="btn btn-sm" style={{ padding: '1px 5px', marginLeft: 'auto', background: 'transparent' }} onClick={refreshCommands} title="Refresh"><RefreshCw size={10} /></button>
            </div>
            {commands.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No commands sent yet.</div>
              : commands.map((c) => (
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
      <Modal isOpen={showAdd} onClose={() => { setShowAdd(false); setAddForm(EMPTY_FORM); }} title="Register a GPS tracker">
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18, marginTop: -4, lineHeight: 1.5 }}>
          Enter the IMEI printed on the device label. Once registered, the tracker will automatically connect and appear on the map.
        </p>

        <div className="field">
          <label className="label">IMEI number <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input
            className="input"
            placeholder="15–17 digit number on the device label"
            value={addForm.imei}
            onChange={(e) => setAddForm((f) => ({ ...f, imei: e.target.value.replace(/\D/g, '') }))}
            maxLength={17}
            autoFocus
          />
          {addForm.imei && !/^\d{15,17}$/.test(addForm.imei) && (
            <div style={{ fontSize: 11, color: '#f97316', marginTop: 4 }}>Must be 15–17 digits</div>
          )}
        </div>

        <div className="field">
          <label className="label">Device model <span style={{ color: 'var(--danger)' }}>*</span></label>
          <select className="input" value={addForm.model} onChange={(e) => setAddForm((f) => ({ ...f, model: e.target.value }))}>
            {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Model determines which engine-cut command is used
          </div>
        </div>

        <div className="field">
          <label className="label">Assign to bike <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
          <select className="input" value={addForm.bike_id} onChange={(e) => setAddForm((f) => ({ ...f, bike_id: e.target.value }))}>
            <option value="">— not assigned yet —</option>
            {bikes.map((b) => (
              <option key={b.id} value={b.id}>{b.registration} — {b.make} {b.model}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label">Friendly name <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
          <input
            className="input"
            placeholder="e.g. Sipho's Honda"
            value={addForm.label}
            onChange={(e) => setAddForm((f) => ({ ...f, label: e.target.value }))}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button className="btn btn-primary" onClick={addDevice} disabled={adding}>
            {adding ? 'Registering…' : 'Register device'}
          </button>
          <button className="btn btn-secondary" onClick={() => { setShowAdd(false); setAddForm(EMPTY_FORM); }}>Cancel</button>
        </div>
      </Modal>
    </div>
  );
}

// Shared GPS-tracking display helpers — used by both the live tracking
// console (admin/Tracking.jsx) and the tracking dashboard, so battery/signal
// parsing and SAST time formatting can't drift between the two.
import { Battery, BatteryLow, BatteryMedium, BatteryFull, BatteryCharging, SignalZero, SignalLow, SignalMedium, SignalHigh } from 'lucide-react';

// ── SAST time formatting (Africa/Johannesburg = UTC+2, no DST) ───────────────
export const SAST = { timeZone: 'Africa/Johannesburg' };
export const fmtSASTtime = (d) => d ? new Date(d).toLocaleTimeString('en-ZA', { ...SAST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
export const fmtSAST     = (d) => d ? new Date(d).toLocaleString('en-ZA',     { ...SAST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
export const fmtSASTshort = (d) => d ? new Date(d).toLocaleString('en-ZA',    { ...SAST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
export const todayInSAST = () => new Date().toLocaleDateString('en-CA', SAST); // en-CA → YYYY-MM-DD

// ── Parse Teltonika IO data JSON to useful values ─────────────────────────────
export function parseIo(ioData) {
  try {
    const io = typeof ioData === 'string' ? JSON.parse(ioData) : (ioData || {});
    return {
      gsm:    io[21] != null ? Number(io[21]) : null,   // 0–5 signal level
      // Teltonika Permanent I/O elements: 66 = External Voltage, 67 = Battery Voltage (device's own cell)
      battMv: io[67] != null ? Number(io[67]) : null,   // internal battery mV
      extMv:  io[66] != null ? Number(io[66]) : null,   // external power mV
    };
  } catch { return { gsm: null, battMv: null, extMv: null }; }
}

// Battery % from mV (3200 mV = 0 %, 4200 mV = 100 %) — the tracker's own internal backup cell (Li-ion)
export function battPct(mv) { return Math.min(100, Math.max(0, Math.round((mv - 3200) / 10))); }

// External battery % from mV — the bike's 12V lead-acid electrical system the tracker is wired
// into (11.0 V = 0 %, 12.8 V = 100 %, clamped). A low/zero reading means the tracker has lost
// that connection (dead battery or disconnected wiring), which is exactly what "0%" should show.
export function extBattPct(mv) { return Math.min(100, Math.max(0, Math.round((mv - 11000) / 18))); }

export function DeviceBatteryIcon({ battMv, extMv, size = 12 }) {
  if (extMv != null && extMv > 9000) return <BatteryCharging size={size} color="#22c55e" title={`External power: ${(extMv / 1000).toFixed(1)} V (${extBattPct(extMv)}%)`} />;
  if (battMv == null) return <Battery size={size} color="var(--muted)" title="No battery data" />;
  const pct = battPct(battMv);
  if (pct <= 20) return <BatteryLow   size={size} color="#ef4444" title={`Battery: ${pct}%`} />;
  if (pct <= 50) return <BatteryMedium size={size} color="#f97316" title={`Battery: ${pct}%`} />;
  if (pct <= 80) return <BatteryFull   size={size} color="#eab308" title={`Battery: ${pct}%`} />;
  return <BatteryCharging size={size} color="#22c55e" title={`Battery: ${pct}%`} />;
}

export function DeviceSignalIcon({ gsm, size = 12 }) {
  if (gsm == null) return <SignalZero size={size} color="var(--muted)" title="No signal data" />;
  if (gsm === 0)   return <SignalZero size={size} color="#ef4444"      title="No signal" />;
  if (gsm <= 1)    return <SignalLow    size={size} color="#ef4444"    title={`Signal: ${gsm}/5`} />;
  if (gsm <= 2)    return <SignalMedium size={size} color="#f97316"    title={`Signal: ${gsm}/5`} />;
  if (gsm <= 3)    return <SignalMedium size={size} color="#eab308"    title={`Signal: ${gsm}/5`} />;
  return <SignalHigh size={size} color="#22c55e" title={`Signal: ${gsm}/5`} />;
}

export const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

// Devices worth a second look, derived from already-fetched /tracking/devices
// + /tracking/map rows (no extra request). Shared by the Health tab in the
// live console and the tracking dashboard's "Needs attention" panel.
export function computeDeviceHealth(devices, mapDevices) {
  return devices.map(d => {
    const mapD = mapDevices.find(m => m.id === d.id);
    const io = parseIo(mapD?.io_data);
    const battMv = mapD?.battery_mv ?? io.battMv;
    const gsm = mapD?.gsm_signal ?? io.gsm;
    const sats = mapD?.satellites;
    const pct = battMv != null ? battPct(battMv) : null;
    const reasons = [];
    if (d.device_status === 'offline') reasons.push({ key: 'offline', text: `Offline${d.last_seen_at ? ` since ${fmtSASTshort(d.last_seen_at)}` : ''}`, severity: 'high' });
    if (pct != null && pct <= 20) reasons.push({ key: 'battery_critical', text: `Internal battery ${pct}%`, severity: 'high' });
    if (gsm != null && gsm <= 1) reasons.push({ key: 'poor_signal', text: 'Poor GSM signal', severity: 'medium' });
    if (d.device_status === 'active' && sats != null && sats < 4) reasons.push({ key: 'weak_gps', text: `Weak GPS fix (${sats} sats)`, severity: 'medium' });
    if (!d.bike_id) reasons.push({ key: 'no_bike', text: 'No bike linked', severity: 'low' });
    const signature = reasons.map(r => r.key).sort().join(',');
    return { device: d, mapD, reasons, signature };
  }).filter(h => h.reasons.length > 0 && h.signature !== h.device.health_ack_signature)
    .sort((a, b) => {
      const rankOf = (h) => Math.min(...h.reasons.map(r => SEVERITY_RANK[r.severity]));
      return rankOf(a) - rankOf(b);
    });
}

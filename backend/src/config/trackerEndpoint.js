'use strict';

// Where a physical tracker should be told to connect.
//
// This is the one fact an installer cannot get wrong and recover from: a
// tracker pointed at the wrong address is a tracker nobody can reach, and
// fixing it needs SMS to its SIM or a USB cable at the bike. So the platform
// states it from live configuration rather than from a string typed into a
// document months ago.
//
// Three sources, in order:
//
//  1. TRACKER_PUBLIC_HOST / TRACKER_PUBLIC_PORT — a hostname we own, pointed
//     at the proxy by a CNAME. This is what devices should be given: if the
//     proxy ever moves, a DNS change follows it and every tracker already in
//     the field keeps working, untouched.
//  2. RAILWAY_TCP_PROXY_DOMAIN / RAILWAY_TCP_PROXY_PORT — injected by Railway
//     and always current. Without an override the platform still reports the
//     truth, and follows Railway if it reassigns the proxy.
//  3. The values as they stood when this was written, so a machine with no
//     environment at all (a test, a local run) still answers sensibly.
//
// The port is deliberately not defaulted to the application port: 50150 is
// what the process listens on *inside* Railway's network, and giving it to a
// device is the mistake this module exists to stop.

const FALLBACK_HOST = 'hayabusa.proxy.rlwy.net';
const FALLBACK_PORT = 52322;

function trackerEndpoint(env = process.env) {
  const custom = (env.TRACKER_PUBLIC_HOST || '').trim();
  const railway = (env.RAILWAY_TCP_PROXY_DOMAIN || '').trim();

  const host = custom || railway || FALLBACK_HOST;
  const port = Number(
    (custom && env.TRACKER_PUBLIC_PORT)
    || env.TRACKER_PUBLIC_PORT
    || env.RAILWAY_TCP_PROXY_PORT
    || FALLBACK_PORT
  );

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : FALLBACK_PORT,
    protocol: 'TCP',
    // True when devices are being pointed at a name we control, which is the
    // state that survives the proxy moving.
    own_hostname: !!custom,
    // What Railway currently says, so the dashboard can show a drift between
    // the two — that is the moment the CNAME needs updating.
    proxy_host: railway || null,
    proxy_port: env.RAILWAY_TCP_PROXY_PORT ? Number(env.RAILWAY_TCP_PROXY_PORT) : null,
  };
}

// True when we are handing devices our own hostname but it no longer points
// at the proxy Railway is actually serving — new installs would be fine and
// existing ones would go dark, so it is worth saying loudly.
function endpointDrift(endpoint) {
  if (!endpoint.own_hostname || !endpoint.proxy_port) return null;
  if (endpoint.port === endpoint.proxy_port) return null;
  return `Devices are told port ${endpoint.port}, but Railway's proxy is on ${endpoint.proxy_port}.`;
}

module.exports = { trackerEndpoint, endpointDrift, FALLBACK_HOST, FALLBACK_PORT };

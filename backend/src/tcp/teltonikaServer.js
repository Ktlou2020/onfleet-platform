'use strict';

const net  = require('net');
const dgram = require('dgram');
const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');
const geofenceService = require('../services/geofenceService');
const tripService = require('../services/tripService');
const riskService = require('../services/riskService');
const { cutCommandForModel } = require('../services/engineCommands');

// Active TCP connections keyed by IMEI
const connections = new Map();
// Last remote IP from each device's most recent TCP connection
const deviceAddresses = new Map(); // IMEI → remote IP string

// Send a UDP wake packet to the device's last known IP on the server's TCP port.
// Triggers the device to reconnect and pick up any pending queued commands.
let _tcpPort = 5000;
function sendWakePacket(imei) {
  const address = deviceAddresses.get(imei);
  if (!address) return false;
  try {
    const client = dgram.createSocket('udp4');
    const msg = Buffer.from([0x00]);
    client.send(msg, _tcpPort, address, (err) => {
      client.close();
      if (err) console.warn(`[Teltonika] wake packet failed for ${imei}:`, err.message);
      else console.log(`[Teltonika] wake → ${address}:${_tcpPort} (${imei})`);
    });
    return true;
  } catch (err) {
    console.warn(`[Teltonika] wake error for ${imei}:`, err.message);
    return false;
  }
}

// ── CRC-16/ARC ────────────────────────────────────────────────────────────────
function crc16(buf, start, len) {
  let crc = 0;
  for (let i = start; i < start + len; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc >>> 0;
}

// ── Codec 12 GPRS command packet builder ──────────────────────────────────────
function buildCommandPacket(command) {
  const cmd = Buffer.from(command, 'ascii');
  const dataLen = 8 + cmd.length;
  const packet = Buffer.alloc(4 + 4 + dataLen + 4);
  let o = 0;
  packet.writeUInt32BE(0, o); o += 4;
  packet.writeUInt32BE(dataLen, o); o += 4;
  packet[o++] = 0x0c;
  packet[o++] = 0x01;
  packet[o++] = 0x05;
  packet.writeUInt32BE(cmd.length, o); o += 4;
  cmd.copy(packet, o); o += cmd.length;
  packet[o++] = 0x01;
  packet.writeUInt32BE(crc16(packet, 8, dataLen), o);
  return packet;
}

// ── Parse Codec 8 / 8E AVL ────────────────────────────────────────────────────
function parseAvl(buf, extended) {
  let o = 1; // skip codec_id already validated by caller
  const numData1 = buf[o++];
  const records = [];

  for (let r = 0; r < numData1; r++) {
    const tsHigh = buf.readUInt32BE(o); o += 4;
    const tsLow  = buf.readUInt32BE(o); o += 4;
    const ts = tsHigh * 4294967296 + tsLow;

    o++; // priority

    const lng       = buf.readInt32BE(o) / 1e7; o += 4;
    const lat       = buf.readInt32BE(o) / 1e7; o += 4;
    const altitude  = buf.readUInt16BE(o); o += 2;
    const angle     = buf.readUInt16BE(o); o += 2;
    const satellites = buf[o++];
    const speed     = buf.readUInt16BE(o); o += 2;

    if (extended) { o += 2; o += 2; } else { o++; o++; }

    const io = {};
    const sizes = [1, 2, 4, 8];
    for (const sz of sizes) {
      const cnt = extended ? buf.readUInt16BE(o) : buf[o];
      o += extended ? 2 : 1;
      for (let i = 0; i < cnt; i++) {
        const id = extended ? buf.readUInt16BE(o) : buf[o];
        o += extended ? 2 : 1;
        if (sz === 1) { io[id] = buf[o]; o += 1; }
        else if (sz === 2) { io[id] = buf.readUInt16BE(o); o += 2; }
        else if (sz === 4) { io[id] = buf.readUInt32BE(o); o += 4; }
        else { io[id] = buf.readBigUInt64BE(o).toString(); o += 8; }
      }
    }
    if (extended) {
      const xCnt = buf.readUInt16BE(o); o += 2;
      for (let i = 0; i < xCnt; i++) {
        const id   = buf.readUInt16BE(o); o += 2;
        const xLen = buf.readUInt16BE(o); o += 2;
        io[id] = buf.slice(o, o + xLen).toString('hex');
        o += xLen;
      }
    }

    if (lat !== 0 || lng !== 0) {
      records.push({ ts, lat, lng, altitude, angle, satellites, speed, io });
    }
  }

  return { numData1, records };
}

// ── Pure-parse: returns { ack, pingRecords, commandResponse } ─────────────────
// No DB access — all DB work happens async in processPacket()
function parsePacket(packet) {
  if (packet.length < 12) return null;
  const dataLen = packet.readUInt32BE(4);
  const codecId = packet[8];

  if (codecId === 0x08 || codecId === 0x8e) {
    const crcExpected = packet.readUInt32BE(8 + dataLen);
    const crcCalc = crc16(packet, 8, dataLen);
    if (crcExpected !== crcCalc) return { crcError: true };

    let parsed;
    try {
      parsed = parseAvl(packet.slice(8), codecId === 0x8e);
    } catch {
      return null;
    }
    const { numData1, records } = parsed;
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(numData1, 0);
    return { ack, pingRecords: records };
  }

  if (codecId === 0x0c) {
    let o = 9;
    o++;
    const type = packet[o++];
    if (type === 0x06) {
      const respLen = packet.readUInt32BE(o); o += 4;
      const commandResponse = packet.slice(o, o + respLen).toString('ascii');
      return { commandResponse };
    }
  }

  return null;
}

// ── Async: write parsed GPS records to Postgres ───────────────────────────────
async function storeRecords(imei, device, records) {
  if (!device?.bike_id || !records.length) return;

  let latestRec = null;
  for (const rec of records) {
    const recAt = new Date(rec.ts).toISOString();
    const ignition = rec.io[239] !== undefined ? rec.io[239] : null;
    await pgDb.query(
      `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, heading, recorded_at, satellites, altitude, ignition, io_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [device.bike_id, rec.lat, rec.lng, rec.speed, rec.angle, recAt,
       rec.satellites, rec.altitude, ignition, JSON.stringify(rec.io)]
    );
    await tripService.processPing(device.bike_id, device.id, rec.lat, rec.lng, rec.speed,
      ignition, recAt, rec.io, device.speed_limit_kmh || 120);
    await geofenceService.checkGeofences(device.bike_id, device.id, rec.lat, rec.lng, recAt);
    try {
      await riskService.evaluatePing(device.bike_id, device.id, rec.lat, rec.lng, rec.speed,
        !!ignition, recAt, rec.io);
    } catch (e) { console.error('[Risk] evaluatePing failed:', e.message); }
    if (!latestRec || rec.ts > latestRec.ts) latestRec = rec;
  }

  if (latestRec) {
    await pgDb.query('UPDATE bikes SET last_known_lat=$1, last_known_lng=$2, last_location_at=$3 WHERE id=$4',
      [latestRec.lat, latestRec.lng, new Date(latestRec.ts).toISOString(), device.bike_id]);
    trackingEvents.emit('ping', {
      imei,
      device_id: device.id,
      bike_id:   device.bike_id,
      lat:       latestRec.lat,
      lng:       latestRec.lng,
      speed:     latestRec.speed,
      heading:   latestRec.angle,
      altitude:  latestRec.altitude,
      satellites: latestRec.satellites,
      ignition:  latestRec.io[239] !== undefined ? latestRec.io[239] : null,
      gsm_signal:    latestRec.io[21] != null ? Number(latestRec.io[21]) : null,
      // Teltonika Permanent I/O elements: 66 = External Voltage, 67 = Battery Voltage (device's own cell)
      battery_mv:    latestRec.io[67] != null ? Number(latestRec.io[67]) : null,
      ext_voltage_mv: latestRec.io[66] != null ? Number(latestRec.io[66]) : null,
      ts: latestRec.ts,
    });
  }
}

// ── Async: mark sent command as delivered ─────────────────────────────────────
async function storeCommandResponse(imei, response) {
  console.log(`[Teltonika] ${imei} → ${response}`);
  const { rows } = await pgDb.query(
    `SELECT tc.id, tc.command FROM tracking_commands tc
     JOIN tracking_devices td ON td.id = tc.device_id
     WHERE td.imei=$1 AND tc.status='sent' ORDER BY tc.sent_at ASC LIMIT 1`,
    [imei]
  );
  if (rows[0]) {
    await pgDb.query(
      `UPDATE tracking_commands SET status='delivered', response=$1, responded_at=NOW() WHERE id=$2`,
      [response, rows[0].id]
    );
  }

  // If this is a getgps response, parse the position and emit it as a real ping
  // Response format: Lat:XX.XXXXXX Long:YY.YYYYYY Alt:ZZZ Speed:0 Dir:0 Sat:N Fix:1 UTC:...
  const latM = response.match(/Lat:([\d.\-]+)/i);
  const lngM = response.match(/Long:([\d.\-]+)/i);
  if (!latM || !lngM) return;

  const lat = parseFloat(latM[1]);
  const lng = parseFloat(lngM[1]);
  if (!lat && !lng) return; // skip 0,0

  const alt = response.match(/Alt:([\d.\-]+)/i)?.[1];
  const spd = response.match(/Speed:([\d.]+)/i)?.[1];
  const sat = response.match(/Sat:(\d+)/i)?.[1];
  const dir = response.match(/Dir:([\d.]+)/i)?.[1];
  const fix = response.match(/Fix:(\d+)/i)?.[1];
  if (fix === '0') return; // no GPS fix — don't store

  const now = new Date().toISOString();
  const { rows: devRows } = await pgDb.query(
    'SELECT * FROM tracking_devices WHERE imei=$1', [imei]
  );
  const device = devRows[0];
  if (!device?.bike_id) return;

  await pgDb.query(
    `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, heading, recorded_at, satellites, altitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [device.bike_id, lat, lng,
     spd != null ? parseFloat(spd) : 0,
     dir != null ? parseFloat(dir) : null,
     now,
     sat != null ? parseInt(sat) : null,
     alt != null ? parseInt(alt) : null]
  );
  await pgDb.query('UPDATE bikes SET last_known_lat=$1, last_known_lng=$2, last_location_at=$3 WHERE id=$4',
    [lat, lng, now, device.bike_id]);
  await pgDb.query('UPDATE tracking_devices SET last_seen_at=NOW() WHERE imei=$1', [imei]);

  trackingEvents.emit('ping', {
    imei,
    device_id:     device.id,
    bike_id:       device.bike_id,
    lat,
    lng,
    speed:         spd != null ? parseFloat(spd) : 0,
    heading:       dir != null ? parseFloat(dir) : null,
    altitude:      alt != null ? parseInt(alt) : null,
    satellites:    sat != null ? parseInt(sat) : null,
    ignition:      null,
    gsm_signal:    null,
    battery_mv:    null,
    ext_voltage_mv: null,
    ts:            Date.now(),
  });
  console.log(`[Teltonika] getgps position stored for ${imei}: ${lat},${lng}`);
}

// ── Dispatch a command to a connected device ──────────────────────────────────
function dispatchCommand(socket, imei, cmdId, command) {
  try {
    socket.write(buildCommandPacket(command));
    pgDb.query(`UPDATE tracking_commands SET status='sent', sent_at=NOW() WHERE id=$1`, [cmdId])
      .catch(console.error);
    console.log(`[Teltonika] → ${imei}: ${command}`);
  } catch (err) {
    console.error(`[Teltonika] send failed (${imei}):`, err.message);
    pgDb.query(`UPDATE tracking_commands SET status='failed' WHERE id=$1`, [cmdId])
      .catch(console.error);
  }
}

// ── Handle one TCP connection ─────────────────────────────────────────────────
function handleConnection(socket) {
  const remoteAddress = socket.remoteAddress?.replace(/^::ffff:/, ''); // strip IPv6 wrapper
  let imei = null;
  let authed = false;
  let cachedDevice = null;
  let buf = Buffer.alloc(0);

  // Serial processing queue: ensures data chunks are processed one at a time
  // even while async DB ops are in flight (prevents interleaved writes)
  let processing = Promise.resolve();

  socket.setTimeout(300_000, () => socket.destroy());

  socket.on('data', (chunk) => {
    if (buf.length + chunk.length > 1024 * 1024) {
      console.warn(`[Teltonika] ${imei || '?'} buffer overflow — disconnecting`);
      socket.destroy();
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    processing = processing.then(() => processBuffer()).catch((e) =>
      console.error(`[Teltonika] processBuffer error (${imei || '?'}):`, e.message)
    );
  });

  async function processBuffer() {
    if (!authed) {
      if (buf.length < 2) return;
      const imeiLen = buf.readUInt16BE(0);
      if (buf.length < 2 + imeiLen) return;
      imei = buf.slice(2, 2 + imeiLen).toString('ascii');
      buf = buf.slice(2 + imeiLen);

      const { rows } = await pgDb.query('SELECT * FROM tracking_devices WHERE imei=$1', [imei]);
      const device = rows[0];
      if (device) {
        socket.write(Buffer.from([0x01]));
        authed = true;
        cachedDevice = device;
        connections.set(imei, socket);
        if (remoteAddress) deviceAddresses.set(imei, remoteAddress);
        await pgDb.query('UPDATE tracking_devices SET connected=TRUE, last_seen_at=NOW() WHERE imei=$1', [imei]);
        console.log(`[Teltonika] + ${imei} (${device.model})`);
        // Flush queued commands
        const { rows: pending } = await pgDb.query(
          `SELECT * FROM tracking_commands WHERE device_id=$1 AND status='pending' ORDER BY created_at ASC`,
          [device.id]
        );
        for (const cmd of pending) dispatchCommand(socket, imei, cmd.id, cmd.command);

        // setdigout does not survive a device power cycle — a rider can defeat
        // an engine cut just by disconnecting/reconnecting the bike battery.
        // Every reconnect is exactly when that would show up, so re-assert the
        // cut here unconditionally (harmless if it was never actually lost)
        // whenever this device is flagged as should-stay-cut.
        if (device.engine_cut_active) {
          const cutCmd = cutCommandForModel(device.model);
          const { rows: cutCmdRows } = await pgDb.query(
            `INSERT INTO tracking_commands (device_id, command, status, created_at) VALUES ($1,$2,'pending',NOW()) RETURNING id`,
            [device.id, cutCmd]
          );
          dispatchCommand(socket, imei, cutCmdRows[0].id, cutCmd);
          console.log(`[Teltonika] Re-asserting engine cut on reconnect for ${imei} (reason: ${device.engine_cut_reason || 'unknown'})`);
        }
      } else {
        socket.write(Buffer.from([0x00]));
        console.log(`[Teltonika] rejected unknown IMEI ${imei}`);
        socket.end();
        return;
      }
    }

    while (buf.length >= 12) {
      if (buf.readUInt32BE(0) !== 0) {
        console.warn(`[Teltonika] ${imei} bad preamble — disconnecting`);
        socket.destroy();
        return;
      }
      const dataLen = buf.readUInt32BE(4);
      const total = 4 + 4 + dataLen + 4;
      if (buf.length < total) break;

      const parsed = parsePacket(buf.slice(0, total));
      buf = buf.slice(total);

      if (!parsed) continue;

      if (parsed.crcError) {
        console.warn(`[Teltonika] ${imei} CRC mismatch`);
        continue;
      }

      if (parsed.ack) {
        socket.write(parsed.ack);
        // Refresh device if bike_id is missing — it may have been linked after this connection was made
        if (!cachedDevice?.bike_id && parsed.pingRecords?.length) {
          try {
            const { rows: fresh } = await pgDb.query('SELECT * FROM tracking_devices WHERE imei=$1', [imei]);
            if (fresh[0]) cachedDevice = fresh[0];
          } catch { /* ignore — use stale cache */ }
        }
        if (!cachedDevice?.bike_id && parsed.pingRecords?.length) {
          console.warn(`[Teltonika] ${imei} has ${parsed.pingRecords.length} record(s) but no bike linked`);
        }
        if (cachedDevice?.bike_id && parsed.pingRecords?.length) {
          await storeRecords(imei, cachedDevice, parsed.pingRecords);
        }
        await pgDb.query('UPDATE tracking_devices SET connected=TRUE, last_seen_at=NOW() WHERE imei=$1', [imei]);
      }

      if (parsed.commandResponse) {
        await storeCommandResponse(imei, parsed.commandResponse);
      }
    }
  }

  socket.on('close', () => {
    if (imei && connections.get(imei) === socket) {
      connections.delete(imei);
      pgDb.query('UPDATE tracking_devices SET connected=FALSE WHERE imei=$1', [imei]).catch(() => {});
      console.log(`[Teltonika] - ${imei}`);
    }
  });

  socket.on('error', (err) =>
    console.error(`[Teltonika] socket error (${imei || '?'}):`, err.message)
  );
}

// ── Public API ────────────────────────────────────────────────────────────────
function sendCommand(imei, cmdId, command) {
  const socket = connections.get(imei);
  if (!socket || socket.destroyed) return false;
  dispatchCommand(socket, imei, cmdId, command);
  return true;
}

function getConnectedIMEIs() {
  return [...connections.keys()];
}

function start(port) {
  _tcpPort = port;
  // Hydrate open trips from Postgres before accepting connections
  tripService.hydrateOpenTrips().catch(console.error);

  const server = net.createServer(handleConnection);
  server.listen(port, () => console.log(`📡 Teltonika TCP server on :${port}`));
  server.on('error', (err) => console.error('[Teltonika] server error:', err));
  return server;
}

// ── Offline alert checker (every 10 min) ──────────────────────────────────────
const offlineAlertCooldowns = new Map();

// Fleet devices are configured to check in only once every 3600s (60 min) while
// stationary (Home Network Min/Send Period). A shorter threshold here fires a
// false "offline" alert on every normal parked/idle period, before the device
// was ever due to check in again. 75 min = the device's own 60-min cycle plus a
// margin for network/reconnect jitter.
const OFFLINE_ALERT_THRESHOLD_MS = 75 * 60_000;

async function checkOfflineDevices() {
  try {
    const threshold = new Date(Date.now() - OFFLINE_ALERT_THRESHOLD_MS).toISOString();
    const { rows: stale } = await pgDb.query(
      `SELECT id, imei, bike_id FROM tracking_devices
       WHERE bike_id IS NOT NULL AND last_seen_at IS NOT NULL AND last_seen_at < $1`,
      [threshold]
    );
    const connectedSet = new Set(connections.keys());
    const cooldownMs = 60 * 60_000;
    const now = Date.now();
    const at = new Date().toISOString();

    for (const dev of stale) {
      if (connectedSet.has(dev.imei)) continue;
      const last = offlineAlertCooldowns.get(dev.id);
      if (last && now - last < cooldownMs) continue;
      offlineAlertCooldowns.set(dev.id, now);

      const payload = JSON.stringify({ imei: dev.imei });
      const { rows } = await pgDb.query(
        `INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at) VALUES ($1,$2,'device_offline',$3,$4) RETURNING id`,
        [dev.bike_id, dev.id, payload, at]
      );
      const { rows: bikeRows } = await pgDb.query('SELECT registration FROM bikes WHERE id = $1', [dev.bike_id]);
      const bike = bikeRows[0];
      trackingEvents.emit('alert', {
        id: rows[0].id,
        bike_id: dev.bike_id,
        device_id: dev.id,
        alert_type: 'device_offline',
        payload,
        bike_registration: bike?.registration || null,
        created_at: at,
        acknowledged_at: null,
      });
      console.warn(`[Teltonika] Offline alert: ${dev.imei}`);
    }
  } catch (e) {
    console.error('[Teltonika] offline check error:', e.message);
  }
}

setInterval(checkOfflineDevices, 10 * 60_000);

module.exports = { start, sendCommand, getConnectedIMEIs, sendWakePacket, trackingEvents };

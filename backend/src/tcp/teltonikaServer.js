'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const db = require('../db');

const trackingEvents = new EventEmitter();
trackingEvents.setMaxListeners(100);

// Active TCP connections keyed by IMEI
const connections = new Map();

// CRC-16/ARC (poly=0xA001, init=0, reflected)
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

// Build a Codec 12 GPRS command packet
function buildCommandPacket(command) {
  const cmd = Buffer.from(command, 'ascii');
  // dataLen = codec_id(1) + qty1(1) + type(1) + cmd_size(4) + cmd(N) + qty2(1)
  const dataLen = 8 + cmd.length;
  const packet = Buffer.alloc(4 + 4 + dataLen + 4);
  let o = 0;
  packet.writeUInt32BE(0, o); o += 4;        // preamble
  packet.writeUInt32BE(dataLen, o); o += 4;  // data field length
  packet[o++] = 0x0c;                        // Codec 12
  packet[o++] = 0x01;                        // quantity 1
  packet[o++] = 0x05;                        // type: GPRS command
  packet.writeUInt32BE(cmd.length, o); o += 4;
  cmd.copy(packet, o); o += cmd.length;
  packet[o++] = 0x01;                        // quantity 2
  packet.writeUInt32BE(crc16(packet, 8, dataLen), o);
  return packet;
}

// Parse Codec 8 or 8E AVL data records
// buf starts at codec_id byte (offset 8 from start of raw packet)
function parseAvl(buf, extended) {
  let o = 1; // skip codec_id already validated by caller
  const numData1 = buf[o++];
  const records = [];

  for (let r = 0; r < numData1; r++) {
    // Timestamp (uint64 BE, ms since epoch)
    const tsHigh = buf.readUInt32BE(o); o += 4;
    const tsLow = buf.readUInt32BE(o); o += 4;
    const ts = tsHigh * 4294967296 + tsLow;

    o++; // priority

    // GPS element
    const lng = buf.readInt32BE(o) / 1e7; o += 4;
    const lat = buf.readInt32BE(o) / 1e7; o += 4;
    const altitude = buf.readUInt16BE(o); o += 2;
    const angle = buf.readUInt16BE(o); o += 2;
    const satellites = buf[o++];
    const speed = buf.readUInt16BE(o); o += 2;

    // IO element header
    if (extended) { o += 2; o += 2; } // event_id (2B) + total_io (2B)
    else { o++; o++; }                 // event_id (1B) + total_io (1B)

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
    // Codec 8E X-byte IOs
    if (extended) {
      const xCnt = buf.readUInt16BE(o); o += 2;
      for (let i = 0; i < xCnt; i++) {
        const id = buf.readUInt16BE(o); o += 2;
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

// Process a complete raw packet (preamble through CRC)
function handlePacket(imei, packet) {
  if (packet.length < 12) return null;
  const dataLen = packet.readUInt32BE(4);
  const codecId = packet[8];

  if (codecId === 0x08 || codecId === 0x8e) {
    // Validate CRC
    const crcExpected = packet.readUInt32BE(8 + dataLen);
    const crcCalc = crc16(packet, 8, dataLen);
    if (crcExpected !== crcCalc) {
      console.warn(`[Teltonika] ${imei} CRC mismatch`);
      return null;
    }

    let parsed;
    try {
      parsed = parseAvl(packet.slice(8), codecId === 0x8e);
    } catch (parseErr) {
      console.warn(`[Teltonika] ${imei} AVL parse error:`, parseErr.message);
      return null;
    }
    const { numData1, records } = parsed;

    const device = db.prepare('SELECT * FROM tracking_devices WHERE imei = ?').get(imei);
    if (device?.bike_id && records.length) {
      const insertPing = db.prepare(
        `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, heading, recorded_at, satellites, altitude, ignition, io_data)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      let latestRec = null;
      for (const rec of records) {
        if (rec.satellites < 1) continue;
        insertPing.run(
          device.bike_id, rec.lat, rec.lng, rec.speed, rec.angle,
          new Date(rec.ts).toISOString(),
          rec.satellites, rec.altitude,
          rec.io[239] !== undefined ? rec.io[239] : null, // IO 239 = ignition
          JSON.stringify(rec.io)
        );
        if (!latestRec || rec.ts > latestRec.ts) latestRec = rec;
      }
      if (latestRec) {
        db.prepare(
          `UPDATE bikes SET last_known_lat=?, last_known_lng=?, last_location_at=? WHERE id=?`
        ).run(latestRec.lat, latestRec.lng, new Date(latestRec.ts).toISOString(), device.bike_id);
        trackingEvents.emit('ping', {
          imei,
          device_id: device.id,
          bike_id: device.bike_id,
          lat: latestRec.lat,
          lng: latestRec.lng,
          speed: latestRec.speed,
          heading: latestRec.angle,
          altitude: latestRec.altitude,
          satellites: latestRec.satellites,
          ignition: latestRec.io[239] !== undefined ? latestRec.io[239] : null,
          ts: latestRec.ts,
        });
      }
    }

    db.prepare('UPDATE tracking_devices SET connected=1, last_seen_at=CURRENT_TIMESTAMP WHERE imei=?').run(imei);

    // Acknowledge with record count
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(numData1, 0);
    return ack;
  }

  if (codecId === 0x0c) {
    // Codec 12 response from device
    let o = 9; // skip preamble(4)+length(4)+codec_id(1)
    o++; // qty1
    const type = packet[o++];
    if (type === 0x06) {
      const respLen = packet.readUInt32BE(o); o += 4;
      const response = packet.slice(o, o + respLen).toString('ascii');
      const pending = db.prepare(
        `SELECT tc.id FROM tracking_commands tc
         JOIN tracking_devices td ON td.id = tc.device_id
         WHERE td.imei=? AND tc.status='sent' ORDER BY tc.sent_at ASC LIMIT 1`
      ).get(imei);
      if (pending) {
        db.prepare(
          `UPDATE tracking_commands SET status='delivered', response=?, responded_at=CURRENT_TIMESTAMP WHERE id=?`
        ).run(response, pending.id);
      }
      console.log(`[Teltonika] ${imei} → ${response}`);
    }
  }

  return null;
}

function dispatchCommand(socket, imei, cmdId, command) {
  try {
    socket.write(buildCommandPacket(command));
    db.prepare(`UPDATE tracking_commands SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=?`).run(cmdId);
    console.log(`[Teltonika] → ${imei}: ${command}`);
  } catch (err) {
    console.error(`[Teltonika] send failed (${imei}):`, err.message);
    db.prepare(`UPDATE tracking_commands SET status='failed' WHERE id=?`).run(cmdId);
  }
}

function handleConnection(socket) {
  let imei = null;
  let authed = false;
  let buf = Buffer.alloc(0);

  socket.setTimeout(300_000, () => socket.destroy());

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 1024 * 1024) { // 1 MB max buffer — reject runaway connection
      console.warn(`[Teltonika] ${imei || '?'} buffer overflow — disconnecting`);
      socket.destroy();
      return;
    }

    if (!authed) {
      if (buf.length < 2) return;
      const imeiLen = buf.readUInt16BE(0);
      if (buf.length < 2 + imeiLen) return;
      imei = buf.slice(2, 2 + imeiLen).toString('ascii');
      buf = buf.slice(2 + imeiLen);

      const device = db.prepare('SELECT * FROM tracking_devices WHERE imei=?').get(imei);
      if (device) {
        socket.write(Buffer.from([0x01]));
        authed = true;
        connections.set(imei, socket);
        db.prepare('UPDATE tracking_devices SET connected=1, last_seen_at=CURRENT_TIMESTAMP WHERE imei=?').run(imei);
        console.log(`[Teltonika] + ${imei} (${device.model})`);
        // Flush pending commands
        const pending = db.prepare(
          `SELECT * FROM tracking_commands WHERE device_id=? AND status='pending' ORDER BY created_at ASC`
        ).all(device.id);
        for (const cmd of pending) dispatchCommand(socket, imei, cmd.id, cmd.command);
        // Fall through to packet-consuming loop — device may have sent AVL data
        // in the same TCP segment as the IMEI handshake
      } else {
        socket.write(Buffer.from([0x00]));
        console.log(`[Teltonika] rejected unknown IMEI ${imei}`);
        socket.end();
        return;
      }
    }

    // Consume complete packets from buffer
    while (buf.length >= 12) {
      if (buf.readUInt32BE(0) !== 0) { console.warn(`[Teltonika] ${imei} bad preamble — disconnecting`); socket.destroy(); return; }
      const dataLen = buf.readUInt32BE(4);
      const total = 4 + 4 + dataLen + 4;
      if (buf.length < total) break;
      const reply = handlePacket(imei, buf.slice(0, total));
      if (reply) socket.write(reply);
      buf = buf.slice(total);
    }
  });

  socket.on('close', () => {
    if (imei) {
      if (connections.get(imei) === socket) {
        connections.delete(imei);
        try { db.prepare('UPDATE tracking_devices SET connected=0 WHERE imei=?').run(imei); } catch (_) {}
      }
      console.log(`[Teltonika] - ${imei}`);
    }
  });

  socket.on('error', (err) => console.error(`[Teltonika] socket error (${imei || '?'}):`, err.message));
}

// Send a command immediately if device is connected; returns true if sent now
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
  const server = net.createServer(handleConnection);
  server.listen(port, () => console.log(`📡 Teltonika TCP server on :${port}`));
  server.on('error', (err) => console.error('[Teltonika] server error:', err));
  return server;
}

module.exports = { start, sendCommand, getConnectedIMEIs, trackingEvents };

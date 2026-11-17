import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const require_ = createRequire(import.meta.url);
const teltonika = require_('../src/tcp/teltonikaServer.js');

// Telling a tracker that is replaying a backlog from one that cannot see a
// satellite.
//
// Both leave the bike with no current position, and the console used to call
// both of them "no fix" — but one is fixed by clearing the device's memory and
// the other by somebody walking out to the bike with a spanner. Four Pillion
// bikes read "no fix" on the same screen for two different reasons.
//
// The server could always tell them apart: it has been logging "N/N record(s)
// outside the live window" all along. It just had nowhere to write it down.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await wait(25);
  }
}

const openSockets = [];
const IMEI = '353201352351578';

function crc16(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

/** One Codec 8 record at a real Johannesburg position, timestamped as asked. */
function avlPacket(records) {
  const bodies = records.map(({ at, lat = -26.0626116, lng = 27.9494133 }) => {
    const rec = Buffer.alloc(8 + 1 + 15 + 2 + 4);
    const ms = at.getTime();
    rec.writeUInt32BE(Math.floor(ms / 4294967296), 0);
    rec.writeUInt32BE(ms % 4294967296, 4);
    let o = 9; // after timestamp + priority
    rec.writeInt32BE(Math.round(lng * 1e7), o); o += 4;
    rec.writeInt32BE(Math.round(lat * 1e7), o); o += 4;
    o += 2;          // altitude
    o += 2;          // angle
    rec[o++] = 17;   // satellites — a strong fix, as the Pillion devices had
    return rec;
  });
  const data = Buffer.concat([
    Buffer.from([0x08, bodies.length]), ...bodies, Buffer.from([bodies.length]),
  ]);
  const p = Buffer.alloc(8 + data.length + 4);
  p.writeUInt32BE(data.length, 4);
  data.copy(p, 8);
  p.writeUInt32BE(crc16(data), 8 + data.length);
  return p;
}

describe.skipIf(!process.env.DATABASE_URL)('why a connected tracker has no position', () => {
  let server, port, device, bike;

  beforeEach(async () => {
    await resetAllPgTables();
    bike = await createPgBike({ registration: 'MX14VSGP', status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, model) VALUES ($1,$2,'FMB920') RETURNING *`, [IMEI, bike.id]);
    device = rows[0];
    server = teltonika.start(0);
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
  });

  afterEach(async () => {
    openSockets.splice(0).forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  });

  async function connect() {
    const sock = net.connect(port, '127.0.0.1');
    openSockets.push(sock);
    let received = Buffer.alloc(0);
    sock.on('data', (d) => { received = Buffer.concat([received, d]); });
    await new Promise((r) => sock.once('connect', r));
    const imei = Buffer.from(IMEI, 'ascii');
    const hello = Buffer.alloc(2); hello.writeUInt16BE(imei.length);
    sock.write(Buffer.concat([hello, imei]));
    await until(() => received.length >= 1);
    return sock;
  }

  const deviceRow = async () => (await pgDb.query(
    'SELECT backlog_seen_at, backlog_until FROM tracking_devices WHERE id=$1', [device.id])).rows[0];
  const bikeRow = async () => (await pgDb.query(
    'SELECT last_location_at FROM bikes WHERE id=$1', [bike.id])).rows[0];

  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it('marks a tracker replaying old records, and says how far it has got', async () => {
    const sock = await connect();
    // What MX14VSGP was doing: a batch of records all months old.
    sock.write(avlPacket([
      { at: daysAgo(120) }, { at: daysAgo(118) }, { at: daysAgo(117) },
    ]));

    await until(async () => (await deviceRow()).backlog_seen_at !== null);
    const row = await deviceRow();
    expect(row.backlog_seen_at).not.toBeNull();
    // The newest of the batch — the date the replay has reached, not the oldest.
    expect(Math.abs(new Date(row.backlog_until) - daysAgo(117))).toBeLessThan(2000);

    // And the bike still has no current position, which is the whole point.
    expect((await bikeRow()).last_location_at).toBeNull();
    sock.destroy();
  });

  // A tracker that has never seen a satellite sends its position as 0,0, which
  // is dropped before it is ever stored. No records, so no backlog flag — and
  // that absence is exactly what tells the console to say "no satellite fix"
  // rather than "catching up".
  it('does not mark one that is simply reporting nothing', async () => {
    const sock = await connect();
    sock.write(avlPacket([{ at: new Date(), lat: 0, lng: 0 }]));
    await wait(400); // long enough for a write to have landed

    expect(await deviceRow()).toEqual({ backlog_seen_at: null, backlog_until: null });
    expect((await bikeRow()).last_location_at).toBeNull();
    sock.destroy();
  });

  it('clears the mark as soon as the tracker catches up', async () => {
    const sock = await connect();
    sock.write(avlPacket([{ at: daysAgo(90) }]));
    await until(async () => (await deviceRow()).backlog_seen_at !== null);

    // The device reaches the present.
    sock.write(avlPacket([{ at: new Date() }]));
    await until(async () => (await bikeRow()).last_location_at !== null);

    expect(await deviceRow()).toEqual({ backlog_seen_at: null, backlog_until: null });
    sock.destroy();
  });

  // A batch straddling the boundary is a device on the last of its backlog.
  // The current record wins: it has caught up, whatever else was in the packet.
  it('treats a mixed batch as caught up', async () => {
    const sock = await connect();
    sock.write(avlPacket([{ at: daysAgo(40) }, { at: new Date() }]));
    await until(async () => (await bikeRow()).last_location_at !== null);

    expect(await deviceRow()).toEqual({ backlog_seen_at: null, backlog_until: null });
    sock.destroy();
  });

  // The records are still worth keeping — they are real journeys, and they are
  // what is lost if somebody clears the device's memory instead of waiting.
  it('keeps the old records as history rather than discarding them', async () => {
    const sock = await connect();
    sock.write(avlPacket([{ at: daysAgo(120) }, { at: daysAgo(119) }]));
    await until(async () => (await pgDb.query(
      'SELECT COUNT(*)::int AS n FROM gps_pings WHERE bike_id=$1', [bike.id])).rows[0].n === 2);

    const { rows } = await pgDb.query(
      'SELECT satellites FROM gps_pings WHERE bike_id=$1', [bike.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0].satellites).toBe(17);
    sock.destroy();
  });
});

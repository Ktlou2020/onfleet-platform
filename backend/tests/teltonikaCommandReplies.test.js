import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const require_ = createRequire(import.meta.url);
const teltonika = require_('../src/tcp/teltonikaServer.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const IMEI = '353201357807277';

// Codec 12 replies carry no command id: a device answers the commands sent on
// a connection in order. A command that never got an answer — written into a
// connection that had already died — used to stay 'sent' forever, and every
// later reply was credited to it instead of the command it answered. The
// Controls tab then showed the newest commands stuck at "Sent".

function replyPacket(text) {
  const body = Buffer.from(text, 'ascii');
  const dataLen = 8 + body.length;
  const p = Buffer.alloc(4 + 4 + dataLen + 4);
  let o = 4;
  p.writeUInt32BE(dataLen, o); o += 4;
  p[o++] = 0x0c; p[o++] = 0x01; p[o++] = 0x06;
  p.writeUInt32BE(body.length, o); o += 4;
  body.copy(p, o); o += body.length;
  p[o++] = 0x01;
  return p;
}

function commandsIn(buf) {
  const out = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const dataLen = buf.readUInt32BE(o + 4);
    const len = buf.readUInt32BE(o + 11);
    out.push(buf.slice(o + 15, o + 15 + len).toString('ascii'));
    o += 12 + dataLen;
  }
  return out;
}

async function connectDevice(port) {
  const sock = net.connect(port, '127.0.0.1');
  let received = Buffer.alloc(0);
  sock.on('data', (d) => { received = Buffer.concat([received, d]); });
  await new Promise((r) => sock.once('connect', r));
  const imei = Buffer.from(IMEI, 'ascii');
  const hello = Buffer.alloc(2); hello.writeUInt16BE(imei.length);
  sock.write(Buffer.concat([hello, imei]));
  await wait(150);
  return { sock, commands: () => commandsIn(received.slice(1)) };
}

describe.skipIf(!process.env.DATABASE_URL)('matching device replies to the commands they answer', () => {
  let server, port, device;

  beforeEach(async () => {
    await resetAllPgTables();
    const bike = await createPgBike({ registration: 'MG30WPGP', status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, model) VALUES ($1,$2,'FMB965') RETURNING id`, [IMEI, bike.id]);
    device = rows[0];
    server = teltonika.start(0);
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  const queue = async (command, status = 'pending', minutesAgo = 0) => {
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_commands (device_id, command, status, sent_at, created_at)
       VALUES ($1,$2,$3, CASE WHEN $3='sent' THEN NOW() - ($4 || ' minutes')::interval END,
               NOW() - ($4 || ' minutes')::interval) RETURNING id`,
      [device.id, command, status, String(minutesAgo)]);
    return rows[0].id;
  };
  const row = async (id) => (await pgDb.query('SELECT status, response FROM tracking_commands WHERE id=$1', [id])).rows[0];

  it('credits a reply to the command it answers, not an older unanswered one', async () => {
    // Left at 'sent' by an earlier connection that died before the device answered.
    const orphan = await queue('setdigout ? 1', 'sent', 60);
    const { sock } = await connectDevice(port);

    const cmd = await queue('getinfo');
    expect(teltonika.sendCommand(IMEI, cmd, 'getinfo')).toBe(true);
    await wait(50);
    sock.write(replyPacket('INI:2026/10/15 RTC:2026/10/15'));
    await wait(150);

    expect(await row(cmd)).toEqual({ status: 'delivered', response: 'INI:2026/10/15 RTC:2026/10/15' });
    expect((await row(orphan)).status).not.toBe('delivered');
    sock.destroy();
  });

  it('answers several queued commands in the order they were sent', async () => {
    const a = await queue('setdigout ? 0');
    const b = await queue('getgps');
    const { sock, commands } = await connectDevice(port);
    expect(commands()).toEqual(['setdigout ? 0', 'getgps']);

    sock.write(replyPacket('DOUT1:0'));
    sock.write(replyPacket('GPS:0'));
    await wait(150);

    expect((await row(a)).response).toBe('DOUT1:0');
    expect((await row(b)).response).toBe('GPS:0');
    sock.destroy();
  });

  it('marks a command failed when the connection closes before the reply', async () => {
    const { sock } = await connectDevice(port);
    const cmd = await queue('getinfo');
    teltonika.sendCommand(IMEI, cmd, 'getinfo');
    await wait(50);
    sock.destroy();
    await wait(150);

    expect(await row(cmd)).toEqual({ status: 'failed', response: 'No reply — connection closed' });
  });

  it('re-sends an engine restore that never got a reply when the device reconnects', async () => {
    const lost = await queue('setdigout ? 0', 'failed', 5);
    const { sock, commands } = await connectDevice(port);

    expect(commands()).toEqual(['setdigout ? 0']);
    const { rows } = await pgDb.query(
      `SELECT id FROM tracking_commands WHERE device_id=$1 AND id <> $2 AND command='setdigout ? 0'`, [device.id, lost]);
    expect(rows).toHaveLength(1);
    sock.destroy();
  });

  it('does not re-send a restore the device already confirmed', async () => {
    await queue('setdigout ? 0', 'delivered', 5);
    const { sock, commands } = await connectDevice(port);
    expect(commands()).toEqual([]);
    sock.destroy();
  });
});

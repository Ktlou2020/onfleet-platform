import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { resetAllPgTables, createPgUser, authHeader } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const { trackerEndpoint, endpointDrift, FALLBACK_HOST, FALLBACK_PORT } = load('../src/config/trackerEndpoint.js');

// A tracker pointed at the wrong address cannot be fixed from here: it takes
// an SMS to its SIM or a cable at the bike. So the platform works this out
// from live configuration instead of repeating a string somebody typed into a
// runbook months ago.
describe('where a tracker should be told to connect', () => {
  const RAILWAY = { RAILWAY_TCP_PROXY_DOMAIN: 'hayabusa.proxy.rlwy.net', RAILWAY_TCP_PROXY_PORT: '52322' };

  it('follows Railway when nothing overrides it', () => {
    expect(trackerEndpoint(RAILWAY)).toMatchObject({ host: 'hayabusa.proxy.rlwy.net', port: 52322, own_hostname: false });
  });

  // The point of the whole exercise: devices are given a name we own, so if
  // the proxy moves, a DNS change follows it and nobody touches a bike.
  it('prefers a hostname we own', () => {
    const e = trackerEndpoint({ ...RAILWAY, TRACKER_PUBLIC_HOST: 'gps.onfleet.africa', TRACKER_PUBLIC_PORT: '52322' });
    expect(e).toMatchObject({ host: 'gps.onfleet.africa', port: 52322, own_hostname: true });
  });

  it('keeps reporting the truth if Railway reassigns the proxy', () => {
    const e = trackerEndpoint({ RAILWAY_TCP_PROXY_DOMAIN: 'other.proxy.rlwy.net', RAILWAY_TCP_PROXY_PORT: '41999' });
    expect(e).toMatchObject({ host: 'other.proxy.rlwy.net', port: 41999 });
  });

  it('answers sensibly with no environment at all', () => {
    expect(trackerEndpoint({})).toMatchObject({ host: FALLBACK_HOST, port: FALLBACK_PORT });
  });

  // 50150 is the port the process listens on inside Railway's network. Handing
  // it to a physical device is the exact mistake this module exists to stop,
  // so it must never be able to leak out as the public port.
  it('never reports the internal application port', () => {
    const e = trackerEndpoint({ ...RAILWAY, TELTONIKA_TCP_PORT: '50150', RAILWAY_TCP_APPLICATION_PORT: '50150' });
    expect(e.port).toBe(52322);
  });

  it('ignores a nonsense port rather than publishing it', () => {
    expect(trackerEndpoint({ TRACKER_PUBLIC_PORT: 'not-a-port' }).port).toBe(FALLBACK_PORT);
  });

  describe('noticing when DNS can no longer save us', () => {
    // A CNAME fixes the hostname half. It cannot fix the port, so a proxy that
    // moves ports strands every tracker in the field — worth saying loudly.
    it('flags a port that has drifted away from the proxy', () => {
      const e = trackerEndpoint({
        TRACKER_PUBLIC_HOST: 'gps.onfleet.africa', TRACKER_PUBLIC_PORT: '52322',
        RAILWAY_TCP_PROXY_DOMAIN: 'other.proxy.rlwy.net', RAILWAY_TCP_PROXY_PORT: '41999',
      });
      expect(endpointDrift(e)).toMatch(/52322.*41999/);
    });

    it('says nothing while the two agree', () => {
      const e = trackerEndpoint({ ...RAILWAY, TRACKER_PUBLIC_HOST: 'gps.onfleet.africa', TRACKER_PUBLIC_PORT: '52322' });
      expect(endpointDrift(e)).toBeNull();
    });

    it('says nothing when we are not using our own hostname', () => {
      expect(endpointDrift(trackerEndpoint(RAILWAY))).toBeNull();
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the endpoint the install screen reads', () => {
  const app = buildApp();
  let admin;
  let technician;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    technician = (await createPgUser({ role: 'technician' })).user;
  });

  it('tells staff the host, port and protocol', async () => {
    const res = await request(app).get('/api/tracking/endpoint').set(authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.host).toBeTruthy();
    expect(res.body.port).toBeGreaterThan(0);
    expect(res.body.protocol).toBe('TCP');
  });

  it('is readable by the control room', async () => {
    const controlRoom = (await createPgUser({ role: 'control_room' })).user;
    expect((await request(app).get('/api/tracking/endpoint').set(authHeader(controlRoom))).status).toBe(200);
  });

  // Technicians are kept out of tracking entirely — the endpoint sits behind
  // the same gate as live positions, and workshop staff have no business
  // seeing where every rider is. Installs are run by an admin.
  it('is not open to workshop technicians', async () => {
    expect((await request(app).get('/api/tracking/endpoint').set(authHeader(technician))).status).toBe(403);
  });

  it('is not public', async () => {
    expect((await request(app).get('/api/tracking/endpoint')).status).toBe(401);
  });
});

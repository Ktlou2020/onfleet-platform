import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// What the platform did to a fleet's account, on the fleet's own screen.
//
// This used to show only what the fleet's own people did, on the grounds
// that a partial view of the operator's audit trail is worse than none. The
// opposite is truer: somebody signed into the account, changed the plan or
// adjusted the wallet, and the only record of it was on a screen the customer
// cannot reach.
//
// A platform action belongs to a fleet when it names them — their
// organisation, their wallet, or one of their people. The tests that matter
// most are the ones about the rest of the operator's trail, which must not
// come with it.

describe.skipIf(!process.env.DATABASE_URL)('a fleet reading its own history', () => {
  let rapid, kasi, owner, staff, admin, kasiOwner;

  const log = (actorId, action, entity, entityId, metadata = {}) =>
    pgDb.query(
      `INSERT INTO audit_logs (actor_id, action, entity, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)`,
      [actorId, action, entity, entityId, JSON.stringify(metadata)]);

  const activity = (user) =>
    request(app).get('/api/fleet/activity/audit').set(authHeader(user));

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: rapid.id });
    staff = await createPgUser({ role: 'fleet_owner_ops', organization_id: rapid.id });
    kasiOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: kasi.id });
    admin = await createPgUser({ role: 'superadmin', full_name: 'Platform Operator' });
  });

  it('still shows what its own people did', async () => {
    await log(staff.user.id, 'fleet_owner.bike_update', 'bikes', 7);
    const res = await activity(owner.user);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ actor_name: staff.user.full_name, by_platform: false });
  });

  describe('and now what the platform did to it', () => {
    it('a plan change', async () => {
      await log(admin.user.id, 'organization.plan_changed', 'organizations', rapid.id, { to: 'fleet' });
      const res = await activity(owner.user);
      expect(res.body.entries.map((e) => e.action)).toContain('organization.plan_changed');
      expect(res.body.entries[0].by_platform).toBe(true);
    });

    // The one a customer has the strongest claim to know about.
    it('somebody signing in as them', async () => {
      await log(admin.user.id, 'superadmin.impersonate', 'organizations', rapid.id);
      const res = await activity(owner.user);
      expect(res.body.entries.map((e) => e.action)).toContain('superadmin.impersonate');
    });

    it('an adjustment to their wallet', async () => {
      await log(admin.user.id, 'wallet.manual_adjustment', 'fleet_wallets', rapid.id, { amount: -500 });
      const res = await activity(owner.user);
      expect(res.body.entries.map((e) => e.action)).toContain('wallet.manual_adjustment');
    });

    it('and something done to one of their people', async () => {
      await log(admin.user.id, 'fleet_owner.user_status', 'users', staff.user.id, { status: 'suspended' });
      const res = await activity(owner.user);
      expect(res.body.entries.map((e) => e.action)).toContain('fleet_owner.user_status');
    });
  });

  describe('and none of the rest of the operator\'s trail', () => {
    it('not what they did to another fleet', async () => {
      await log(admin.user.id, 'organization.plan_changed', 'organizations', kasi.id);
      const res = await activity(owner.user);
      expect(res.body.entries, 'a fleet saw another fleet\'s plan change').toHaveLength(0);
    });

    it('nor to another fleet\'s people', async () => {
      await log(admin.user.id, 'fleet_owner.user_status', 'users', kasiOwner.user.id);
      const res = await activity(owner.user);
      expect(res.body.entries).toHaveLength(0);
    });

    it('nor the platform\'s own housekeeping', async () => {
      await log(admin.user.id, 'backup.manual_run', 'backups', 1);
      await log(admin.user.id, 'admin.platform_api_key_create', 'api_keys', 3);
      await log(admin.user.id, 'branding.hero_image', 'app_settings', 1);
      const res = await activity(owner.user);
      expect(res.body.entries).toHaveLength(0);
    });

    // An entity id that happens to collide with this organisation's id must
    // not drag an unrelated record in. Only the entities that are keyed by
    // organisation count.
    it('nor something unrelated that shares an id', async () => {
      await log(admin.user.id, 'tracking.device_import', 'tracking_devices', rapid.id);
      const res = await activity(owner.user);
      expect(res.body.entries).toHaveLength(0);
    });
  });

  describe('what it says about the person', () => {
    beforeEach(async () => {
      await log(admin.user.id, 'organization.plan_changed', 'organizations', rapid.id);
      await log(staff.user.id, 'fleet_owner.bike_update', 'bikes', 7);
    });

    it('names them, because that is what an audit trail is for', async () => {
      const res = await activity(owner.user);
      const platform = res.body.entries.find((e) => e.by_platform);
      expect(platform.actor_name).toBe('Platform Operator');
    });

    // A customer does not need the operator's staff addresses.
    it('but withholds a platform address while keeping their own team\'s', async () => {
      const res = await activity(owner.user);
      const platform = res.body.entries.find((e) => e.by_platform);
      const theirs = res.body.entries.find((e) => !e.by_platform);
      expect(platform.actor_email).toBeNull();
      expect(theirs.actor_email).toBe(staff.user.email);
    });

    // The metadata is the operator's working notes and has never been sent
    // here. Worth a test, because "add the field while you are in there" is
    // exactly how it would arrive one day.
    it('and sends no metadata at all', async () => {
      const res = await activity(owner.user);
      for (const entry of res.body.entries) {
        expect(Object.keys(entry)).not.toContain('metadata');
      }
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const accounts = load('../src/services/paystackAccounts.js');

// Each fleet collects its riders' money into its own Paystack account, so the
// money never passes through us. Getting this wrong does not throw an error —
// it quietly pays the wrong company, which is why most of what follows is
// about the cases where we must refuse rather than guess.
describe('whose Paystack account takes a rider payment', () => {
  const KEY = Buffer.alloc(32, 7).toString('hex');
  let original;

  beforeEach(() => {
    original = { ...process.env };
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_platform_key_0000000';
    process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_platform_key_0000000';
  });
  afterEach(() => { process.env = original; });

  describe('keeping the secret unreadable at rest', () => {
    it('does not store the key as anything resembling itself', () => {
      const secret = 'sk_live_a1b2c3d4e5f6g7h8i9j0';
      const stored = accounts.encryptSecret(secret);
      expect(stored).not.toContain(secret);
      expect(stored).not.toContain('sk_live');
      expect(accounts.decryptSecret(stored)).toBe(secret);
    });

    it('gives back nothing when the encryption key has changed', () => {
      const stored = accounts.encryptSecret('sk_live_a1b2c3d4e5f6g7h8i9j0');
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('hex');
      expect(accounts.decryptSecret(stored)).toBeNull();
    });

    // Without authentication, an altered ciphertext could decrypt to something
    // else entirely. GCM's tag is what makes tampering fail instead.
    it('gives back nothing when the stored value has been tampered with', () => {
      const stored = accounts.encryptSecret('sk_live_a1b2c3d4e5f6g7h8i9j0');
      const [iv, tag, data] = stored.split('.');
      const flipped = Buffer.from(data, 'base64');
      flipped[0] ^= 0xff;
      expect(accounts.decryptSecret([iv, tag, flipped.toString('base64')].join('.'))).toBeNull();
    });

    // Storing a live payment key in plain text because a config value is
    // missing is worse than not storing it at all.
    it('refuses to store a secret with no encryption key configured', () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      expect(() => accounts.encryptSecret('sk_live_whatever')).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    });
  });

  describe.skipIf(!process.env.DATABASE_URL)('choosing the account', () => {
    let org;
    let bike;
    let agreement;

    beforeEach(async () => {
      await resetAllPgTables();
      org = await createPgOrg({ name: 'Blue Sky Deliveries' });
      bike = await createPgBike({ organization_id: org.id });
      const rider = (await createPgUser({ role: 'rider' })).user;
      agreement = await createPgAgreement({ bike_id: bike.id, user_id: rider.id });
    });

    it('uses the platform account while the fleet has connected none', async () => {
      const account = await accounts.accountForOrganization(org.id);
      expect(account).toMatchObject({ own: false, secret: 'sk_test_platform_key_0000000' });
    });

    it('uses the fleet\'s own account once connected', async () => {
      await accounts.connectAccount({ organizationId: org.id, secretKey: 'sk_live_fleetsownkey12345', publicKey: 'pk_live_fleetsownkey12345' });
      const account = await accounts.accountForOrganization(org.id);
      expect(account).toMatchObject({ own: true, secret: 'sk_live_fleetsownkey12345', organization_id: org.id });
    });

    // The failure that matters: falling back to the platform's account here
    // would take this fleet's money into ours without anybody noticing.
    it('refuses rather than falling back when the stored key cannot be read', async () => {
      await accounts.connectAccount({ organizationId: org.id, secretKey: 'sk_live_fleetsownkey12345' });
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('hex');
      await expect(accounts.accountForOrganization(org.id)).rejects.toThrow(/reconnected/i);
    });

    it('finds the fleet that owns the bike on the agreement', async () => {
      expect(await accounts.organizationForAgreement(agreement.id)).toBe(org.id);
    });

    it('goes back to the platform account when a fleet disconnects', async () => {
      await accounts.connectAccount({ organizationId: org.id, secretKey: 'sk_live_fleetsownkey12345' });
      await accounts.disconnectAccount({ organizationId: org.id });
      expect(await accounts.accountForOrganization(org.id)).toMatchObject({ own: false });
    });

    it('turns away a key that is not a Paystack secret key', async () => {
      await expect(accounts.connectAccount({ organizationId: org.id, secretKey: 'pk_live_thisisthepublicone' }))
        .rejects.toThrow(/secret key/i);
      await expect(accounts.connectAccount({ organizationId: org.id, secretKey: 'sk_live_xxxxxxxxxxxx' }))
        .rejects.toThrow(/secret key/i);
    });
  });

  describe.skipIf(!process.env.DATABASE_URL)('telling one fleet\'s webhook from another\'s', () => {
    let a;
    let b;

    beforeEach(async () => {
      await resetAllPgTables();
      a = await createPgOrg({ name: 'Fleet A', slug: 'fleet-a' });
      b = await createPgOrg({ name: 'Fleet B', slug: 'fleet-b' });
      await accounts.connectAccount({ organizationId: a.id, secretKey: 'sk_live_fleetAsecret12345' });
      await accounts.connectAccount({ organizationId: b.id, secretKey: 'sk_live_fleetBsecret12345' });
    });

    it('gives each fleet its own webhook token', async () => {
      const sa = await accounts.connectionStatus(a.id);
      const sb = await accounts.connectionStatus(b.id);
      expect(sa.webhook_url).toBeTruthy();
      expect(sa.webhook_url).not.toBe(sb.webhook_url);
    });

    it('resolves a token back to the right fleet', async () => {
      const { rows } = await pgDb.query('SELECT paystack_webhook_token FROM organizations WHERE id = $1', [a.id]);
      const found = await accounts.organizationByWebhookToken(rows[0].paystack_webhook_token);
      expect(found.id).toBe(a.id);
    });

    it('resolves nothing for a token nobody holds', async () => {
      expect(await accounts.organizationByWebhookToken('not-a-real-token')).toBeNull();
    });

    // Reconnecting must not change the URL a fleet already pasted into
    // Paystack, or their webhooks stop arriving and nobody finds out until
    // payments stop being recorded.
    it('keeps the same webhook URL when a fleet reconnects', async () => {
      const before = await accounts.connectionStatus(a.id);
      await accounts.connectAccount({ organizationId: a.id, secretKey: 'sk_live_fleetAnewsecret999' });
      expect((await accounts.connectionStatus(a.id)).webhook_url).toBe(before.webhook_url);
    });
  });

  describe.skipIf(!process.env.DATABASE_URL)('what the fleet owner is shown', () => {
    let org;
    beforeEach(async () => {
      await resetAllPgTables();
      org = await createPgOrg({ name: 'Blue Sky Deliveries' });
    });

    it('never hands the secret back', async () => {
      await accounts.connectAccount({ organizationId: org.id, secretKey: 'sk_live_fleetsownkey12345', publicKey: 'pk_live_fleetsownkey12345' });
      const status = await accounts.connectionStatus(org.id);
      expect(JSON.stringify(status)).not.toContain('sk_live');
      expect(status).toMatchObject({ connected: true, public_key: 'pk_live_fleetsownkey12345' });
    });

    it('says plainly when nothing is connected', async () => {
      expect(await accounts.connectionStatus(org.id)).toMatchObject({ connected: false, public_key: null });
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { sendNotification } from '../src/services/notifierPg.js';
import { pgDb, resetAllPgTables, createPgUser } from './helpers/testPgDb.js';

// sendNotification wrote status='sent' unconditionally after an if/else chain
// that no branch had to match. So a channel with no provider behind it, and a
// recipient with no address to send to, both came out of this looking exactly
// like a successful delivery.
describe.skipIf(!process.env.DATABASE_URL)('notification delivery status', () => {
  const statusOf = async (id) => {
    const { rows } = await pgDb.query('SELECT status, sent_at FROM notifications WHERE id = $1', [id]);
    return rows[0];
  };

  beforeEach(async () => { await resetAllPgTables(); });

  it('does not claim delivery for a channel with no provider behind it', async () => {
    const { user } = await createPgUser({ role: 'rider', phone: '+27820000001' });
    const id = await sendNotification({ userId: user.id, channel: 'whatsapp', type: 'test', message: 'hello' });

    const row = await statusOf(id);
    // 42,707 WhatsApp messages were on record as sent, with a timestamp, having
    // gone nowhere but a console.log.
    expect(row.status).toBe('skipped');
    expect(row.sent_at).toBeNull();
  });

  it('treats SMS the same way', async () => {
    const { user } = await createPgUser({ role: 'rider', phone: '+27820000002' });
    const id = await sendNotification({ userId: user.id, channel: 'sms', type: 'test', message: 'hello' });
    expect((await statusOf(id)).status).toBe('skipped');
  });

  it('marks a message failed when the recipient has no number to send it to', async () => {
    const { user } = await createPgUser({ role: 'rider', phone: null });
    const id = await sendNotification({ userId: user.id, channel: 'whatsapp', type: 'test', message: 'hello' });

    const row = await statusOf(id);
    // No branch matched, nothing was attempted — and 722 rows recorded that as
    // a delivery. 'skipped' would be wrong too: a provider would not help here.
    expect(row.status).toBe('failed');
    expect(row.sent_at).toBeNull();
  });

  it('still treats an in-app notification as delivered, because the row is the delivery', async () => {
    const { user } = await createPgUser({ role: 'rider', phone: null });
    const id = await sendNotification({ userId: user.id, channel: 'in_app', type: 'test', title: 'T', message: 'hello' });

    const row = await statusOf(id);
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
  });

  it('keeps the message itself on file whatever happened to it', async () => {
    const { user } = await createPgUser({ role: 'rider', phone: '+27820000003' });
    const id = await sendNotification({ userId: user.id, channel: 'whatsapp', type: 'payment_overdue', message: 'R500 overdue' });

    const { rows } = await pgDb.query('SELECT message, type FROM notifications WHERE id = $1', [id]);
    expect(rows[0].message).toBe('R500 overdue');
    expect(rows[0].type).toBe('payment_overdue');
  });
});

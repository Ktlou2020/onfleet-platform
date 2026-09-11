'use strict';

/**
 * Adds 'skipped' to the notification status constraint.
 *
 * sendSMS and sendWhatsApp are console.log stubs — no provider is wired up —
 * but sendNotification wrote status='sent', with a sent_at timestamp, straight
 * after calling them. 42,707 WhatsApp messages and 1,266 SMS are on record as
 * delivered without one of them leaving the server. A further 722 were recorded
 * as sent to riders who have no phone number at all, where no send was even
 * attempted: the status was written unconditionally after an if/else chain that
 * no branch had matched.
 *
 * 'skipped' means the message was composed and is on file, and there was no
 * channel to carry it. That is deliberately not 'failed' — nothing went wrong,
 * and keeping them apart is what shows how much of the backlog becomes real
 * delivery the day a provider is connected.
 *
 * Existing rows are left as they are. Rewriting 44,000 historical rows is a
 * separate decision from fixing the code that writes new ones.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
    ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
      CHECK (status IN ('pending','sent','failed','read','skipped'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE notifications SET status = 'failed' WHERE status = 'skipped';
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
    ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
      CHECK (status IN ('pending','sent','failed','read'));
  `);
};

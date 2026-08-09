'use strict';

/**
 * Web push subscriptions — one row per browser/device a user has opted into
 * notifications on. A user can have several (phone + desktop, or after
 * reinstalling the PWA), so this is keyed by the push endpoint URL itself
 * (unique per browser subscription), not by user_id alone.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
    CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS push_subscriptions;`);
};

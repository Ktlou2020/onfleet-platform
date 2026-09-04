'use strict';

/**
 * Records every login attempt, successful or not.
 *
 * Only successful logins were audited before (audit_logs 'user.login'), and
 * with no user agent — so when a rider says they can't get in, there was no way
 * to tell a wrong password from a suspended account from never having tried at
 * all, nor what they were using to try.
 *
 * Separate from audit_logs rather than extending it: an attempt can reference
 * an email that matches no account, so user_id has to be nullable, and the
 * failure reason and user agent don't belong on the general-purpose audit
 * record. The volume is also much higher, and keeping it apart means it can be
 * pruned on its own schedule.
 *
 * email is stored as typed. That is the point — a rider mistyping their address
 * is one of the likelier reasons they cannot log in, and it is invisible if
 * only matched accounts are recorded. Passwords are never stored, attempted or
 * otherwise.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email          TEXT NOT NULL,
      success        BOOLEAN NOT NULL,
      failure_reason TEXT,
      ip             TEXT,
      user_agent     TEXT,
      browser        TEXT,
      os             TEXT,
      device_type    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // The two ways this gets read: one rider's history, and a sweep of recent
  // attempts across everyone.
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_login_attempts_user
             ON login_attempts (user_id, created_at DESC);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_login_attempts_recent
             ON login_attempts (created_at DESC);`);
  // Lets support look someone up by the address they say they typed, even when
  // it matched no account and so has no user_id.
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_login_attempts_email
             ON login_attempts (LOWER(email), created_at DESC);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS login_attempts;`);
};

'use strict';

/**
 * A critical alert escalated once, by email, 15 minutes in — and the send was
 * fire-and-forget, with escalated_at stamped whether or not anything left the
 * server. Tamper alerts took an average of 6 hours to be acknowledged.
 *
 * Escalation now repeats in rounds until someone acknowledges, and every
 * attempt is recorded here: which round, which channel, which number or
 * address, and whether it actually went. That record is the only way to know
 * afterwards whether the duty phone was really reached.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS alert_escalations (
      id SERIAL PRIMARY KEY,
      alert_id INTEGER NOT NULL REFERENCES tracking_alerts(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      channel TEXT NOT NULL,
      target TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_alert_escalations_alert ON alert_escalations(alert_id, round);`);
  pgm.sql(`ALTER TABLE tracking_alerts ADD COLUMN IF NOT EXISTS escalation_round INTEGER NOT NULL DEFAULT 0;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS alert_escalations;`);
  pgm.sql(`ALTER TABLE tracking_alerts DROP COLUMN IF EXISTS escalation_round;`);
};

'use strict';

/**
 * Which alert types the control room is shown.
 *
 * An outsourced control room watching for theft does not need 1,071 idling
 * alerts a month, and the noise is what makes a tamper alert easy to miss.
 * This is separate from whether an alert is raised at all (enabled) and from
 * who is emailed about it (notify_enabled): the alert still exists, still
 * escalates, and admins still see it — the control room's list just doesn't
 * carry it.
 *
 * Visible unless told otherwise, so nothing disappears from anyone's screen
 * until an admin decides it should.
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS control_room_visible BOOLEAN NOT NULL DEFAULT TRUE;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE alert_settings DROP COLUMN IF EXISTS control_room_visible;`);
};

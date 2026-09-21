'use strict';

/**
 * Why a line carrying a part number the supplier's price list doesn't have was
 * sent anyway.
 *
 * Hero supply "only according to the part number requested by a dealer", so a
 * number they don't sell comes back rejected and the bike waits. Ordering one
 * is now refused unless somebody overrides it, and the reason they gave is
 * kept with the line — sometimes the price list is simply behind.
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE parts_order_items ADD COLUMN IF NOT EXISTS override_reason TEXT;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE parts_order_items DROP COLUMN IF EXISTS override_reason;`);
};

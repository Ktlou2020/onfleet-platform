'use strict';

/**
 * The Eco 150's own two documents disagree about the spark plug.
 *
 * The 36-month maintenance schedule prints 31916KRM4099S. Hero's dealer price
 * list sells 31916KRM84099S — described as SPARK PLUG, R37.13, itself
 * replacing 31916-KRM-841. One character apart, and since Hero supply "only
 * according to the part number requested by a dealer", the schedule's number
 * would come back rejected and the bike would wait for a plug that was never
 * coming.
 *
 * The schedule is corrected to the number that can actually be bought. Only
 * this one row: the other three scheduled parts missing from the price list
 * are less clear-cut and stay as they are, flagged on the job card, until
 * somebody confirms them with Hero.
 */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE service_schedule_parts
       SET part_number = '31916KRM84099S', updated_at = NOW()
     WHERE make = 'Hero' AND model = 'Eco 150'
       AND UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) = '31916KRM4099S';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE service_schedule_parts
       SET part_number = '31916KRM4099S', updated_at = NOW()
     WHERE make = 'Hero' AND model = 'Eco 150'
       AND UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) = '31916KRM84099S';
  `);
};

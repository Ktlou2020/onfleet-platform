'use strict';

/**
 * Two more Eco 150 schedule numbers Hero's price list doesn't carry, corrected
 * to the numbers they sell:
 *
 *  - Clutch cable: the schedule prints 22870KTN700S; the list sells
 *    22870KTN950S, CABLE COMP., CLUTCH (R38.61). Worth noting that the nearest
 *    number, 22871KTN700S, is the cable's *boot* at R3.47 — which is why these
 *    are read by description and confirmed, not matched on digits alone.
 *
 *  - Friction plate kit: the schedule prints K22222KTNA900S; the list sells
 *    the same kit as K22222KTNA900EES, KIT DISC CLUTCH FRICTION (R708.84).
 *
 * The tappet cover gasket (12391KRM840S) is deliberately left alone: the list
 * has both a head cover gasket at R29.70 and a second, different gasket at
 * R1.98, and guessing between them would put the wrong part on a bike.
 */
exports.up = (pgm) => {
  const correct = (from, to) => pgm.sql(`
    UPDATE service_schedule_parts
       SET part_number = '${to}', updated_at = NOW()
     WHERE make = 'Hero' AND model = 'Eco 150'
       AND UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) = '${from}';
  `);
  correct('22870KTN700S', '22870KTN950S');
  correct('K22222KTNA900S', 'K22222KTNA900EES');
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE service_schedule_parts SET part_number = '22870KTN700S'
            WHERE make='Hero' AND model='Eco 150' AND part_number = '22870KTN950S';`);
  pgm.sql(`UPDATE service_schedule_parts SET part_number = 'K22222KTNA900S'
            WHERE make='Hero' AND model='Eco 150' AND part_number = 'K22222KTNA900EES';`);
};

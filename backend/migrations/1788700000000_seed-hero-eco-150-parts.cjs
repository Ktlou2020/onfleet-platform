'use strict';

/**
 * The Hero dealer parts list for the Eco 150: 860 parts and kits with their
 * current part codes, prices excluding VAT, status, and the old number each
 * part replaces.
 *
 * Seeded rather than left for someone to upload, because the catalogue is what
 * makes the rest work — a service recommendation can only price itself, and an
 * order can only be placed, against a part number that exists here. Later
 * price lists are uploaded in the admin portal (Workshop → Parts), which uses
 * the same upsert, so this runs once and then gets out of the way.
 *
 * Marked source 'dealer_list', which keeps it apart from the OCR'd manufacturer
 * catalogue already in the table ('catalogue') and under the uniqueness rule
 * that makes re-importing update rather than duplicate.
 */

const path = require('path');

exports.up = (pgm) => {
  const { parts, make, model, source } = require(path.join(__dirname, '..', 'assets', 'parts-hero-eco-150.json'));
  const quote = (value) => (value === null || value === undefined || value === ''
    ? 'NULL'
    : `'${String(value).replace(/'/g, "''")}'`);
  const number = (value) => (value === null || value === undefined || Number.isNaN(Number(value)) ? 'NULL' : Number(value));

  for (const part of parts) {
    pgm.sql(`
      INSERT INTO parts_catalog
        (make, model, group_code, group_name, ref_no, part_number, description,
         status, supersedes, alternate_part_number, price_ex_vat, is_kit, source, updated_at)
      VALUES (${quote(make)}, ${quote(model)}, ${quote(part.group_code)}, ${quote(part.group_name)},
              ${quote(part.ref_no)}, ${quote(part.part_number)}, ${quote(part.description)},
              ${quote(part.status)}, ${quote(part.supersedes)}, ${quote(part.alternate_part_number)},
              ${number(part.price_ex_vat)}, ${part.is_kit ? 'TRUE' : 'FALSE'}, 'dealer_list', NOW())
      ON CONFLICT (make, model, part_number, source, COALESCE(ref_no, ''), COALESCE(group_code, ''))
        WHERE source <> 'catalogue'
      DO UPDATE SET description = EXCLUDED.description, group_name = EXCLUDED.group_name,
                    status = EXCLUDED.status, supersedes = EXCLUDED.supersedes,
                    alternate_part_number = EXCLUDED.alternate_part_number,
                    price_ex_vat = COALESCE(EXCLUDED.price_ex_vat, parts_catalog.price_ex_vat),
                    is_kit = EXCLUDED.is_kit, updated_at = NOW();
    `);
  }
  console.log(`[migration] seeding ${parts.length} parts from ${source}`);
};

exports.down = (pgm) => {
  // Only the seeded list goes; the OCR'd catalogue and any later uploads that
  // updated these rows stay as they are.
  pgm.sql(`DELETE FROM parts_catalog WHERE source = 'dealer_list' AND make = 'Hero' AND model = 'Eco 150';`);
};

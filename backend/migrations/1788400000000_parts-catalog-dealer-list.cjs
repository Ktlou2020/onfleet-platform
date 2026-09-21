'use strict';

/**
 * The dealer parts list adds what the OCR'd catalogue never had: the current
 * dealer part codes, the recommended retail price, whether a part is still
 * current, and which old part number each one replaces. Those last two matter
 * because Hero only supplies against the exact part number requested (their
 * ordering SOP), so ordering an old number is a rejected order.
 *
 * Kits (chain and sprocket, oil seal, valve) come as their own sheet and are
 * marked, since a kit is what a workshop actually orders for a service.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE parts_catalog
      ADD COLUMN IF NOT EXISTS price_ex_vat NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS status TEXT,
      ADD COLUMN IF NOT EXISTS supersedes TEXT,
      ADD COLUMN IF NOT EXISTS alternate_part_number TEXT,
      ADD COLUMN IF NOT EXISTS is_kit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'catalogue',
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // Searching by part number has to survive punctuation: the catalogue holds
  // 12391-KRM-840 and the dealer list 12391AAK900S, and a technician types
  // whichever is printed on the part in front of them.
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_parts_catalog_number_plain
             ON parts_catalog ((UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g'))));`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_parts_catalog_description_lower
             ON parts_catalog (LOWER(description));`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_parts_catalog_source ON parts_catalog(source);`);

  // One row per part number per source, so re-importing a price list updates
  // rather than duplicating.
  //
  // Only for imported lists: the rows already in the table came from OCR of a
  // manufacturer PDF and contain genuine duplicates (the same bolt listed
  // under two reference numbers in one group). A unique index across those
  // cannot be created, and deleting them to force one would throw away
  // catalogue data to satisfy a constraint that exists for imports.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_catalog_identity
      ON parts_catalog (make, model, part_number, source, COALESCE(ref_no, ''), COALESCE(group_code, ''))
      WHERE source <> 'catalogue';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_parts_catalog_identity;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_parts_catalog_source;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_parts_catalog_description_lower;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_parts_catalog_number_plain;`);
  pgm.sql(`
    ALTER TABLE parts_catalog
      DROP COLUMN IF EXISTS price_ex_vat, DROP COLUMN IF EXISTS status,
      DROP COLUMN IF EXISTS supersedes, DROP COLUMN IF EXISTS alternate_part_number,
      DROP COLUMN IF EXISTS is_kit, DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS updated_at;
  `);
};

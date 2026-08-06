'use strict';

/**
 * OEM parts catalogue reference data (ingested from manufacturer PDF
 * catalogues via scripts/ingest-parts-catalog.js) — lets the workshop pick
 * the correct part number for a bike model, with the manufacturer's
 * exploded-diagram image for visual confirmation, instead of typing a
 * free-text description from memory.
 *
 * One row per (group, ref_no, part_number) — a group can list the same
 * part_number more than once under different ref_nos (e.g. a bolt used in
 * two places), which is why part_number alone isn't unique.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE parts_catalog (
      id SERIAL PRIMARY KEY,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      group_code TEXT NOT NULL,
      group_name TEXT NOT NULL,
      ref_no TEXT,
      part_number TEXT NOT NULL,
      description TEXT NOT NULL,
      remark TEXT,
      qty_required INTEGER,
      diagram_image_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_parts_catalog_make_model ON parts_catalog(make, model);
    CREATE INDEX idx_parts_catalog_part_number ON parts_catalog(part_number);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS parts_catalog;`);
};

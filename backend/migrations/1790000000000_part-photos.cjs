'use strict';

/**
 * Photographs of parts, taken by the people who fit them.
 *
 * A technician does not know the part number. It is not written on the part —
 * it lives in the manufacturer's book, and the book is a set of exploded
 * diagrams. So "which one is this" is currently answered by reading a
 * description and hoping, and the wrong part ordered against Hero's SOP is a
 * rejected order rather than a returned one.
 *
 * The photograph is taken the first time a part is fitted, on the phone that
 * is already in the technician's hand, and every technician after that sees
 * it. The catalogue teaches itself in the order the parts actually get used,
 * which means the parts that matter are covered first and the long tail never
 * needs doing at all.
 *
 * Why this keys on the part number and not on parts_catalog.id, which is the
 * one thing about this table worth reading twice:
 *
 * The same physical part exists as two rows. One comes from the OCR'd
 * manufacturer book, one from the priced dealer list, and they are kept apart
 * on purpose by a `source` column. The search deliberately ranks the priced
 * row first, because only that one can be ordered against. But a photo hung
 * on a row id would belong to whichever row happened to be open when it was
 * taken — and about half the time that is not the row anybody sees. Keyed on
 * the number, one photograph covers every row that shares it, which is what
 * a photograph of a physical object ought to do.
 *
 * The number is stored stripped of punctuation for the same reason the
 * catalogue indexes it that way: 15410-KWB-601 and 15410KWB601 are one part.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS part_photos (
      id              SERIAL PRIMARY KEY,
      make            TEXT NOT NULL,
      model           TEXT NOT NULL,
      part_number     TEXT NOT NULL,
      -- Punctuation-stripped, so a lookup matches regardless of how the
      -- number was typed. Written by the application, not a generated column,
      -- because the same normalisation already lives in JS and SQL and a
      -- third copy in DDL would be a third thing to keep in step.
      part_number_key TEXT NOT NULL,
      file_path       TEXT NOT NULL,
      original_name   TEXT,
      caption         TEXT,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // The lookup the parts picker makes on every search: a handful of part
  // numbers for one model, answered at once.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_part_photos_lookup
      ON part_photos (LOWER(make), LOWER(model), part_number_key);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS part_photos;`);
};

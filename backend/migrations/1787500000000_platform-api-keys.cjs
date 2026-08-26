'use strict';

/**
 * API keys were always scoped to exactly one fleet-owner organisation, so every
 * /api/v1 query filtered on organization_id. That makes platform-owned bikes
 * (organization_id IS NULL) invisible to every key that can exist — fine for a
 * fleet owner pulling their own vehicles, useless for an outsourced control
 * room that monitors the whole platform.
 *
 * Adds an explicit scope. 'organization' keys behave exactly as before;
 * 'platform' keys see every vehicle regardless of owner and carry no
 * organization_id. The CHECK makes the two states mutually exclusive so a key
 * can never be ambiguously scoped.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'organization';`);
  pgm.sql(`ALTER TABLE api_keys ALTER COLUMN organization_id DROP NOT NULL;`);
  pgm.sql(`
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check CHECK (
      (scope = 'organization' AND organization_id IS NOT NULL)
      OR (scope = 'platform' AND organization_id IS NULL)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM api_keys WHERE scope = 'platform';`);
  pgm.sql(`ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scope_check;`);
  pgm.sql(`ALTER TABLE api_keys ALTER COLUMN organization_id SET NOT NULL;`);
  pgm.sql(`ALTER TABLE api_keys DROP COLUMN IF EXISTS scope;`);
};

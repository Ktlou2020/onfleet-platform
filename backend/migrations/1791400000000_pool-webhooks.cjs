'use strict';

// Pushing pool finance to the funder, rather than making them poll for it.
//
// The same shape as the API key that reads /v1/pools: an endpoint scoped to
// named pools and nothing else. It matters more here than it does there,
// because an alarm webhook's payload carries a rider's name and phone number
// and a funder's endpoint must never be handed one. Keeping funder endpoints
// in their own scope means the alert dispatcher's existing
// `WHERE scope = 'platform'` excludes them without anybody having to remember
// to exclude them.

exports.up = (pgm) => {
  pgm.addColumns('webhook_endpoints', {
    pool_ids: {
      type: 'integer[]',
      comment: 'Funder endpoints: the only pools this endpoint receives events for',
    },
  });

  pgm.dropConstraint('webhook_endpoints', 'webhook_endpoints_scope_check');
  pgm.addConstraint('webhook_endpoints', 'webhook_endpoints_scope_check', `CHECK (
    (scope = 'organization' AND organization_id IS NOT NULL AND pool_ids IS NULL)
    OR (scope = 'platform' AND organization_id IS NULL AND pool_ids IS NULL)
    OR (scope = 'funder' AND organization_id IS NULL
        AND pool_ids IS NOT NULL AND array_length(pool_ids, 1) > 0)
  )`);
};

exports.down = (pgm) => {
  pgm.dropConstraint('webhook_endpoints', 'webhook_endpoints_scope_check');
  pgm.addConstraint('webhook_endpoints', 'webhook_endpoints_scope_check', `CHECK (
    (scope = 'organization' AND organization_id IS NOT NULL)
    OR (scope = 'platform' AND organization_id IS NULL)
  )`);
  pgm.dropColumns('webhook_endpoints', ['pool_ids']);
};

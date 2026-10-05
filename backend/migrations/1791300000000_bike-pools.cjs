'use strict';

// Bike pools: the financing layer under the fleet.
//
// A funder — SV Capital first, others later — advances money against a set of
// delivery bikes and gets paid back out of what the riders on those bikes pay
// every week. Until now that relationship existed only in a spreadsheet, and
// answering "how is tranche 3 doing" meant someone exporting payments and
// joining them to a list of registrations by hand.
//
// A pool groups BIKES, not agreements, and that is the important decision
// here. An agreement ends when a rider leaves; the bike does not. If pools
// were agreement-shaped, a pool's balance would lurch every time somebody
// defaulted and the bike was re-let to the next rider — which is the ordinary
// course of business, not a change in what the funder owns. Grouping the
// asset means the pool's position is continuous across rider churn, and the
// agreements that have run on a bike over time are just the history of how it
// earned.
//
// capital_advanced is what the funder actually put in. It is deliberately
// separate from the sum of bikes.purchase_price: the two differ by deposits,
// delivery, pre-delivery inspection and whatever was negotiated, and a funder
// reconciling their own books needs the number they wired, not ours.

exports.up = (pgm) => {
  pgm.createTable('bike_pools', {
    id: 'id',
    name: { type: 'text', notNull: true },
    // The funder's own identifier for this tranche. They will quote it back to
    // us long before they quote our integer id, so it is worth storing and
    // worth being able to look up by.
    reference: { type: 'text' },
    funder: { type: 'text', notNull: true, comment: 'Who advanced the capital, e.g. SV Capital' },
    capital_advanced: {
      type: 'numeric(14,2)',
      comment: 'What the funder actually advanced — not the sum of our purchase prices',
    },
    advanced_on: { type: 'date' },
    // A pool belonging to one fleet owner, or NULL for a pool that spans them
    // or sits on platform-owned stock.
    organization_id: { type: 'integer', references: 'organizations' },
    status: { type: 'text', notNull: true, default: 'open' },
    notes: { type: 'text' },
    created_by: { type: 'integer', references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('bike_pools', 'bike_pools_status_check',
    "CHECK (status IN ('open', 'closed'))");

  // Case-insensitively unique, because "SVC-2026-01" and "svc-2026-01" being
  // two different pools is a reconciliation problem waiting to happen.
  pgm.sql(`CREATE UNIQUE INDEX bike_pools_reference_unique
             ON bike_pools (LOWER(reference)) WHERE reference IS NOT NULL`);

  pgm.addColumns('bikes', {
    pool_id: {
      type: 'integer',
      references: 'bike_pools',
      comment: 'The financing pool this bike was bought under',
    },
  });
  pgm.createIndex('bikes', 'pool_id', { where: 'pool_id IS NOT NULL' });

  // Scoping a key to specific pools.
  //
  // The existing scopes are 'platform' (everything, every fleet) and
  // 'organization' (one fleet owner). Neither fits a funder: platform would
  // hand them every rider's name and phone number across the whole estate to
  // answer a question about money, and organization is the wrong axis
  // entirely — a pool can span fleet owners and a fleet owner's bikes can sit
  // in several funders' pools.
  //
  // So a third scope that can only reach the pool endpoints, restricted to
  // the pools named here. NULL pool_ids on a platform key keeps its existing
  // meaning: no restriction.
  pgm.addColumns('api_keys', {
    pool_ids: {
      type: 'integer[]',
      comment: 'Funder keys: the only pools this key may read. NULL = unrestricted',
    },
  });

  pgm.dropConstraint('api_keys', 'api_keys_scope_check');
  pgm.addConstraint('api_keys', 'api_keys_scope_check', `CHECK (
    (scope = 'organization' AND organization_id IS NOT NULL AND pool_ids IS NULL)
    OR (scope = 'platform' AND organization_id IS NULL)
    OR (scope = 'funder' AND organization_id IS NULL
        AND pool_ids IS NOT NULL AND array_length(pool_ids, 1) > 0)
  )`);
};

exports.down = (pgm) => {
  pgm.dropConstraint('api_keys', 'api_keys_scope_check');
  pgm.addConstraint('api_keys', 'api_keys_scope_check', `CHECK (
    (scope = 'organization' AND organization_id IS NOT NULL)
    OR (scope = 'platform' AND organization_id IS NULL)
  )`);
  pgm.dropColumns('api_keys', ['pool_ids']);
  pgm.dropIndex('bikes', 'pool_id');
  pgm.dropColumns('bikes', ['pool_id']);
  pgm.sql('DROP INDEX IF EXISTS bike_pools_reference_unique');
  pgm.dropTable('bike_pools');
};

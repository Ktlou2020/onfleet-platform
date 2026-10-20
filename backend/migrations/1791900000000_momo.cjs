'use strict';

// MTN MoMo: money in from riders, money out to fleet owners.
//
// Today a rider pays by card through Paystack and a fleet owner is paid by an
// administrator doing a bank transfer by hand against fleet_payout_requests.
// Both ends assume a bank. In the markets this platform actually operates in,
// the wallet in the rider's pocket is the account that exists, and the card is
// the thing that does not.
//
// momo_transactions is deliberately a record of OUR side of MTN's ledger
// rather than a second ledger. The reference id is MTN's handle on the
// transaction and the only way to ask them about it afterwards, so it is
// generated before the call, stored before the call, and unique. A request
// that we sent but never recorded is money we cannot account for; a record
// with no request is a row we can reconcile and close.

exports.up = (pgm) => {
  // Where a rider pays from and a fleet owner is paid to.
  //
  // Verified separately from stored, because a number that has merely been
  // typed is not a number money should be sent to. MTN can confirm an MSISDN
  // is a live wallet and give back the name on it, and until it has, this is
  // just a string somebody entered.
  pgm.addColumns('users', {
    momo_msisdn: { type: 'text', comment: 'MoMo wallet number, digits only, country code included' },
    momo_verified_at: { type: 'timestamptz' },
    momo_account_name: { type: 'text', comment: 'The name MTN holds for that wallet' },
  });

  pgm.addColumns('organizations', {
    momo_msisdn: { type: 'text', comment: 'Where this fleet owner wants payouts sent' },
    momo_verified_at: { type: 'timestamptz' },
    momo_account_name: { type: 'text' },
  });

  pgm.createTable('momo_transactions', {
    id: 'id',
    // MTN's handle. Ours to generate, theirs to remember.
    reference_id: { type: 'uuid', notNull: true, unique: true },
    direction: { type: 'text', notNull: true, comment: "'collection' takes money in, 'disbursement' pays it out" },
    status: { type: 'text', notNull: true, default: 'pending' },

    amount: { type: 'numeric(12,2)', notNull: true },
    currency: { type: 'text', notNull: true },
    msisdn: { type: 'text', notNull: true },
    // Our own identifier, echoed back by MTN on every status check. What makes
    // their statement reconcilable against ours without a human reading dates.
    external_id: { type: 'text', notNull: true },

    organization_id: { type: 'integer', references: 'organizations', onDelete: 'SET NULL' },
    user_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    agreement_id: { type: 'integer' },
    payment_schedule_id: { type: 'integer' },
    payout_request_id: { type: 'integer' },

    // What MTN last said, kept verbatim beside our own interpretation of it.
    // The two disagreeing is a thing worth being able to see.
    momo_status: { type: 'text' },
    momo_reason: { type: 'text' },
    last_payload: { type: 'text' },

    requested_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    settled_at: { type: 'timestamptz' },
    checked_at: { type: 'timestamptz', comment: 'When the status was last asked of MTN' },
  });

  pgm.addConstraint('momo_transactions', 'momo_transactions_direction_check',
    "CHECK (direction IN ('collection', 'disbursement'))");
  pgm.addConstraint('momo_transactions', 'momo_transactions_status_check',
    "CHECK (status IN ('pending', 'successful', 'failed'))");

  // The reconciler's query: everything still in the air, oldest first.
  pgm.createIndex('momo_transactions', ['requested_at'], {
    name: 'idx_momo_transactions_unsettled',
    where: "status = 'pending'",
  });
  pgm.createIndex('momo_transactions', ['organization_id', 'requested_at']);
  pgm.createIndex('momo_transactions', ['external_id']);

  // A payout can now go to a wallet instead of a bank account. Existing rows
  // are bank payouts because that is what they were.
  pgm.addColumns('fleet_payout_requests', {
    payout_method: { type: 'text', notNull: true, default: 'bank' },
    momo_msisdn: { type: 'text' },
    momo_transaction_id: { type: 'integer', references: 'momo_transactions', onDelete: 'SET NULL' },
  });
  pgm.addConstraint('fleet_payout_requests', 'fleet_payout_requests_method_check',
    "CHECK (payout_method IN ('bank', 'momo'))");
};

exports.down = (pgm) => {
  pgm.dropConstraint('fleet_payout_requests', 'fleet_payout_requests_method_check');
  pgm.dropColumns('fleet_payout_requests', ['payout_method', 'momo_msisdn', 'momo_transaction_id']);
  pgm.dropTable('momo_transactions');
  pgm.dropColumns('organizations', ['momo_msisdn', 'momo_verified_at', 'momo_account_name']);
  pgm.dropColumns('users', ['momo_msisdn', 'momo_verified_at', 'momo_account_name']);
};

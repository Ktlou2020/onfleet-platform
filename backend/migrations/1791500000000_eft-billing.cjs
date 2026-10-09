'use strict';

// Clients who pay by EFT.
//
// Everything about the billing run assumes a card: organizationsDue requires
// billing_authorization_encrypted to be present, chargeOrganization presents
// that card to Paystack, and a decline starts the dunning clock that ends in
// a suspended account.
//
// A client paying by EFT has no card, and the consequence is worse than "no
// charge is attempted". Their trial ends, the gate in routes/fleet.js flips
// them to past_due on the very next request, and they are locked out with
// "Go to Billing to upgrade your plan" — while the billing run skips them
// entirely, because they have no card. Nothing ever un-blocks them. They
// could pay the full amount by EFT that morning and the platform would have
// no idea, because nothing is watching a bank account.
//
// So two separate things, and they are separate on purpose:
//
//   billing_method    how this client pays. 'eft' means invoice them and
//                     never present a card, and give them a settlement
//                     window that suits a manual bank transfer rather than
//                     one that suits a card retry.
//
//   billing_hold_until  an explicit instruction not to block this account
//                     before a date, whatever the billing state says. This
//                     is for the ordinary case of "the money is in flight
//                     and we know it" — somebody has sent proof of payment,
//                     or terms were agreed, and nobody should be locked out
//                     while a human reconciles it. It is deliberately a
//                     dated override and not a boolean, because "never block
//                     this client" is not a thing anybody should be able to
//                     set once and forget.

exports.up = (pgm) => {
  pgm.addColumns('organizations', {
    billing_method: {
      type: 'text',
      notNull: true,
      default: 'card',
      comment: "'card' presents a card to Paystack; 'eft' raises an invoice and waits",
    },
    billing_hold_until: {
      type: 'date',
      comment: 'Do not block this account before this date, whatever billing says',
    },
    billing_hold_reason: { type: 'text' },
  });

  pgm.addConstraint('organizations', 'organizations_billing_method_check',
    "CHECK (billing_method IN ('card', 'eft'))");

  // The billing run's "who is due" index assumes a card is present. An EFT
  // client is due on exactly the same dates and has no card, so it needs to
  // find them too.
  pgm.createIndex('organizations', ['next_billing_date', 'billing_retry_at'], {
    name: 'idx_organizations_billing_due_eft',
    where: "subscription_tier IS NOT NULL AND billing_method = 'eft'",
  });

  // How an invoice was actually settled. A Paystack charge fills this in by
  // itself; an EFT is somebody in the office matching a bank statement line
  // to an invoice, and who did that and against which reference is the whole
  // audit trail for money that arrived outside the system.
  pgm.addColumns('subscription_invoices', {
    settlement_method: { type: 'text', comment: 'paystack, eft, cash or other' },
    settlement_reference: { type: 'text', comment: 'The bank reference the payer used' },
    settled_by: { type: 'integer', references: 'users', comment: 'Who matched it, for an EFT' },
    settled_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('subscription_invoices',
    ['settlement_method', 'settlement_reference', 'settled_by', 'settled_at']);
  pgm.dropIndex('organizations', ['next_billing_date', 'billing_retry_at'],
    { name: 'idx_organizations_billing_due_eft' });
  pgm.dropConstraint('organizations', 'organizations_billing_method_check');
  pgm.dropColumns('organizations', ['billing_method', 'billing_hold_until', 'billing_hold_reason']);
};

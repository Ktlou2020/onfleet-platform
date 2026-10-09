'use strict';

// Winding down the flat monthly subscriptions.
//
// Cancelling one at Paystack stops the next charge and leaves the period
// already paid for alone — which is what "cancel at period end" means here;
// there is nothing to schedule. What does need recording is the date that
// period runs out, for two reasons.
//
// The customer has paid up to it and should be told so rather than wondering
// what they bought. And our own billing run must not start before it: a fleet
// moved onto per-bike with a card on file would otherwise be invoiced by us
// for days the flat plan had already covered. Writing the date to
// next_billing_date is what hands over cleanly, and keeping it here as well
// means the handover is still legible afterwards.

exports.up = (pgm) => {
  pgm.addColumns('organizations', {
    legacy_subscription_ends_at: {
      type: 'date',
      comment: 'The flat plan was cancelled and is paid up to this date',
    },
    legacy_subscription_cancelled_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('organizations',
    ['legacy_subscription_ends_at', 'legacy_subscription_cancelled_at']);
};

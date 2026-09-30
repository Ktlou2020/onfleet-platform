'use strict';

// The line an invoice needs so that it adds up.
//
// subscription_invoices records subtotal, vat, vat_rate and amount, and until
// now those reconciled: subtotal + vat was exactly the amount charged.
//
// Passing the card-processing fee on to the customer breaks that. The fee is
// part of the supply, so it sits beside the subtotal and is taxed with it,
// and an invoice carrying only the two old figures is short by the fee — on a
// forty-bike Complete fleet, R15 000 + R2 330.71 against an amount of
// R17 868.77, with R538.06 unexplained.
//
// A tax invoice whose lines do not add up to what was taken off the card is
// not a document a customer can put through their books, and it is the first
// thing they will query. Hence a column rather than a calculation: the fee
// that was actually charged, recorded at the time it was charged, so a
// historical invoice still reconciles after the rate changes.
//
// Existing rows get 0, which is true of every invoice raised before this:
// none of them carried a fee.

exports.up = (pgm) => {
  pgm.addColumns('subscription_invoices', {
    processing_fee: {
      type: 'numeric(12,2)',
      notNull: true,
      default: 0,
      comment: 'Card-processing fee charged to the customer, exclusive of VAT',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('subscription_invoices', ['processing_fee']);
};

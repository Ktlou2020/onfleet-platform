'use strict';

// VAT on a subscription invoice.
//
// Every rate we quote — R95, R195, R295, R375 a bike — is exclusive of VAT,
// and nothing in billing knew that. quote() handed Paystack the ex-VAT figure
// and the invoice recorded one `amount` with no split, so we under-collected
// by fifteen per cent and issued a document that is not a tax invoice: a
// VAT-registered customer cannot claim input tax against a total with no VAT
// line on it.
//
// The split is stored rather than recomputed on display. A rate change or a
// VAT rate change must not retrospectively alter what an issued invoice says
// was charged, and an invoice is the one record a customer may hold for five
// years.

exports.up = (pgm) => {
  pgm.addColumns('subscription_invoices', {
    subtotal: { type: 'numeric' },
    vat: { type: 'numeric' },
    vat_rate: { type: 'numeric' },
  });

  // Invoices raised before this: `amount` was the ex-VAT figure, because that
  // is what was charged. Recorded as such rather than back-dating a VAT
  // amount nobody ever paid.
  pgm.sql(`
    UPDATE subscription_invoices
       SET subtotal = amount, vat = 0, vat_rate = 0
     WHERE subtotal IS NULL
  `);
};

exports.down = (pgm) => {
  pgm.dropColumns('subscription_invoices', ['subtotal', 'vat', 'vat_rate']);
};

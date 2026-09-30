import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const pricing = createRequire(import.meta.url)('../src/services/subscriptionPricing.js');

// Making the quoted price the price that arrives.
//
// The rate card is what the business intends to receive. A card payment does
// not deliver it: Paystack keeps a percentage and a fixed amount, and on a
// R950 invoice that is most of a bike's monthly margin. So the fee is added
// and the arithmetic run backwards from the figure that has to land.
//
// The subtlety worth testing is VAT. The surcharge is part of the
// consideration for the supply, so it is taxed too, and that tax is money
// owed to SARS which the surcharge then has to cover as well. Grossing up the
// VAT-inclusive total alone leaves the business roughly half a percent short
// — small enough to go unnoticed for a year and large enough to matter.

const RATE = pricing.PAYSTACK_FEE_RATE;
const FIXED = pricing.PAYSTACK_FEE_FIXED;

/** What actually reaches the bank, and what is left after SARS. */
function settle(q) {
  const paystackKeeps = RATE * q.total + FIXED;
  const received = q.total - paystackKeeps;
  return { paystackKeeps, received, keptAfterVat: received - q.vat };
}

describe('the money that actually arrives', () => {
  // The whole requirement, stated once.
  it('leaves the business exactly the package amount', () => {
    const q = pricing.quote({ tierKey: 'basic', bikes: 10 });
    expect(q.subtotal).toBe(950);
    expect(settle(q).keptAfterVat).toBeCloseTo(950, 2);
  });

  // Across every tier and a spread of sizes, because a formula that works at
  // one number and not another is worse than no formula.
  it('does so at every tier and every size', () => {
    for (const tier of pricing.allTiers()) {
      for (const bikes of [10, 11, 23, 40, 137, 500]) {
        for (const cycle of ['monthly', 'annual']) {
          const q = pricing.quote({ tierKey: tier.key, bikes, cycle });
          expect(
            settle(q).keptAfterVat,
            `${tier.key} / ${bikes} bikes / ${cycle}`,
          ).toBeCloseTo(q.subtotal, 1);
        }
      }
    }
  });

  it('and reports that figure itself, rather than leaving it to be worked out', () => {
    for (const bikes of [10, 50, 200]) {
      const q = pricing.quote({ tierKey: 'fleet', bikes });
      expect(q.net_after_fees).toBeCloseTo(q.subtotal, 1);
    }
  });
});

describe('what the customer is shown', () => {
  it('carries the fee as its own line, not folded into the rate', () => {
    const q = pricing.quote({ tierKey: 'basic', bikes: 10 });
    expect(q.per_bike_monthly).toBe(95);      // the rate card is untouched
    expect(q.subtotal).toBe(950);             // so is the package
    expect(q.processing_fee).toBeGreaterThan(0);
    expect(q.processing_fee_label).toBe('Card processing');
  });

  // The surcharge is part of the supply, so VAT is charged on it too.
  it('charges VAT on the fee as well as the package', () => {
    const q = pricing.quote({ tierKey: 'basic', bikes: 10 });
    expect(q.invoiced_ex_vat).toBeCloseTo(q.subtotal + q.processing_fee, 2);
    expect(q.vat).toBeCloseTo(q.invoiced_ex_vat * q.vat_rate, 2);
  });

  it('adds up: package + fee + VAT is what is charged', () => {
    for (const bikes of [10, 37, 240]) {
      const q = pricing.quote({ tierKey: 'complete', bikes });
      expect(q.total).toBeCloseTo(q.subtotal + q.processing_fee + q.vat, 2);
    }
  });

  it('sends Paystack the charged figure in cents', () => {
    const q = pricing.quote({ tierKey: 'workshop', bikes: 14 });
    expect(q.amount_kobo).toBe(Math.round(q.total * 100));
  });

  // Simply adding 3% to the VAT-inclusive total is the obvious approach and
  // it is wrong. This pins down that we did not do that.
  it('is not the naive gross-up, which comes up short', () => {
    const q = pricing.quote({ tierKey: 'basic', bikes: 10 });
    const naiveTotal = (q.subtotal * (1 + q.vat_rate) + FIXED) / (1 - RATE);
    const naiveVat = (naiveTotal * q.vat_rate) / (1 + q.vat_rate);
    const naiveKept = naiveTotal - (RATE * naiveTotal + FIXED) - naiveVat;
    expect(naiveKept).toBeLessThan(950);          // the trap
    expect(settle(q).keptAfterVat).toBeCloseTo(950, 2); // what we do instead
  });
});

describe('the fee on its own', () => {
  it('is nothing on nothing', () => {
    expect(pricing.processingFee(0)).toBe(0);
  });

  it('grows with the amount', () => {
    expect(pricing.processingFee(10000)).toBeGreaterThan(pricing.processingFee(1000));
  });

  // Paystack caps its local-card fee. Above that ceiling the percentage stops
  // applying, and an uncapped calculation would overcharge a large fleet
  // badly — on R75 000 the uncapped fee is over R2 600.
  it('stops at the cap once one is configured', () => {
    const capped = pricing.processingFee(75000, { cap: 100 });
    expect(capped).toBe(100);
  });

  it('ignores the cap while the fee is still below it', () => {
    const small = pricing.processingFee(950, { cap: 100 });
    expect(small).toBeLessThan(100);
    expect(small).toBeCloseTo(pricing.processingFee(950), 2);
  });

  // A processor taking more than the whole margin cannot be recovered by a
  // surcharge, and emitting a negative or enormous fee would be worse than
  // charging nothing.
  it('gives up rather than emit nonsense at an impossible rate', () => {
    expect(pricing.processingFee(1000, { rate: 0.99 })).toBe(0);
  });
});

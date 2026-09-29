import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const brandModule = createRequire(import.meta.url)('../src/brand.js');
const { BRANDS, CONSOLES, publicBrand } = brandModule;

// Which console a deployment shows.
//
// Until this existed the brand was cosmetic — a name, a logo, a colour — and
// nothing about routing or permission depended on it. This is the first thing
// that does, so it is worth pinning down: the two products are different
// shapes of business, not two skins on one.
//
//   fleet       the operator owns the motorcycles. The admin portal is the
//               whole business. That is OnFleet.
//   telematics  the operator owns none and sells the platform to companies
//               that do. The admin portal is tenants, devices and billing.
//               That is Pillion.

describe('the console a brand runs', () => {
  it('has OnFleet running its own motorcycles', () => {
    expect(BRANDS.onfleet.adminConsole).toBe(CONSOLES.FLEET);
  });

  it('has Pillion selling the platform to people who do', () => {
    expect(BRANDS.pillion.adminConsole).toBe(CONSOLES.TELEMATICS);
  });

  // The two are not interchangeable and there is no third.
  it('gives every brand one of the two consoles', () => {
    for (const [key, b] of Object.entries(BRANDS)) {
      expect(Object.values(CONSOLES), `${key} has an unknown console`).toContain(b.adminConsole);
    }
  });
});

describe('what reaches the browser', () => {
  // The frontend picks the console on first paint, before anything has been
  // fetched, so it has to travel in the inlined brand rather than an endpoint.
  it('carries the console to the frontend', () => {
    expect(publicBrand(BRANDS.pillion).adminConsole).toBe('telematics');
    expect(publicBrand(BRANDS.onfleet).adminConsole).toBe('fleet');
  });

  // OnFleet's HTML is deliberately left untouched, so it carries no brand
  // global at all and the frontend falls back. That fallback has to be the
  // fleet console, or the untouched deployment silently changes shape.
  it('defaults to the fleet console when a brand does not say', () => {
    expect(publicBrand({ key: 'x', name: 'X' }).adminConsole).toBe('fleet');
  });

  // Whatever else goes in the brand, this is not a place for secrets.
  it('sends nothing but the fields the frontend needs', () => {
    expect(Object.keys(publicBrand(BRANDS.pillion)).sort()).toEqual(
      ['adminConsole', 'domain', 'fullName', 'key', 'marketingUrl', 'name', 'portalUrl']);
  });
});

describe('the rest of the brand, which this must not have disturbed', () => {
  it('still knows Pillion owns no motorcycles', () => {
    // A lessor on an agreement has to be a company that actually owns bikes.
    expect(BRANDS.pillion.legalEntity).toBeNull();
    expect(BRANDS.onfleet.legalEntity).not.toBeNull();
  });

  it('still sends each brand its own email', () => {
    expect(BRANDS.pillion.email.from).toBe('support@pillion.co.za');
    expect(BRANDS.onfleet.email.from).toBe('no-reply@onfleet.africa');
  });
});

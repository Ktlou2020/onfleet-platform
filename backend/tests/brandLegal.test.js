import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const load = createRequire(import.meta.url);

// Who the public terms and privacy pages name as the other party.
//
// Both pages used to say OnFleet Africa whoever was reading them. A fleet
// operator who signed up to Pillion was shown a Terms of Service for a product
// called OnFleet, told to write to legal@onfleetafrica.co.za about their
// contract, and given a privacy policy naming OnFleet Africa as the party
// responsible for their riders' personal information under POPIA — a brand they
// had never bought anything from.
//
// The company really is the same one for both products, so what these assert is
// not that the provider differs. It is that the page reads the provider and the
// contact addresses from the brand instead of having them written into it, and
// that a brand cannot ship without them.

function loadBrand(brandKey) {
  const prev = process.env.BRAND;
  if (brandKey) process.env.BRAND = brandKey; else delete process.env.BRAND;
  for (const k of Object.keys(load.cache)) {
    if (k.includes('/src/brand.js')) delete load.cache[k];
  }
  const mod = load('../src/brand.js');
  if (prev === undefined) delete process.env.BRAND; else process.env.BRAND = prev;
  return mod;
}

const LEGAL_FIELDS = ['provider', 'address', 'legalEmail', 'privacyEmail'];

describe('the company the legal pages name', () => {
  it('reaches the frontend, because the pages render before anyone signs in', () => {
    const { publicBrand } = loadBrand('pillion');
    const legal = publicBrand().legal;
    for (const field of LEGAL_FIELDS) {
      expect(legal[field], `publicBrand().legal.${field}`).toBeTruthy();
    }
  });

  it('is carried in the page itself, so no fetch stands between it and the first paint', () => {
    const { brandScriptTag } = loadBrand('pillion');
    const tag = brandScriptTag();
    expect(tag).toContain('legal@pillion.co.za');
    expect(tag).toContain('OnFleet Africa (Pty) Ltd');
  });

  it('answers a Pillion customer at a Pillion address', () => {
    const { brand } = loadBrand('pillion');
    expect(brand.legal.legalEmail).toBe('legal@pillion.co.za');
    expect(brand.legal.privacyEmail).toBe('privacy@pillion.co.za');
  });

  it('answers an OnFleet customer at an OnFleet address', () => {
    const { brand } = loadBrand(undefined);
    expect(brand.key).toBe('onfleet');
    expect(brand.legal.legalEmail).toBe('legal@onfleetafrica.co.za');
    expect(brand.legal.privacyEmail).toBe('privacy@onfleetafrica.co.za');
  });

  it('names a registered company on every brand, not a product name', () => {
    const { BRANDS } = loadBrand(undefined);
    for (const [key, b] of Object.entries(BRANDS)) {
      for (const field of LEGAL_FIELDS) {
        expect(b.legal?.[field], `${key}.legal.${field}`).toBeTruthy();
      }
      // A terms page whose other party is "Pillion" binds nobody. The provider
      // has to be the company that is actually registered.
      expect(b.legal.provider, `${key}.legal.provider`).toMatch(/\(Pty\) Ltd|Ltd|Inc|LLC/);
      expect(b.legal.legalEmail, `${key}.legal.legalEmail`).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
      expect(b.legal.privacyEmail, `${key}.legal.privacyEmail`).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
    }
  });

  it('keeps the provider separate from whoever owns the bikes', () => {
    // `legalEntity` is the lessor on an agreement and Pillion has none, because
    // it owns no motorcycles. That absence must not take the provider with it:
    // Pillion is still sold by a company, and its terms still bind one.
    const { brand } = loadBrand('pillion');
    expect(brand.legalEntity).toBeNull();
    expect(brand.legal.provider).toBeTruthy();
  });
});

// Which product this deployment is, from the frontend's side.
//
// The backend inlines `window.__BRAND__` into the page head before sending it,
// so this is already correct on the first paint — nothing fetches, nothing
// flashes the wrong name on its way to the right one.
//
// The fallback is OnFleet rather than empty, because an OnFleet deployment's
// HTML is deliberately left untouched and so carries no global at all. That is
// the normal case, not an error.

const FALLBACK = {
  key: 'onfleet',
  name: 'OnFleet',
  fullName: 'OnFleet Africa',
  portalUrl: 'https://portal.onfleet.africa',
  domain: 'portal.onfleet.africa',
  // A deployment that carries no brand global is OnFleet, and OnFleet runs its
  // own motorcycles. Falling back to the fleet console keeps that deployment
  // working exactly as it did before consoles existed.
  adminConsole: 'fleet',
};

const injected = typeof window !== 'undefined' ? window.__BRAND__ : null;

const brand = Object.freeze({ ...FALLBACK, ...(injected || {}) });

export default brand;

/** "OnFleet" / "Pillion" — the everyday name, for sentences. */
export const brandName = brand.name;

/** "OnFleet Africa" / "Pillion" — the full name, for sign-offs and footers. */
export const brandFullName = brand.fullName;

/**
 * Which admin console this deployment shows: 'fleet' for a company that runs
 * its own motorcycles, 'telematics' for one that sells the platform to
 * companies that do. See backend/src/brand.js for why this is a property of
 * the brand rather than a setting of its own.
 */
export const adminConsole = brand.adminConsole || 'fleet';

/** True on a deployment whose operator owns no motorcycles. */
export const isTelematicsConsole = adminConsole === 'telematics';

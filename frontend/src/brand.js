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
};

const injected = typeof window !== 'undefined' ? window.__BRAND__ : null;

const brand = Object.freeze({ ...FALLBACK, ...(injected || {}) });

export default brand;

/** "OnFleet" / "Pillion" — the everyday name, for sentences. */
export const brandName = brand.name;

/** "OnFleet Africa" / "Pillion" — the full name, for sign-offs and footers. */
export const brandFullName = brand.fullName;

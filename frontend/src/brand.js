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
  // Who the public terms and privacy pages name as the other party. OnFleet's
  // values live here rather than in the injected global for the same reason as
  // the rest of this object: an OnFleet deployment's HTML is left untouched and
  // carries no global at all.
  legal: {
    provider: 'OnFleet Africa (Pty) Ltd',
    address: 'Unit E20, 472 Spionkop Avenue, Kya Sand, Johannesburg',
    legalEmail: 'legal@onfleetafrica.co.za',
    privacyEmail: 'privacy@onfleetafrica.co.za',
  },
};

const injected = typeof window !== 'undefined' ? window.__BRAND__ : null;

// `legal` is merged on its own rather than left to the outer spread, which
// would replace the whole object. A payload carrying only some of its fields
// would otherwise blank the others, and a privacy policy with no address on it
// is worse than one that is a version behind.
const brand = Object.freeze({
  ...FALLBACK,
  ...(injected || {}),
  legal: Object.freeze({ ...FALLBACK.legal, ...((injected && injected.legal) || {}) }),
});

export default brand;

/** "OnFleet" / "Pillion" — the everyday name, for sentences. */
export const brandName = brand.name;

/** "OnFleet Africa" / "Pillion" — the full name, for sign-offs and footers. */
export const brandFullName = brand.fullName;

/**
 * The registered company behind the brand and how to reach it, for the terms
 * and privacy pages. `provider` is the party to the contract; the brand name is
 * only what the contract calls it.
 */
export const brandLegal = brand.legal;

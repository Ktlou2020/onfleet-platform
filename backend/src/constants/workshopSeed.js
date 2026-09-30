'use strict';

// The workshops a brand new database starts with.
//
// Lives here rather than inline in the migration for two reasons. It can be
// tested without standing up a database and running migrations against it,
// and the decision it encodes — whose workshops these are — is a product
// decision that deserves to be readable somewhere other than a file nobody
// opens twice.
//
// OnFleet owns two workshops and services its own motorcycles at them, so an
// OnFleet database starts with them by name. Pillion owns none: it sells the
// platform to companies that do, and shipping a Pillion deployment with a
// competitor's workshop names in it is what this exists to stop. That is not
// hypothetical — it happened, and the rows are still there in production.
//
// A non-OnFleet deployment gets one obvious placeholder instead. One rather
// than two because the booking page only offers a workshop picker when there
// is more than one, so a single row keeps a fresh deployment's rider flow
// simple until somebody adds a real second.

const GENERIC = [
  {
    name: 'Main Workshop',
    // NOT NULL, and we have no idea what it is. An em dash reads as
    // unanswered rather than as a place.
    city: '—',
    // Deliberately null. Province is matched against a rider's own to choose
    // which workshop they see first, and a placeholder should never win that.
    province: null,
  },
];

const ONFLEET = [
  { name: 'OnFix', city: 'Johannesburg', province: 'Gauteng' },
  { name: 'Bikerhouse', city: 'Cape Town', province: 'Western Cape' },
];

/**
 * @param {boolean} isDefaultBrand true on an OnFleet deployment — which is
 *   also what an unset or unrecognised BRAND resolves to, per src/brand.js.
 */
function initialWorkshops(isDefaultBrand) {
  return isDefaultBrand ? ONFLEET : GENERIC;
}

module.exports = { initialWorkshops, ONFLEET, GENERIC };

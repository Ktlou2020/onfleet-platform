'use strict';

// Which product this deployment is.
//
// One codebase, one image, two products: OnFleet Africa runs its own fleet on
// it, and Pillion sells it to other fleets. They differ in name and mark, not
// in behaviour, so the difference is a runtime variable rather than a second
// build. `BRAND` is an ordinary Railway service variable and each environment
// sets its own.
//
// OnFleet is the default, and the default is not merely a fallback: when
// `BRAND` is unset or names something we do not have, nothing about the
// response changes at all — the brand-asset routes below are never even
// registered. A deployment has to ask to be rebranded. That is what keeps a
// typo in a variable from quietly re-skinning the live platform.
//
// This covers the mark, the tab, the home-screen icon and the share preview.
// It does not cover the several hundred places the words "OnFleet Africa"
// appear in emails, contracts, SMS and legal pages — those are copy, some of
// it naming a real legal entity, and they need writing rather than switching.

const BRANDS = {
  onfleet: {
    key: 'onfleet',
    name: 'OnFleet',
    fullName: 'OnFleet Africa',
    themeColor: '#1E88D1',
    domain: 'portal.onfleet.africa',
    portalUrl: 'https://portal.onfleet.africa',
    // The words the emails sign off with. Kept beside the name so a brand is
    // one object rather than a name here and a sign-off three files away.
    emailAccent: '#93c5fd',
    emailHeaderBg: '#1E3A5F',
    emailKicker: 'Fleet Management',
    // The logo route is left alone for OnFleet, so this is the file the
    // frontend already ships and already asks for.
    logo: '/logo.png',
    icon: '/logo.png',
    title: 'OnFleet Africa — Rent to Own. Ride. Earn. Own.',
    description: 'OnFleet Africa — Rent-to-own delivery bikes for South African riders. No deposit. Free monthly servicing. Own in 18 months.',
    fleetTitle: 'OnFleet Africa Fleet Owner Platform — Launch and manage your fleet',
    fleetDescription: 'The OnFleet fleet-owner platform is live. Create a company account, manage bikes and agreements, capture payments, and run daily fleet operations from one workspace.',
    manifest: {
      name: 'OnFleet Africa',
      short_name: 'OnFleet',
      description: 'OnFleet Africa rent-to-own rider and admin workspace.',
    },
  },

  pillion: {
    key: 'pillion',
    name: 'Pillion',
    fullName: 'Pillion',
    themeColor: '#0C4A5A',
    domain: 'portal.pillion.co.za',
    portalUrl: 'https://portal.pillion.co.za',
    emailAccent: '#9BDCEE',
    emailHeaderBg: '#0C4A5A',
    emailKicker: 'Fleet Management',
    // Served by the brand routes out of frontend/public/brand, which Vite
    // copies into dist, so no Dockerfile or build change is involved.
    logo: '/brand/pillion-logo.png',
    icon: '/brand/pillion-icon-512.png',
    icon192: '/brand/pillion-icon-192.png',
    icon180: '/brand/pillion-icon-180.png',
    title: 'Pillion — Fleet management for two-wheeler operators',
    description: 'Where every bike is, what every rider owes, and what the workshop did to it. Tracking, agreements and the workshop in one system, built in South Africa.',
    fleetTitle: 'Pillion — Fleet management for two-wheeler operators',
    fleetDescription: 'Live tracking, no-go zones and immobilisation, rider agreements and weekly collections, job cards and service schedules — one system, priced per bike.',
    manifest: {
      name: 'Pillion',
      short_name: 'Pillion',
      description: 'Pillion — fleet management for two-wheeler operators.',
    },
  },
};

const requested = String(process.env.BRAND || '').trim().toLowerCase();
const brand = BRANDS[requested] || BRANDS.onfleet;

// True when this deployment is running as plain OnFleet, which is every
// deployment that has not deliberately asked for something else.
const isDefault = brand.key === 'onfleet';

if (requested && !BRANDS[requested]) {
  // Worth saying out loud: somebody meant to rebrand this deployment and it
  // is serving OnFleet instead.
  console.warn(`[brand] BRAND="${requested}" is not a brand we have — serving ${brand.fullName}`);
}

/** The manifest a brand serves, built from its own values. */
function manifestFor(b = brand) {
  return {
    ...b.manifest,
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: b.themeColor,
    icons: [
      { src: b.icon192 || b.icon, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: b.icon, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

/**
 * What the frontend is allowed to know about the brand.
 *
 * Inlined into the page rather than fetched, so the first paint already has
 * the right name — a logo that is correct and a sentence beside it that says
 * OnFleet for one frame is worse than either.
 */
function publicBrand(b = brand) {
  return { key: b.key, name: b.name, fullName: b.fullName, portalUrl: b.portalUrl, domain: b.domain };
}

/**
 * The script tag that carries it. Empty for OnFleet, because the default
 * deployment's HTML is not touched at all and the frontend already falls back
 * to these values when the global is absent.
 */
function brandScriptTag() {
  if (isDefault) return '';
  return `<script>window.__BRAND__=${JSON.stringify(publicBrand())
    .replace(/</g, '\\u003c')};</script>`;
}

module.exports = { brand, isDefault, BRANDS, manifestFor, publicBrand, brandScriptTag };

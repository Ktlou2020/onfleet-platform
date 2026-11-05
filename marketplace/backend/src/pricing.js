'use strict';

const VAT_RATE = 0.15;
const RIDER_SPEED_KMH = 25; // urban motorbike average, including stops
const DISPATCH_MINUTES = 4;

const FEES = {
  deliveryBaseCents: 2500, // first 3 km
  deliveryIncludedKm: 3,
  deliveryPerKmCents: 600,
  deliveryMaxCents: 6500,
  freeDeliveryOverCents: 60000,
  serviceFeeRate: 0.05,
  serviceFeeMinCents: 500,
  serviceFeeMaxCents: 2500,
  minimumOrderCents: 10000,
};

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Straight-line distance understates a road route; 1.3 is a common urban
// detour factor and keeps quoted ETAs honest.
function roadKm(a, b) {
  return Math.round(haversineKm(a, b) * 1.3 * 10) / 10;
}

function deliveryFeeCents(km, subtotalCents) {
  if (subtotalCents >= FEES.freeDeliveryOverCents) return 0;
  const extraKm = Math.max(0, km - FEES.deliveryIncludedKm);
  const fee = FEES.deliveryBaseCents + Math.ceil(extraKm) * FEES.deliveryPerKmCents;
  return Math.min(fee, FEES.deliveryMaxCents);
}

function serviceFeeCents(subtotalCents) {
  const fee = Math.round(subtotalCents * FEES.serviceFeeRate);
  return Math.min(Math.max(fee, FEES.serviceFeeMinCents), FEES.serviceFeeMaxCents);
}

function etaMinutes(km, prepMinutes) {
  return Math.round(prepMinutes + DISPATCH_MINUTES + (km / RIDER_SPEED_KMH) * 60);
}

// Prices are VAT-inclusive, as South African consumer law requires; the VAT
// figure is the portion of the total that is tax.
function quote({ subtotalCents, km, prepMinutes }) {
  const delivery = deliveryFeeCents(km, subtotalCents);
  const service = serviceFeeCents(subtotalCents);
  const total = subtotalCents + delivery + service;
  return {
    subtotalCents,
    deliveryFeeCents: delivery,
    serviceFeeCents: service,
    totalCents: total,
    vatCents: Math.round((total * VAT_RATE) / (1 + VAT_RATE)),
    distanceKm: km,
    etaMinutes: etaMinutes(km, prepMinutes),
    minimumOrderCents: FEES.minimumOrderCents,
    belowMinimum: subtotalCents < FEES.minimumOrderCents,
  };
}

module.exports = { FEES, haversineKm, roadKm, deliveryFeeCents, serviceFeeCents, etaMinutes, quote };

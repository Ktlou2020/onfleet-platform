const BIKE_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'not_available', label: 'Not available' },
  { value: 'sold', label: 'Sold' },
  { value: 'paid_off', label: 'Paid off' },
  { value: 'written_off', label: 'Written off' },
  { value: 'stolen', label: 'Stolen' },
  { value: 'repairs', label: 'Repairs' },
  { value: 'ready_to_go', label: 'Ready to go' },
  { value: 'stationary', label: 'Stationary' }
];

const BIKE_STATUS_VALUES = BIKE_STATUS_OPTIONS.map((option) => option.value);
const BIKE_STATUS_LABELS = Object.fromEntries(BIKE_STATUS_OPTIONS.map((option) => [option.value, option.label]));

function normalizeStatusText(value) {
  return String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
}

function getBikeStatusLabel(status) {
  return BIKE_STATUS_LABELS[status] || status || '—';
}

// Whether a bike has an active agreement must be resolved by the caller
// (via utils/bikeStatusPg.js's async bikeHasActiveAgreement) and passed in
// as `hasAllocation` — this function stays synchronous/pure so it can be
// used by CSV-import mapping, which has no DB access of its own.
function inferHasAllocation({ row = null, hasAllocation = null } = {}) {
  if (typeof hasAllocation === 'boolean') return hasAllocation;
  if (row && typeof row === 'object') {
    const riderHint = [row.Driver, row['Allocated Rider'], row['Rider Name'], row['Full Name']]
      .map((value) => String(value || '').trim())
      .find(Boolean);
    return Boolean(riderHint);
  }
  return false;
}

function normalizeBikeStatus(rawStatus, options = {}) {
  const status = normalizeStatusText(rawStatus);
  const hasAllocation = inferHasAllocation(options);

  if (!status) return hasAllocation ? 'active' : 'ready_to_go';
  if (BIKE_STATUS_VALUES.includes(status.replace(/ /g, '_'))) return status.replace(/ /g, '_');
  if (status.includes('paid off') || status.includes('owned by rider') || status.includes('owned')) return 'paid_off';
  if (status === 'sold' || status.includes('cash sale')) return 'sold';
  if (status.includes('stolen') || status.includes('theft')) return 'stolen';
  if (status.includes('written off') || status.includes('write off') || status.includes('retired') || status.includes('scrap')) return 'written_off';
  if (status.includes('repair') || status.includes('maintenance') || status.includes('service')) return 'repairs';
  if (status.includes('not available') || status.includes('unavailable')) return 'not_available';
  if (status.includes('ready to go') || status === 'available' || status.includes('ready')) return 'ready_to_go';
  if (status.includes('stationary')) return 'stationary';
  if (status.includes('active') || status.includes('allocated') || status.includes('handover') || status.includes('assigned')) return hasAllocation ? 'active' : 'ready_to_go';
  return hasAllocation ? 'active' : 'ready_to_go';
}

module.exports = {
  BIKE_STATUS_OPTIONS,
  BIKE_STATUS_VALUES,
  BIKE_STATUS_LABELS,
  getBikeStatusLabel,
  normalizeBikeStatus
};

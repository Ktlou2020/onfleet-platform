const db = require('../db');

const BIKE_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'not_available', label: 'Not available' },
  { value: 'sold', label: 'Sold' },
  { value: 'paid_off', label: 'Paid off' },
  { value: 'written_off', label: 'Written off' },
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

function bikeHasActiveAgreement(bikeId) {
  if (!bikeId) return false;
  return !!db.prepare(`SELECT 1 FROM agreements WHERE bike_id = ? AND status = 'active' LIMIT 1`).get(bikeId);
}

function inferHasAllocation({ bikeId = null, row = null, hasAllocation = null } = {}) {
  if (typeof hasAllocation === 'boolean') return hasAllocation;
  if (bikeId) return bikeHasActiveAgreement(bikeId);
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
  if (status.includes('written off') || status.includes('write off') || status.includes('stolen') || status.includes('retired') || status.includes('scrap')) return 'written_off';
  if (status.includes('repair') || status.includes('maintenance') || status.includes('service')) return 'repairs';
  if (status.includes('not available') || status.includes('unavailable')) return 'not_available';
  if (status.includes('ready to go') || status === 'available' || status.includes('ready')) return 'ready_to_go';
  if (status.includes('stationary')) return 'stationary';
  if (status.includes('active') || status.includes('allocated') || status.includes('handover') || status.includes('assigned')) return hasAllocation ? 'active' : 'ready_to_go';
  return hasAllocation ? 'active' : 'ready_to_go';
}

function pauseActiveBikeAgreements(bikeId) {
  const result = db.prepare(`UPDATE agreements SET status = 'paused' WHERE bike_id = ? AND status = 'active'`).run(bikeId);
  return result.changes || 0;
}

function setBikeStatus(bikeId, requestedStatus) {
  const bike = db.prepare(`SELECT id, status FROM bikes WHERE id = ?`).get(bikeId);
  if (!bike) throw new Error('Bike not found');

  const hasActiveAgreement = bikeHasActiveAgreement(bikeId);
  const nextStatus = normalizeBikeStatus(requestedStatus, { bikeId, hasAllocation: hasActiveAgreement });
  if (nextStatus === 'active' && !hasActiveAgreement) {
    throw new Error('Active status requires a current active agreement');
  }

  let pausedAgreements = 0;
  if (nextStatus === 'repairs') {
    pausedAgreements = pauseActiveBikeAgreements(bikeId);
  }

  db.prepare(`UPDATE bikes SET status = ? WHERE id = ?`).run(nextStatus, bikeId);

  return {
    previous_status: bike.status,
    next_status: nextStatus,
    paused_agreements: pausedAgreements,
    had_active_agreement: hasActiveAgreement
  };
}

module.exports = {
  BIKE_STATUS_OPTIONS,
  BIKE_STATUS_VALUES,
  BIKE_STATUS_LABELS,
  getBikeStatusLabel,
  normalizeBikeStatus,
  bikeHasActiveAgreement,
  pauseActiveBikeAgreements,
  setBikeStatus
};

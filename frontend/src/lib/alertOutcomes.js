// Mirrors backend/src/constants/alertOutcomes.js — keep the ids in step.
export const ALERT_OUTCOMES = [
  { id: 'false_alarm',      label: 'False alarm',         real: false, hint: 'Nothing happened — the alert was wrong' },
  { id: 'authorised',       label: 'Authorised use',      real: false, hint: 'The rider or workshop was meant to be doing this' },
  { id: 'rider_contacted',  label: 'Rider contacted',     real: true,  hint: 'Spoke to the rider and the bike is safe' },
  { id: 'bike_recovered',   label: 'Bike recovered',      real: true,  hint: 'The bike was taken and has been recovered' },
  { id: 'police_escalated', label: 'Escalated to police', real: true,  hint: 'Handed to police or the recovery company' },
  { id: 'device_fault',     label: 'Tracker fault',       real: false, hint: 'The tracker, not the bike, is the problem' },
  { id: 'other',            label: 'Other',               real: true,  hint: 'Something else — please add a note' },
];

export const outcomeLabel = (id) => ALERT_OUTCOMES.find((o) => o.id === id)?.label || id || null;

export const OUTCOME_COLORS = {
  false_alarm: '#94a3b8', authorised: '#94a3b8', device_fault: '#b45309',
  rider_contacted: '#1d4ed8', bike_recovered: '#15803d', police_escalated: '#b91c1c', other: '#6b7280',
};

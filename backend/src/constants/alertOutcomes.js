'use strict';

/**
 * Why an alert was closed. Closing used to demand a typed comment, so in the
 * last 30 days not one of 1,169 alerts was closed and the fleet had no record
 * of which alerts were real. One tap on an outcome is enough; the comment is
 * optional and adds detail.
 *
 * `real` marks the outcomes that represent a genuine event, which is what the
 * noise ratio and the theft-recovery rate are measured from.
 */
const ALERT_OUTCOMES = [
  { id: 'false_alarm',      label: 'False alarm',          real: false, hint: 'Nothing happened — the alert was wrong' },
  { id: 'authorised',       label: 'Authorised use',       real: false, hint: 'The rider or workshop was meant to be doing this' },
  { id: 'rider_contacted',  label: 'Rider contacted',      real: true,  hint: 'Spoke to the rider and the bike is safe' },
  { id: 'bike_recovered',   label: 'Bike recovered',       real: true,  hint: 'The bike was taken and has been recovered' },
  { id: 'police_escalated', label: 'Escalated to police',  real: true,  hint: 'Handed to police or the recovery company' },
  { id: 'device_fault',     label: 'Tracker fault',        real: false, hint: 'The tracker, not the bike, is the problem' },
  { id: 'other',            label: 'Other',                real: true,  hint: 'Something else — please add a note' },
];

const ALERT_OUTCOME_IDS = ALERT_OUTCOMES.map((o) => o.id);
const REAL_OUTCOME_IDS = ALERT_OUTCOMES.filter((o) => o.real).map((o) => o.id);
const outcomeLabel = (id) => ALERT_OUTCOMES.find((o) => o.id === id)?.label || id || null;

module.exports = { ALERT_OUTCOMES, ALERT_OUTCOME_IDS, REAL_OUTCOME_IDS, outcomeLabel };

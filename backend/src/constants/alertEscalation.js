'use strict';

// How a critical alert is chased until someone acknowledges it: minutes after
// the alert at which each round fires. Shared so the webhook payload and the
// escalation service can't drift apart about how many rounds there are.
const ROUNDS_AT_MINUTES = [5, 15, 30, 60];
const MAX_ROUNDS = ROUNDS_AT_MINUTES.length;
const WEBHOOK_FROM_ROUND = 2;

module.exports = { ROUNDS_AT_MINUTES, MAX_ROUNDS, WEBHOOK_FROM_ROUND };

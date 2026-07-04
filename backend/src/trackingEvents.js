'use strict';

const { EventEmitter } = require('events');
const trackingEvents = new EventEmitter();
trackingEvents.setMaxListeners(200);
module.exports = trackingEvents;

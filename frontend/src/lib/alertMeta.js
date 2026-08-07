export const ALERT_LABELS = {
  geofence_enter:   'Entered geofence',
  geofence_exit:    'Left geofence',
  harsh_brake:      'Harsh braking',
  harsh_accel:      'Harsh acceleration',
  harsh_cornering:  'Harsh cornering',
  idle:             'Extended idle',
  speeding:         'Speeding',
  panic:            'Panic / SOS',
  power_disconnect: 'Power disconnected',
  low_battery:      'Low battery',
  movement:         'Unauthorized movement',
  tamper:           'GPS tamper',
  device_offline:   'Device offline',
  engine_cut_auto:  'Engine cut (auto)',
  theft_risk:       'AI theft/anomaly risk',
  long_trip:        'Unusually long trip',
  bike_dormant:     'Bike inactive for days',
  night_movement:   'Movement during high-theft hours (00:00–04:00)',
  towing:           'Possible towing (ignition off, sustained movement)',
};

export const ALERT_COLORS = {
  geofence_enter:   '#22c55e',
  geofence_exit:    '#f97316',
  harsh_brake:      '#ef4444',
  harsh_accel:      '#f97316',
  harsh_cornering:  '#eab308',
  idle:             '#94a3b8',
  speeding:         '#ef4444',
  panic:            '#dc2626',
  power_disconnect: '#dc2626',
  low_battery:      '#f97316',
  movement:         '#dc2626',
  tamper:           '#dc2626',
  device_offline:   '#94a3b8',
  engine_cut_auto:  '#7c3aed',
  theft_risk:       '#7c3aed',
  long_trip:        '#eab308',
  bike_dormant:     '#94a3b8',
  night_movement:   '#dc2626',
  towing:           '#dc2626',
};

export const ALERT_SEVERITY = {
  panic: 'critical', tamper: 'critical', power_disconnect: 'critical', movement: 'critical', theft_risk: 'critical', night_movement: 'critical', towing: 'critical',
  speeding: 'high', harsh_brake: 'high', geofence_exit: 'high',
  harsh_accel: 'medium', harsh_cornering: 'medium', geofence_enter: 'medium', low_battery: 'medium', long_trip: 'medium',
  idle: 'low', device_offline: 'low', engine_cut_auto: 'high', bike_dormant: 'low',
};

export const ALERT_FILTER_GROUPS = [
  { id: '',         label: 'All' },
  { id: 'critical', label: 'Critical', types: ['panic','tamper','power_disconnect','movement','theft_risk','night_movement','towing'] },
  { id: 'driving',  label: 'Driving',  types: ['speeding','harsh_brake','harsh_accel','harsh_cornering','idle','long_trip'] },
  { id: 'location', label: 'Location', types: ['geofence_enter','geofence_exit','engine_cut_auto'] },
  { id: 'vehicle',  label: 'Vehicle',  types: ['low_battery','device_offline','bike_dormant'] },
];

export const CRITICAL_ALERT_TYPES = new Set(['panic','tamper','power_disconnect','movement','theft_risk','night_movement','towing']);

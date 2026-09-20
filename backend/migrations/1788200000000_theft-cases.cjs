'use strict';

/**
 * A theft is a case, not an alert. Today a tamper or towing alert lands in the
 * control room and whatever happens next — the phone calls, the engine cut, the
 * police reference, whether the bike came back — lives in somebody's head. 85
 * bikes are marked stolen and the platform cannot say how many were recovered.
 *
 * A case is opened automatically by the alerts that suggest a bike is being
 * taken, gathers everything that happens to that bike while it is open, and is
 * closed with an outcome. Recovery rate becomes a number.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS theft_cases (
      id SERIAL PRIMARY KEY,
      bike_id INTEGER NOT NULL REFERENCES bikes(id) ON DELETE CASCADE,
      device_id INTEGER REFERENCES tracking_devices(id) ON DELETE SET NULL,
      trigger_alert_id INTEGER REFERENCES tracking_alerts(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'with_police', 'recovered', 'false_alarm', 'written_off')),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      opened_by INTEGER REFERENCES users(id),
      opened_reason TEXT,
      follow_until TIMESTAMPTZ,
      police_reference TEXT,
      closed_at TIMESTAMPTZ,
      closed_by INTEGER REFERENCES users(id),
      closing_note TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // One open case per bike: a burst of tamper alerts is one theft, not six.
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_theft_cases_one_open_per_bike
             ON theft_cases(bike_id) WHERE status = 'open';`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_theft_cases_status ON theft_cases(status, opened_at DESC);`);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS theft_case_events (
      id SERIAL PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES theft_cases(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail JSONB,
      actor_id INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_theft_case_events_case ON theft_case_events(case_id, created_at);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS theft_case_events;`);
  pgm.sql(`DROP TABLE IF EXISTS theft_cases;`);
};

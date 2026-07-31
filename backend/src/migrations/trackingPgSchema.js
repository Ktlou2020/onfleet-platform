'use strict';

const pgDb = require('../pgDb');

async function runTrackingSchema() {
  if (!process.env.DATABASE_URL) return;
  try {
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS tracking_devices (
        id            SERIAL PRIMARY KEY,
        imei          TEXT UNIQUE NOT NULL,
        model         TEXT DEFAULT 'other',
        bike_id       INTEGER,
        label         TEXT,
        firmware_version TEXT,
        connected     BOOLEAN DEFAULT FALSE,
        last_seen_at  TIMESTAMPTZ,
        speed_limit_kmh INTEGER DEFAULT 120,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS gps_pings (
        id          BIGSERIAL PRIMARY KEY,
        bike_id     INTEGER NOT NULL,
        lat         DOUBLE PRECISION NOT NULL,
        lng         DOUBLE PRECISION NOT NULL,
        speed_kmh   REAL,
        heading     REAL,
        recorded_at TIMESTAMPTZ DEFAULT NOW(),
        satellites  INTEGER,
        altitude    INTEGER,
        ignition    INTEGER,
        io_data     TEXT
      )
    `);
    await pgDb.query(`
      CREATE INDEX IF NOT EXISTS idx_gps_pings_bike_time ON gps_pings(bike_id, recorded_at DESC)
    `);
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS tracking_commands (
        id            SERIAL PRIMARY KEY,
        device_id     INTEGER REFERENCES tracking_devices(id) ON DELETE CASCADE,
        command       TEXT NOT NULL,
        status        TEXT DEFAULT 'pending',
        response      TEXT,
        created_by    INTEGER,
        sent_at       TIMESTAMPTZ,
        responded_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS geofences (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        lat        DOUBLE PRECISION NOT NULL,
        lng        DOUBLE PRECISION NOT NULL,
        radius_m   INTEGER DEFAULT 500,
        bike_id    INTEGER,
        active     BOOLEAN DEFAULT TRUE,
        created_by INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS geofence_states (
        bike_id     INTEGER NOT NULL,
        geofence_id INTEGER NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
        inside      BOOLEAN DEFAULT FALSE,
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (bike_id, geofence_id)
      )
    `);
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS trips (
        id           SERIAL PRIMARY KEY,
        bike_id      INTEGER NOT NULL,
        device_id    INTEGER,
        started_at   TIMESTAMPTZ,
        ended_at     TIMESTAMPTZ,
        start_lat    DOUBLE PRECISION,
        start_lng    DOUBLE PRECISION,
        end_lat      DOUBLE PRECISION,
        end_lng      DOUBLE PRECISION,
        distance_km  REAL,
        duration_sec INTEGER,
        max_speed_kmh REAL,
        avg_speed_kmh REAL,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS tracking_alerts (
        id              SERIAL PRIMARY KEY,
        bike_id         INTEGER,
        device_id       INTEGER,
        alert_type      TEXT NOT NULL,
        payload         TEXT,
        acknowledged_at TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgDb.query(`
      CREATE INDEX IF NOT EXISTS idx_tracking_alerts_bike_time ON tracking_alerts(bike_id, created_at DESC)
    `);
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS alert_settings (
        alert_type          TEXT PRIMARY KEY,
        enabled             BOOLEAN DEFAULT TRUE,
        notify_enabled      BOOLEAN DEFAULT TRUE,
        recipient_user_ids  TEXT DEFAULT '[]',
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgDb.query(`
      CREATE TABLE IF NOT EXISTS device_alert_settings (
        device_id           INTEGER NOT NULL REFERENCES tracking_devices(id) ON DELETE CASCADE,
        alert_type          TEXT NOT NULL,
        enabled             BOOLEAN DEFAULT TRUE,
        notify_enabled      BOOLEAN DEFAULT TRUE,
        recipient_user_ids  TEXT DEFAULT '[]',
        updated_at          TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (device_id, alert_type)
      )
    `);
    console.log('[pgDb] Tracking schema ready');
  } catch (err) {
    console.error('[pgDb] Schema migration failed:', err.message);
  }
}

module.exports = { runTrackingSchema };

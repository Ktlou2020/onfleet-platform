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
    // Add zone_type, color, and polygon_coords columns to geofences (idempotent)
    await pgDb.query(`ALTER TABLE geofences ADD COLUMN IF NOT EXISTS zone_type TEXT DEFAULT 'standard'`);
    await pgDb.query(`ALTER TABLE geofences ADD COLUMN IF NOT EXISTS color TEXT`);
    await pgDb.query(`ALTER TABLE geofences ADD COLUMN IF NOT EXISTS polygon_coords JSONB`);

    // Seed the known no-go (theft/stripping) zones — skip any that already exist by name+type
    const noGoZones = [
      { name: 'Cleveland - Theft Zone',    lat: -26.2042, lng: 28.1192, radius_m:  150 },
      { name: 'Cosmo City 1',              lat: -26.0359, lng: 27.9320, radius_m:  620 },
      { name: 'Cosmo City 2',              lat: -26.0307, lng: 27.9169, radius_m:  415 },
      { name: 'Cosmo 3',                   lat: -26.0137, lng: 27.9314, radius_m:  410 },
      { name: 'Mogale City Strip Zone',    lat: -26.1339, lng: 27.8101, radius_m:  880 },
      { name: 'Mooiplaas - Stripping Area',lat: -25.8520, lng: 28.0913, radius_m:  405 },
      { name: 'Oliven',                    lat: -25.9111, lng: 28.0770, radius_m:  860 },
      { name: 'Witpoortjie',               lat: -26.1608, lng: 27.8357, radius_m:  210 },
      { name: 'Zanspriut',                 lat: -26.0607, lng: 27.9147, radius_m:  465 },
    ];
    for (const z of noGoZones) {
      await pgDb.query(
        `INSERT INTO geofences (name, lat, lng, radius_m, zone_type, color, active)
         SELECT $1,$2,$3,$4,'danger','#E53935',TRUE
         WHERE NOT EXISTS (SELECT 1 FROM geofences WHERE name=$1 AND zone_type='danger')`,
        [z.name, z.lat, z.lng, z.radius_m]
      );
    }

    console.log('[pgDb] Tracking schema ready');
  } catch (err) {
    console.error('[pgDb] Schema migration failed:', err.message);
  }
}

module.exports = { runTrackingSchema };

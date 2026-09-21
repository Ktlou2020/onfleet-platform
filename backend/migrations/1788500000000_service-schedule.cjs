'use strict';

/**
 * The manufacturer's service schedule, so a job card can say what this bike
 * needs at the kilometres on its clock instead of relying on the technician
 * remembering a chart pinned to a wall.
 *
 * Two halves, because the manufacturer publishes two:
 *  - the maintenance chart (PDF): what to inspect, clean, adjust, lubricate or
 *    replace at each of the 11 services, 500 km to 30 500 km and repeating;
 *  - the 36-month schedule (spreadsheet): which part number to fit at which
 *    kilometre reading, which is what turns a service into a parts order.
 *
 * Seeded here for the Hero Eco 150 (178 bikes on the platform, the largest
 * single model) from the files in backend/assets. Other models are added the
 * same way, or by uploading their schedule in the admin portal.
 */

const path = require('path');

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS service_schedules (
      id SERIAL PRIMARY KEY,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      service_no INTEGER NOT NULL,
      km_from INTEGER NOT NULL,
      km_to INTEGER NOT NULL,
      UNIQUE (make, model, service_no)
    );

    CREATE TABLE IF NOT EXISTS service_schedule_tasks (
      id SERIAL PRIMARY KEY,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      item TEXT NOT NULL,
      service_no INTEGER NOT NULL,
      actions TEXT NOT NULL,
      note TEXT,
      UNIQUE (make, model, item, service_no)
    );

    CREATE TABLE IF NOT EXISTS service_schedule_parts (
      id SERIAL PRIMARY KEY,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      description TEXT NOT NULL,
      part_number TEXT NOT NULL,
      at_km INTEGER[] NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      source TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (make, model, part_number, description)
    );

    CREATE INDEX IF NOT EXISTS idx_service_schedule_tasks_model ON service_schedule_tasks(make, model, service_no);
    CREATE INDEX IF NOT EXISTS idx_service_schedule_parts_model ON service_schedule_parts(make, model);
  `);

  const chart = require(path.join(__dirname, '..', 'assets', 'service-chart-hero-eco-150.json'));
  const parts = require(path.join(__dirname, '..', 'assets', 'service-parts-hero-eco-150.json'));
  const quote = (value) => (value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`);

  for (const service of chart.services) {
    pgm.sql(`INSERT INTO service_schedules (make, model, service_no, km_from, km_to)
             VALUES (${quote(chart.make)}, ${quote(chart.model)}, ${service.service_no}, ${service.km_from}, ${service.km_to})
             ON CONFLICT (make, model, service_no) DO NOTHING;`);
  }

  for (const item of chart.items) {
    for (const [serviceNo, actions] of Object.entries(item.actions || {})) {
      pgm.sql(`INSERT INTO service_schedule_tasks (make, model, item, service_no, actions, note)
               VALUES (${quote(chart.make)}, ${quote(chart.model)}, ${quote(item.item)}, ${Number(serviceNo)}, ${quote(actions)}, ${quote(item.note)})
               ON CONFLICT (make, model, item, service_no) DO UPDATE SET actions = EXCLUDED.actions, note = EXCLUDED.note;`);
    }
  }

  for (const item of parts.items) {
    pgm.sql(`INSERT INTO service_schedule_parts (make, model, description, part_number, at_km, qty, source)
             VALUES (${quote(parts.make)}, ${quote(parts.model)}, ${quote(item.description)}, ${quote(item.part_number)},
                     ARRAY[${item.at_km.join(',')}]::INTEGER[], ${item.qty_per_service || 1}, ${quote(parts.source)})
             ON CONFLICT (make, model, part_number, description)
             DO UPDATE SET at_km = EXCLUDED.at_km, qty = EXCLUDED.qty, updated_at = NOW();`);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS service_schedule_parts;`);
  pgm.sql(`DROP TABLE IF EXISTS service_schedule_tasks;`);
  pgm.sql(`DROP TABLE IF EXISTS service_schedules;`);
};

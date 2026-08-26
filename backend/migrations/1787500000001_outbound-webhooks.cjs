'use strict';

/**
 * Outbound webhooks — the platform had none. The only webhook in the codebase
 * was the *inbound* Paystack one; tracking alerts went to our own UI over an
 * internal SSE stream and nowhere else. An outsourced control room needs the
 * events pushed to their endpoint.
 *
 * Two tables:
 *
 *   webhook_endpoints  — who wants events, where, and which ones. `secret` signs
 *                        the payload so the receiver can verify it came from us.
 *   webhook_deliveries — one row per (event, endpoint) attempt-set. Persisted
 *                        rather than held in memory so a delivery survives a
 *                        restart mid-retry, and so failures are auditable
 *                        instead of vanishing into a log line.
 *
 * `event_types` NULL means "everything" — a control room typically wants the
 * full stream, and an explicit list would silently drop any alert type added
 * later.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      url             TEXT NOT NULL,
      secret          TEXT NOT NULL,
      scope           TEXT NOT NULL DEFAULT 'platform',
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      event_types     TEXT,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_by      INTEGER REFERENCES users(id),
      last_success_at TIMESTAMPTZ,
      last_failure_at TIMESTAMPTZ,
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT webhook_endpoints_scope_check CHECK (
        (scope = 'organization' AND organization_id IS NOT NULL)
        OR (scope = 'platform' AND organization_id IS NULL)
      )
    );
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id              SERIAL PRIMARY KEY,
      endpoint_id     INTEGER NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_type      TEXT NOT NULL,
      event_id        TEXT NOT NULL,
      payload         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      response_code   INTEGER,
      last_error      TEXT,
      delivered_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('pending','delivered','failed'))
    );
  `);

  // The retry sweep polls for due work; this is the index it rides on.
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
             ON webhook_deliveries (status, next_attempt_at) WHERE status = 'pending';`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
             ON webhook_deliveries (endpoint_id, created_at DESC);`);
  // Same event never queues twice for the same endpoint, so a replayed or
  // double-emitted alert can't turn into two deliveries.
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_idempotent
             ON webhook_deliveries (endpoint_id, event_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS webhook_deliveries;`);
  pgm.sql(`DROP TABLE IF EXISTS webhook_endpoints;`);
};

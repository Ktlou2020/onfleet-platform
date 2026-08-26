# OnFleet Africa — Integration API

Reference for third-party systems integrating with the OnFleet platform (fleet
management, control rooms, monitoring providers).

Base URL: `https://portal.onfleet.africa/api/v1`

---

## 1. Authentication

**Token, not username/password.** Every request carries a bearer API key:

```
Authorization: Bearer onfleet_plat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- Keys are issued by OnFleet and shown **once** at creation — only a SHA-256 hash is stored, so a lost key must be replaced, not recovered.
- Keys can be revoked individually and take effect immediately.
- There is no login, session, or token-refresh step. The key is the credential.

### Key scopes

| Scope | Sees |
|---|---|
| `platform` | Every vehicle, group, rider and alarm across all fleet owners **and** platform-owned stock |
| `organization` | Only the vehicles belonging to one fleet owner |

A control room monitoring the whole estate needs a **platform** key. Endpoints
marked *platform-only* below return `403` for an organization key.

### Errors

| Status | Meaning |
|---|---|
| `401` | Missing, invalid, or revoked key |
| `403` | Key scope insufficient for this endpoint |
| `400` | Malformed parameter (message explains which) |
| `429` | Rate limited |

**Rate limit:** 300 requests per 15 minutes. A 30-minute sync cycle is well
within this.

---

## 2. Endpoints

### `GET /vehicles` — vehicle sync

One row per vehicle, carrying its group, tracker, last known position, and the
rider currently responsible for it **with their contact details**. This is the
endpoint to poll for a periodic sync; no joining across other endpoints needed.

```json
{
  "count": 2,
  "synced_at": "2026-08-26T10:29:45.346Z",
  "vehicles": [
    {
      "id": 2,
      "registration": "REG46",
      "vin": "VIN46TEST",
      "make": "TestMake",
      "model": "TestModel",
      "year": 2024,
      "color": "Red",
      "engine_cc": 150,
      "status": "active",
      "odometer_km": "0.00",
      "next_service_date": "2026-09-01",
      "insurance_expiry": "2027-01-31",
      "license_disc_expiry": "2027-03-31",
      "created_at": "2026-08-17T09:23:58.910Z",
      "last_known_position": { "lat": -26.2041, "lng": 28.0473, "at": "2026-08-26T10:28:58.479Z" },
      "group": { "id": 1, "name": "Johannesburg Hub", "city": "Johannesburg" },
      "fleet_label": null,
      "owner": { "type": "platform", "id": null, "name": null },
      "tracker": { "imei": "111222333444555", "model": "FMB920" },
      "driver": {
        "id": 2,
        "name": "Test User 48",
        "phone": "+27821234567",
        "email": "rider@example.test",
        "agreement_id": 1,
        "agreement_no": "OF-TEST-47",
        "agreement_status": "active"
      }
    }
  ]
}
```

Notes:
- `driver` is `null` for unallocated stock — the vehicle exists but nobody is currently responsible for it.
- `group` is `null` if the vehicle is not assigned to a hub. `fleet_label` is a free-text tag used by some vehicles instead.
- `owner.type` is `platform` or `fleet_owner`. Organization keys only ever see `fleet_owner` vehicles belonging to them.
- `tracker` is `null` if no GPS device is fitted.

**Vehicle `status` values:** `ready_to_go`, `active`, `stationary`, `repairs`,
`not_available`, `stolen`, `written_off`, `sold`, `paid_off`.

### `GET /groups` — vehicle groups

Groups are hubs (depots/branches). `vehicle_count` is the number of vehicles
currently assigned.

```json
{
  "count": 1,
  "groups": [
    {
      "id": 1,
      "name": "Johannesburg Hub",
      "address": "12 Main Rd",
      "city": "Johannesburg",
      "contact_name": "Hub Manager",
      "contact_phone": "+27115550100",
      "organization_id": 1,
      "organization_name": "Test Org 43",
      "vehicle_count": 1
    }
  ]
}
```

### `GET /event-types` — alarm catalogue

Every alarm identifier the platform can emit, with its severity. Use this to
build your event mapping up front rather than discovering names by observation.

```json
{ "count": 20, "event_types": [ { "type": "panic", "severity": "critical" } ] }
```

### `GET /alerts` — alarm history *(platform-only)*

Pull alarms that have already been raised. Complements the webhook: use it to
backfill after downtime, or to reconcile what you received against what we sent.

| Parameter | Description |
|---|---|
| `since` | ISO 8601 timestamp; only alarms at or after this time |
| `event_type` | Restrict to one alarm type |
| `limit` | Max rows, default 100, cap 500 |

```json
{
  "count": 1,
  "alerts": [
    {
      "id": 9,
      "event_type": "panic",
      "severity": "critical",
      "occurred_at": "2026-08-26T10:29:23.308Z",
      "acknowledged_at": null,
      "resolved_at": null,
      "vehicle": { "id": 2, "registration": "REG46", "make": "TestMake", "model": "TestModel" },
      "driver": { "name": "Test User 48", "phone": "+27821234567" },
      "detail": { "lat": -26.2041, "lng": 28.0473 }
    }
  ]
}
```

### Also available

`GET /bikes`, `GET /agreements`, `GET /riders` — earlier, narrower endpoints
retained for existing integrations. `/vehicles` supersedes `/bikes`.

---

## 3. Webhooks — alarm push

The platform POSTs every tracking alarm to your endpoint as it occurs.

### Registration

OnFleet registers your endpoint and returns a **signing secret**, shown once.
Requirements:

- **HTTPS only.** Payloads carry rider names and phone numbers.
- Respond **2xx** promptly. Anything else is treated as a failure and retried.
- By default you receive **all** event types; a subset can be pinned on request. Leaving it open means alarm types added later reach you automatically.

### Request

```
POST https://your-system.example/webhooks/onfleet
Content-Type: application/json
User-Agent: OnFleet-Webhooks/1
X-OnFleet-Event: panic
X-OnFleet-Event-Id: alert-9
X-OnFleet-Delivery: 42
X-OnFleet-Signature: sha256=<hmac>
```

```json
{
  "event_id": "alert-9",
  "event_type": "panic",
  "severity": "critical",
  "occurred_at": "2026-08-26T10:29:23.308Z",
  "sent_at": "2026-08-26T10:29:23.316Z",
  "vehicle": {
    "id": 2,
    "registration": "REG46",
    "make": "TestMake",
    "model": "TestModel",
    "group": { "id": 1, "name": "Johannesburg Hub" },
    "last_known_position": { "lat": -26.2041, "lng": 28.0473, "at": "2026-08-26T10:28:58.479Z" }
  },
  "driver": { "id": 2, "name": "Test User 48", "phone": "+27821234567", "agreement_no": "OF-TEST-47" },
  "detail": { "lat": -26.2041, "lng": 28.0473 }
}
```

`detail` varies by event type — it carries the specifics of that alarm (speed
and limit for `speeding`, zone name for geofence events, battery millivolts for
`low_battery`, risk score and reasons for `theft_risk`, and so on).

### Verifying the signature

HMAC-SHA256 over the **exact raw request body**, keyed on your signing secret,
hex-encoded, prefixed `sha256=`. Compute it on the raw bytes before any JSON
parsing or re-serialisation.

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-onfleet-signature']));
```

```python
expected = 'sha256=' + hmac.new(SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected, request.headers['X-OnFleet-Signature'])
```

Reject any request that fails verification.

### Retries and idempotency

- Failed deliveries retry with backoff at roughly **1m, 5m, 15m, 1h, 6h** — six attempts over about six hours. An endpoint offline for a few hours receives the backlog once it returns.
- **`event_id` is stable across retries.** Deduplicate on it; the same alarm is never queued twice for the same endpoint, but a retry may arrive after your system already processed an earlier attempt whose response was lost.
- Request timeout is 10 seconds. Acknowledge quickly and process asynchronously.

### Test events

OnFleet can send a specimen event on demand so you can validate reachability and
your signature check before a real alarm occurs. It is identical in shape but
carries `"event_type": "test"` and `registration: "TEST-123"` — ignore or
discard these in production handling.

---

## 4. Alarm reference

| Event type | Severity | Meaning |
|---|---|---|
| `panic` | critical | Panic/SOS button pressed |
| `tamper` | critical | GPS unit tampered with |
| `power_disconnect` | critical | External power disconnected |
| `movement` | critical | Movement with ignition off |
| `theft_risk` | critical | Behavioural anomaly score breach |
| `night_movement` | critical | Movement 00:00–04:00 |
| `towing` | critical | Sustained movement, ignition off |
| `engine_cut_auto` | critical | Engine cut automatically on no-go zone entry |
| `speeding` | high | Over the configured speed limit |
| `harsh_brake` | high | Harsh braking |
| `geofence_exit` | high | Left a geofence |
| `harsh_accel` | medium | Harsh acceleration |
| `harsh_cornering` | medium | Harsh cornering |
| `geofence_enter` | medium | Entered a geofence |
| `low_battery` | medium | Tracker battery low |
| `long_trip` | medium | Trip exceeding 4 hours |
| `battery_declining` | medium | Tracker battery degrading over days |
| `idle` | low | Extended idle |
| `device_offline` | low | Tracker stopped reporting |
| `bike_dormant` | low | No trips for several days |

Severities are advisory: they reflect how OnFleet triages internally and are
provided so an integrator can prioritise without hard-coding a list.

---

## 5. Suggested integration shape

1. **Initial load** — `GET /vehicles` and `GET /groups`; store vehicles by `id` (stable) and keep `registration` for display.
2. **Periodic sync** — repeat `GET /vehicles` on your normal cycle (30 minutes is fine). Treat it as the full current state: vehicles absent from the response are no longer in scope, `driver` changes as bikes are reallocated.
3. **Alarms** — receive by webhook. Verify the signature, dedupe on `event_id`, act on `event_type` + `severity`, and use `driver.phone` to reach the rider.
4. **Recovery** — after any downtime, `GET /alerts?since=<last event you processed>` to close the gap. Retries also cover this, but the pull is authoritative.

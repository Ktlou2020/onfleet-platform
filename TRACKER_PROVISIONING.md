# OnFleet Africa — GPS Tracker Provisioning Runbook

How to bring a new Teltonika tracker online, and how to diagnose one that isn't
reporting. Written after IMEI `353201351782245` sat registered but silently
never connected — the device pointed at the wrong server address, which this
doc exists to prevent happening again.

## The most important fact in this document

Physical trackers do **not** connect to `portal.onfleet.africa`. That domain
serves the HTTPS admin console and API on port 4000. Trackers speak a raw TCP
protocol (Teltonika Codec 8) to a completely different address — Railway's TCP
proxy for the tracking service.

**Do not read the address off this page.** The platform reports it live, from
its own configuration, at **GPS Tracking → Guide → "A tracker that never
connects"** — or `GET /api/tracking/endpoint` for staff. That page is right by
construction; a document is only right until something moves.

### Why there is a hostname of our own

Railway's TCP proxy host is not guaranteed permanent, and a tracker pointed at
a host that has moved cannot be fixed from here — it needs an SMS to its SIM or
a cable at the bike. With hundreds of devices that is not a recovery, it is an
outage with a van involved.

So devices are given **a hostname we own**, pointed at Railway's proxy by a
CNAME. If the proxy moves, the CNAME follows it and every tracker in the field
keeps working without anybody touching a bike.

| Setting  | Value |
|----------|-------|
| Domain   | `gps.onfleet.africa` (CNAME → Railway's proxy host) |
| Port     | whatever `GET /api/tracking/endpoint` reports |
| Protocol | TCP |

The DNS record that makes this work, at the `onfleet.africa` nameservers
(ns.otherdns.net / ns.dns1.co.za):

```
gps.onfleet.africa.   CNAME   hayabusa.proxy.rlwy.net.
```

If using Cloudflare, the record must be DNS-only (grey cloud) — a proxied
record breaks raw TCP.

### The half a CNAME cannot fix

Railway sets the proxy **port**, and a custom domain does not change it. If
Railway ever reassigns the port, DNS cannot save the devices already in the
field: they would all need an SMS `setparam`.

The platform watches for this. When `TRACKER_PUBLIC_HOST` is set and the port
it advertises no longer matches `RAILWAY_TCP_PROXY_PORT`, the guide shows the
mismatch in red. Treat that as an incident, not a warning.

Two things follow from that:

- **Never delete and recreate the TCP proxy.** A new proxy means a new port,
  and every tracker goes dark at once.
- If this platform is ever sold to somebody else to run, a fixed port of our
  own — a small TCP forwarder in front of Railway — stops being a nicety.

### Configuration

| Variable | Meaning |
|----------|---------|
| `TRACKER_PUBLIC_HOST` | The hostname devices are given. Set once the CNAME resolves. |
| `TRACKER_PUBLIC_PORT` | The port devices are given. Matches Railway's proxy port. |

With neither set, the platform reports Railway's own proxy values and says so —
correct, but it is the provider's address and it can move.

(`TELTONIKA_TCP_PORT` / `RAILWAY_TCP_APPLICATION_PORT`, currently `50150`, is
the port the app listens on *inside* Railway's network — never give this one to
a physical device. The endpoint API will never report it.)

## 1. Register the device in the admin console first

Before touching the physical tracker: **GPS Tracking → Devices → Add**, enter
the IMEI, model, and the bike to link it to. This creates the `tracking_devices`
row the TCP server needs to recognize the device once it connects — a tracker
dialing in with an unregistered IMEI will connect at the TCP level but won't
be attributed to a bike.

## 2. Configure the physical tracker

Using Teltonika Configurator (USB) or an SMS config command, set on the
**GPRS** / **Server Settings** tab:

- **APN**: the SIM's own data APN (from the SIM provider — this is unrelated
  to OnFleet and varies by network; a SIM with no active data plan or the
  wrong APN will never reach any server, and looks identical from our side to
  a wrong server address — rule this out early, see Troubleshooting)
- **Domain/IP**: the host from `GET /api/tracking/endpoint` (`gps.onfleet.africa`)
- **Port**: the port from that same response
- **Protocol**: TCP
- **Data Sending**: enabled, with a reasonable send period (the app's default
  active/sleeping thresholds assume pings at least every few minutes — an
  overly long send interval will make a genuinely-online bike look offline in
  the admin console)

## 3. Verify it's actually reporting

1. **Admin console** — GPS Tracking → Devices. The device should show
   **Online** with a recent "Last seen" time within a few minutes of power-on.
2. **Database** — `tracking_devices.connected` should be `true` and
   `last_seen_at` populated:
   ```sql
   SELECT imei, connected, last_seen_at FROM tracking_devices WHERE imei = '<imei>';
   ```
3. **Server logs** — a successful first connection logs the IMEI:
   ```bash
   railway logs --service onfleet-platform --environment production | grep '<imei>'
   # expect: [Teltonika] + <imei> (<model>)
   ```

## Remote recovery: SMS `setparam` when the device isn't reachable

If the tracker is already out in the field (on a bike, not on your desk) and
FOTA doesn't seem to have taken effect, don't wait on FOTA or go retrieve the
device — push the server settings directly over SMS instead. This is faster,
doesn't depend on Teltonika's FOTA WEB service actually delivering, and you
can confirm within a minute or two whether it worked.

This happened for real with IMEI `353201351782245`: a FOTA config push had
been sent with the correct settings (confirmed by decoding the exported
`.cfg` — see below), but the device never once reached our server, even
after 21+ hours of the SIM having a live, working data connection. The FOTA
push had evidently never actually applied. An SMS `setparam` command fixed it
in under a minute.

**1. Send the command**, to the SIM's own MSISDN (get this from your SIM
provider's portal/CDR export, e.g. the `MSISDN` column in a FloLive events
CSV):

```
setparam 2004:<domain>;2005:<port>
```

e.g. `setparam 2004:gps.onfleet.africa;2005:52322` — take both from
`GET /api/tracking/endpoint` rather than from this page. Only set what's actually wrong — leave
the APN (param `2001`) alone unless you have specific reason to believe it's
misconfigured, since a bad APN value sent blind can do more harm than good.

Two things that can trip this up:

- **SMS login/password.** If SMS command security was enabled when the
  device was first provisioned, it silently ignores commands without the
  login prefix: `<password> setparam 2004:...;2005:...`. No reply within a
  few minutes after trying the plain command is the main symptom.
- **Data-only SIM.** Some M2M/IoT SIM plans (FloLive and similar global
  roaming platforms are often provisioned this way) have no SMS termination
  at all, to cut cost. Your SMS gateway/phone should tell you outright if
  delivery fails — if so, SMS isn't viable for that SIM and it has to wait
  for physical/USB access.

**2. How to know the exact parameter IDs to use.** If you have a `.cfg` file
previously exported from a known-working device (Teltonika Configurator →
export), it's gzip-compressed, human-readable once decompressed, and uses
the same numeric parameter IDs as the SMS command:

```bash
gunzip -k -S .cfg "Config_<imei>_<date>.cfg"   # writes a decompressed copy
```

Look for `2001` (APN), `2002`/`2003` (APN user/pass), `2004` (server domain),
`2005` (server port), `2006` (protocol, 0=TCP). Confirm these match a
currently-working device's config before trusting them for a new one —
firmware-version differences can shift parameter numbering.

**3. Verify it worked** — same checks as step 3 above (admin console, DB
`connected`/`last_seen_at`, server logs). Expect a result within a couple of
minutes if the SIM has a live connection; a `[Teltonika] + <imei> (<model>)`
log line and a `gps_pings` row with a recent `recorded_at` both confirm it
end-to-end:

```sql
SELECT recorded_at, lat, lng, satellites FROM gps_pings gp
JOIN tracking_devices td ON td.bike_id = gp.bike_id
WHERE td.imei = '<imei>' ORDER BY recorded_at DESC LIMIT 5;
```

A `satellites` value of `0` on those first pings is normal and not a
connectivity problem — it just means the device hasn't acquired a live GPS
fix yet (still warming up, or under cover) and is reporting its last-known
location. That resolves on its own with a clear view of the sky.

## Troubleshooting a device that never connects

Work through these in order — each rules out a whole category before moving
to the next:

1. **Is the device even reaching the server?**
   ```bash
   railway logs --service onfleet-platform --environment production | grep '<imei>'
   ```
   **Nothing at all**, ever — not even a failed/rejected attempt — points
   away from an app bug and toward the device's own connection settings
   (server address, SIM/APN, or power). This is the single most useful check:
   if other devices are connecting fine in the same log window, the platform
   is healthy and the problem is specific to this tracker.

2. **Server address.** Re-check the device's configured domain/port against
   `GET /api/tracking/endpoint` (see above) — not from memory, in case
   the proxy address has changed since the last install. If the device is
   already installed on a bike and you can't get it on USB, don't assume a
   FOTA config push actually applied just because it was sent — see
   "Remote recovery: SMS `setparam`" below for a faster, more direct fix.

3. **SIM data.** Confirm the SIM has an active data plan and the APN
   configured on the device matches the SIM provider's APN exactly. A tracker
   with power and GPS lock but no data connectivity behaves identically to a
   wrong server address from our side — you can't tell them apart from the
   admin console alone.

4. **Power and GSM signal.** Confirm the tracker has power (ignition or a
   direct 12V source, per the install) and is in an area with GSM coverage.
   No point debugging server settings on a device that isn't booted.

5. **Still nothing?** Register a *different*, known-working device's IMEI
   temporarily (or borrow one) and confirm it connects through the same SIM
   and wiring — isolates whether the fault is the tracker unit itself vs. the
   install (SIM, wiring, location).

## Related

- `backend/src/tcp/teltonikaServer.js` — the TCP server implementation and
  device-status thresholds (active/sleeping/offline)
- `backend/src/routes/tracking.js` — `/devices` admin endpoints (register,
  list, status)

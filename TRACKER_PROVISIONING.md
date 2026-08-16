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

**Get the current values before every install** — do not hardcode the ones
below into a device and reuse them for months, since Railway's TCP proxy
host/port is not guaranteed permanent unless a static proxy add-on is
configured (it isn't, today):

```bash
railway variables --service onfleet-platform --environment production | grep -i "tcp"
```

Look for `RAILWAY_TCP_PROXY_DOMAIN` and `RAILWAY_TCP_PROXY_PORT`. As of this
writing:

| Setting  | Value |
|----------|-------|
| Domain   | `hayabusa.proxy.rlwy.net` |
| Port     | `52322` |
| Protocol | TCP |

(`TELTONIKA_TCP_PORT` / `RAILWAY_TCP_APPLICATION_PORT`, currently `50150`, is
the port the app listens on *inside* Railway's network — never give this one
to a physical device, only the proxy port above.)

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
- **Domain/IP**: the `RAILWAY_TCP_PROXY_DOMAIN` value above
- **Port**: the `RAILWAY_TCP_PROXY_PORT` value above
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

e.g. `setparam 2004:hayabusa.proxy.rlwy.net;2005:52322` (using the current
values from `railway variables | grep -i tcp`, per the top of this doc — get
them fresh, don't reuse an old value). Only set what's actually wrong — leave
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
   `railway variables | grep -i tcp` (see above) — not from memory, in case
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

# Sending OnFleet messages on WhatsApp

WhatsApp is not SMS with a different address. Meta only lets a business *start* a
conversation with a template it has approved in advance; free text is refused
outside the 24 hours after the person last messaged you. So the setup is: a
sender, then approved templates, then credentials.

The code is ready for all of it — see `backend/src/services/smsProvider.js` and
`backend/src/constants/whatsappTemplates.js`.

## 1. A WhatsApp sender on Twilio

1. Twilio Console → **Messaging → Senders → WhatsApp senders → New sender**.
2. Connect a Meta Business account, or let Twilio create one, and verify the
   business (registration documents, a public website, a business email).
3. Choose the number. It must not already be on a personal or WhatsApp Business
   app; if it is, delete that account first. OnFleet's office line
   (010 141 1165) is the natural choice, though a dedicated number avoids
   surprises.
4. Meta reviews the sender — usually hours, sometimes a day or two.

While you wait, the **sandbox** (Messaging → Try it out → Send a WhatsApp
message) works immediately: each recipient sends a join code to Twilio's test
number, and free text then flows both ways. That is enough to see the whole
flow working end to end.

## 2. Templates

Submit each one in Twilio Console → **Content Template Builder**, category
**Utility** (cheaper than Marketing, and the right category for these). Copy the
wording from `backend/src/constants/whatsappTemplates.js` so that what Meta
approves and what the code sends stay identical.

| Message | Wording | Approved id goes in |
|---|---|---|
| Alert escalation | `OnFleet alert {{1}}: {{2}} on {{3}}. Unacknowledged for {{4}} minutes. Open the control room to acknowledge or close it.` | `WHATSAPP_TEMPLATE_ALERT_ESCALATION` |
| Payment due tomorrow | `Hi {{1}}, your weekly OnFleet payment of R{{2}} for agreement {{3}} is due tomorrow ({{4}}). Pay via the app to keep your rent-to-own on track.` | `WHATSAPP_TEMPLATE_PAYMENT_REMINDER` |
| Payment overdue | `Hi {{1}}, your OnFleet payment of R{{2}} for agreement {{3}} is overdue{{4}}. Please pay as soon as you can to keep your agreement in good standing.` | `WHATSAPP_TEMPLATE_PAYMENT_OVERDUE` |

Approval usually takes minutes. A rejected template is nearly always too
promotional, or has a variable right at the start or end of the message.

## 3. Credentials

Set these on the Railway service (Variables), without quotes:

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=+27...        # the approved sender, or the sandbox number
WHATSAPP_TEMPLATE_ALERT_ESCALATION=HX...
WHATSAPP_TEMPLATE_PAYMENT_REMINDER=HX...
WHATSAPP_TEMPLATE_PAYMENT_OVERDUE=HX...
TWILIO_SMS_FROM=+27...             # optional: the SMS fallback number
```

Nothing sends until `TWILIO_WHATSAPP_FROM` is set. With no template id for a
message, that message goes as free text — right for the sandbox, refused by a
live sender outside an open conversation.

## What goes out on WhatsApp

- **Critical alert escalations.** WhatsApp is tried first and SMS only if
  WhatsApp cannot carry it, so a duty phone is never messaged twice. Every
  attempt is recorded in `alert_escalations` with its channel and outcome.
- **Rider payment reminders and overdue notices**, which have carried
  `channel: 'whatsapp'` all along and were skipped for want of a provider.
  Expect roughly 25–40 messages a day once this is live; overdue notices back
  off as the debt ages (`shouldSendOverdueToday`).

Collections escalations also carry `channel: 'whatsapp'` and will start sending
too. Add a template for them if you would rather they weren't free text.

## Checking it works

- `notifications.status` tells the truth: `sent`, `failed`, or `skipped` when no
  provider is configured. Nothing is recorded as sent that did not leave the
  server.
- Twilio Console → Monitor → Logs → Messaging shows delivery and cost.
- A failed template send is usually a wrong template id, or a number that isn't
  on WhatsApp.

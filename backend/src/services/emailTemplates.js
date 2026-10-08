'use strict';

const { brand } = require('../brand');

// The shell, the button and the rule now live in emailLayout.js, because
// every transactional email needs them too and this file only ever covered
// the five marketing templates below.
const { layout, btn, divider } = require('./emailLayout');

// ── Templates ─────────────────────────────────────────────────────────────────

const BOOKING_URL = 'https://calendar.app.google/gL1v9a5bj7rxgbHV8';
const PORTAL_URL  = `${brand.portalUrl}/fleet/login`;
const PRICING_URL = `${brand.portalUrl}/#pricing`;

const TEMPLATES = {

  demo_invite: {
    label: 'Demo / call invite',
    subject: (org) => `Quick 15-min call about your ${brand.name} account, ${org.name}?`,
    html: (org) => layout({
      preheader: `We'd love to show you what ${brand.name} can do for your fleet in 15 minutes.`,
      body: `
        <p style="margin:0 0 16px">Hi ${org.contact_name || org.name},</p>
        <p style="margin:0 0 16px">I noticed you've been exploring ${brand.name} — thank you for giving it a shot!</p>
        <p style="margin:0 0 16px">I'd love to jump on a quick 15-minute call to walk you through the platform, answer any questions, and make sure you're getting the most out of it for your fleet.</p>
        <p style="margin:0 0 24px">No sales pressure — just a real conversation to see if we can help.</p>
        ${btn('Book a 15-min call →', BOOKING_URL)}
        <p style="margin:0 0 16px">Or simply reply to this email and we'll find a time that works for you.</p>
        ${divider()}
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280"><strong>Here's what we can cover:</strong></p>
        <ul style="margin:0 0 16px;padding-left:20px;color:#6b7280;font-size:13px">
          <li style="margin-bottom:6px">Setting up your bikes and rider agreements</li>
          <li style="margin-bottom:6px">Automated weekly payment collection via Paystack</li>
          <li style="margin-bottom:6px">GPS tracking and live fleet view</li>
          <li style="margin-bottom:6px">Collections queue and overdue management</li>
          <li>Reporting and wallet payouts</li>
        </ul>
        <p style="margin:0">Looking forward to connecting!<br /><br /><strong>The ${brand.name} Team</strong></p>
      `
    })
  },

  trial_ending: {
    label: 'Trial ending soon',
    subject: (org) => `Your ${brand.name} trial ends soon — don't lose access, ${org.name}`,
    html: (org) => {
      const days = org.trial_ends_at
        ? Math.max(0, Math.round((new Date(org.trial_ends_at) - Date.now()) / 86400000))
        : null;
      const dayLabel = days !== null ? `in <strong>${days} day${days !== 1 ? 's' : ''}</strong>` : 'soon';
      return layout({
        preheader: `Your ${brand.name} trial ends ${dayLabel}. Upgrade now to keep your fleet running.`,
        body: `
          <p style="margin:0 0 16px">Hi ${org.contact_name || org.name},</p>
          <p style="margin:0 0 16px">Just a heads-up — your ${brand.name} trial ends ${dayLabel}.</p>
          <p style="margin:0 0 16px">After that, your fleet portal will become read-only and you won't be able to record payments or manage agreements. Upgrading takes less than 2 minutes.</p>
          ${btn('Upgrade my plan →', PRICING_URL)}
          <p style="margin:0 0 24px">Not sure which plan is right for you? <a href="${BOOKING_URL}" style="color:#2563EB">Let's chat</a> — we'll help you choose.</p>
          ${divider()}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:33%;padding:12px;background:#f0f9ff;border-radius:8px;text-align:center;vertical-align:top">
                <div style="font-size:20px;font-weight:800;color:#1E3A5F">R200</div>
                <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">Starter /mo</div>
                <div style="font-size:12px;color:#374151;margin-top:6px">Up to 20 bikes</div>
              </td>
              <td style="width:4%"></td>
              <td style="width:33%;padding:12px;background:#eff6ff;border-radius:8px;text-align:center;vertical-align:top;border:2px solid #2563EB">
                <div style="font-size:11px;font-weight:700;color:#2563EB;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Most popular</div>
                <div style="font-size:20px;font-weight:800;color:#1E3A5F">R750</div>
                <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">Growth /mo</div>
                <div style="font-size:12px;color:#374151;margin-top:6px">Up to 60 bikes</div>
              </td>
              <td style="width:4%"></td>
              <td style="width:33%;padding:12px;background:#f0f9ff;border-radius:8px;text-align:center;vertical-align:top">
                <div style="font-size:20px;font-weight:800;color:#1E3A5F">R1 500</div>
                <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">Professional /mo</div>
                <div style="font-size:12px;color:#374151;margin-top:6px">Up to 100 bikes</div>
              </td>
            </tr>
          </table>
          <p style="margin:24px 0 0">Best,<br /><strong>The ${brand.name} Team</strong></p>
        `
      });
    }
  },

  trial_expired: {
    label: 'Trial expired — re-engage',
    subject: (org) => `Your ${brand.name} trial has ended — come back, ${org.name}`,
    html: (org) => layout({
      preheader: 'Your trial period ended. Reactivate your account and get back to managing your fleet.',
      body: `
        <p style="margin:0 0 16px">Hi ${org.contact_name || org.name},</p>
        <p style="margin:0 0 16px">Your ${brand.name} trial has come to an end. We hope you got to see what the platform can do for your fleet!</p>
        <p style="margin:0 0 16px">If you're ready to continue, upgrading your plan will restore full access immediately — your bikes, riders, agreements and payment history are all still there.</p>
        ${btn('Reactivate my account →', PRICING_URL)}
        <p style="margin:0 0 16px">If timing wasn't right or you ran into any issues during the trial, <a href="${BOOKING_URL}" style="color:#2563EB">let's schedule a quick call</a> — we'd love to understand what held you back and see if we can help.</p>
        ${divider()}
        <p style="margin:0 0 8px;font-size:13px;color:#374151"><strong>What you'll get with a paid plan:</strong></p>
        <ul style="margin:0 0 16px;padding-left:20px;color:#6b7280;font-size:13px">
          <li style="margin-bottom:6px">Unlimited agreement management and payment scheduling</li>
          <li style="margin-bottom:6px">Automated weekly Paystack debit collection</li>
          <li style="margin-bottom:6px">Live GPS tracking (Teltonika compatible)</li>
          <li style="margin-bottom:6px">Collections queue and defaulted rider management</li>
          <li>Fleet wallet with bank payout requests</li>
        </ul>
        <p style="margin:0">We're here to help,<br /><strong>The ${brand.name} Team</strong></p>
      `
    })
  },

  check_in: {
    label: 'Check-in / how is it going?',
    subject: (org) => `How's ${brand.name} working for ${org.name}?`,
    html: (org) => layout({
      preheader: `A quick check-in from the ${brand.name} team.`,
      body: `
        <p style="margin:0 0 16px">Hi ${org.contact_name || org.name},</p>
        <p style="margin:0 0 16px">Just checking in to see how things are going with ${brand.name}.</p>
        <p style="margin:0 0 16px">Is the platform working well for your team? Are there any features you'd like help setting up, or anything that isn't quite clicking yet?</p>
        <p style="margin:0 0 24px">We're always improving the platform based on feedback from fleet owners, so any thoughts — good or bad — are genuinely welcome.</p>
        ${btn('Log in to your portal →', PORTAL_URL)}
        <p style="margin:0 0 16px">Or if it's easier, just hit reply and let us know what's on your mind.</p>
        <p style="margin:0">Thanks for being part of ${brand.name}!<br /><strong>The ${brand.name} Team</strong></p>
      `
    })
  },

  upgrade_prompt: {
    label: 'Upgrade prompt',
    subject: (org) => `Take ${org.name}'s fleet to the next level with ${brand.name} Pro`,
    html: (org) => layout({
      preheader: `Unlock the full power of ${brand.name} — automated payments, live GPS, and fleet analytics.`,
      body: `
        <p style="margin:0 0 16px">Hi ${org.contact_name || org.name},</p>
        <p style="margin:0 0 16px">You've been using ${brand.name} during your trial — now it's time to unlock everything.</p>
        <p style="margin:0 0 16px">Fleet owners on paid plans collect payments faster, reduce defaults, and spend less time chasing riders because the platform handles the recurring billing automatically every week.</p>
        ${divider()}
        <p style="margin:0 0 12px;font-weight:700">What's included on every paid plan:</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
          ${[
            ['💳', 'Automated weekly Paystack debits — riders pay on schedule without manual follow-up'],
            ['📡', 'Live GPS tracking on Teltonika devices — see every bike in real time'],
            ['📋', 'Collections queue — surface overdue agreements before they become defaults'],
            ['💰', 'Fleet wallet — every payment lands in your wallet, request payouts to your bank'],
            ['📊', 'Reports and CSV exports — full payment history and agreement analytics'],
          ].map(([icon, text]) => `
            <tr>
              <td style="padding:8px 0;vertical-align:top;width:32px;font-size:18px">${icon}</td>
              <td style="padding:8px 0 8px 8px;font-size:14px;color:#374151;line-height:1.5">${text}</td>
            </tr>
          `).join('')}
        </table>
        ${btn('View plans and upgrade →', PRICING_URL)}
        <p style="margin:0 0 16px;font-size:13px;color:#6b7280">Plans start at <strong>R95 per bike / month</strong>, excluding VAT, with a ten-bike minimum. Cancel anytime.</p>
        <p style="margin:0">Best,<br /><strong>The ${brand.name} Team</strong></p>
      `
    })
  },

};

function getTemplate(key, org) {
  const tpl = TEMPLATES[key];
  if (!tpl) return null;
  return {
    subject: tpl.subject(org),
    html: tpl.html(org)
  };
}

function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, tpl]) => ({ key, label: tpl.label }));
}

function previewTemplate(key) {
  const org = {
    name: 'Sample Fleet Co.',
    contact_name: 'Fleet Manager',
    trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString()
  };
  const tpl = TEMPLATES[key];
  if (!tpl) return null;
  return { subject: tpl.subject(org), html: tpl.html(org) };
}

module.exports = { getTemplate, listTemplates, previewTemplate };

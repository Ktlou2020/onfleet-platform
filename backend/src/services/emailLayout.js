'use strict';

const { brand } = require('../brand');

/**
 * One shell for every email the platform sends.
 *
 * This used to wrap the five marketing templates and nothing else. Everything
 * transactional — the invite that creates an account, password resets, payment
 * reminders, overdue notices, dunning, alerts — went through
 * sendNotification -> sendEmail(to, title, body) and was posted to the provider
 * as the raw text somebody typed into a route handler. The first email a new
 * fleet owner ever received from us was three unstyled lines and a 64-character
 * reset token wrapped across two lines of blue underline.
 *
 * So the wrapper moved here, and sendEmail puts every message through it. The
 * practical effect is that improving this file improves every email at once,
 * and a new notification added in a route is well-dressed without its author
 * having to think about HTML.
 *
 * Email is not the web. Tables, inline styles, no flexbox, no external CSS;
 * Outlook renders through Word. Everything below is deliberately boring.
 */

// A logo is either drawn for a dark background or for a light one, and getting
// it wrong makes it invisible rather than ugly. Pillion's wordmark is a cream
// fill with an amber dot and needs the dark header; OnFleet's is a blue mark on
// white and would disappear into the navy, so it gets a white band with an
// accent rule under it.
function headerStyle() {
  const onDark = brand.emailLogoBackground !== 'light';
  return onDark
    ? { bg: brand.emailHeaderBg, rule: null, text: '#ffffff', kicker: brand.emailAccent }
    : { bg: '#ffffff', rule: brand.emailHeaderBg, text: brand.emailHeaderBg, kicker: '#6b7280' };
}

// emailLogo when the brand has one, because the asset a header wants (trimmed
// to its ink, horizontal) is not the asset a favicon wants.
function logoUrl() {
  const file = brand.emailLogo || brand.logo;
  if (!file) return null;
  return /^https?:\/\//i.test(file) ? file : `${brand.portalUrl}${file}`;
}

// Images are blocked by default in most clients, so the brand name is always
// present as real text too — as the alt, and as the wordmark when there is no
// logo file. An email whose entire identity lives in an <img> arrives blank.
function header() {
  const style = headerStyle();
  const src = logoUrl();
  const height = brand.emailLogoHeight || 34;
  const mark = src
    ? `<img src="${src}" alt="${brand.name}" height="${height}" style="display:block;border:0;height:${height}px;width:auto;max-width:220px" />`
    : `<span style="font-size:22px;font-weight:700;color:${style.text};letter-spacing:-.3px">${brand.name}</span>`;

  return `<tr>
          <td style="background:${style.bg};padding:24px 32px">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
              <td align="left" style="vertical-align:middle">${mark}</td>
              <td align="right" style="vertical-align:middle;font-size:12px;color:${style.kicker};letter-spacing:.4px;text-transform:uppercase">${brand.emailKicker}</td>
            </tr></table>
          </td>
        </tr>
        ${style.rule ? `<tr><td style="height:4px;background:${style.rule};font-size:0;line-height:0">&nbsp;</td></tr>` : ''}`;
}

function footer({ note }) {
  const support = brand.email?.from;
  return `<tr>
          <td style="background:#f4f6f9;padding:20px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;line-height:1.6">
            <strong style="color:#4b5563">${brand.fullName}</strong>
            &nbsp;·&nbsp; <a href="${brand.portalUrl}" style="color:${brand.emailHeaderBg};text-decoration:none">${brand.domain}</a>
            ${support ? `&nbsp;·&nbsp; <a href="mailto:${support}" style="color:${brand.emailHeaderBg};text-decoration:none">${support}</a>` : ''}
            <br />${note}
          </td>
        </tr>`;
}

/**
 * @param footerNote why this email reached the reader. The marketing templates
 *   say "you registered for a trial"; a password reset must not, because it is
 *   untrue and because an unexpected reset email is exactly the one a reader
 *   needs to take seriously.
 */
function layout({ preheader = '', body, footerNote = null }) {
  const note = footerNote
    || `This is an automated message about your ${brand.name} account.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${brand.name}</title>
  <!--[if mso]><style>td,th,div,p,a,h1,h2,h3,h4,h5,h6{font-family:Arial,sans-serif!important}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
        ${header()}
        <tr>
          <td style="padding:32px;color:#1a2b42;font-size:15px;line-height:1.7">
            ${body}
          </td>
        </tr>
        ${footer({ note })}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function btn(label, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0">
    <tr><td style="background:${brand.emailHeaderBg};border-radius:8px">
      <a href="${url}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px">${label}</a>
    </td></tr>
  </table>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />`;
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A URL alone on its line is the thing the reader is meant to click, so it
// becomes the button. This is what turns a 64-character reset token wrapped
// across two lines of underlined blue into "Set your password".
const LONE_URL = /^(https?:\/\/\S+)$/;

// The label a bare link gets. Decided by the URL first and only then by the
// subject, because the destination is a fact and the subject is a topic: a
// "could not collect your payment" email linking to the card-update page was
// being labelled "Make a payment", which is not where it goes.
function labelForUrl(url, subject) {
  const u = String(url).toLowerCase();
  if (u.includes('reset-password') || u.includes('set-password')) return 'Set your password';
  if (u.includes('verify')) return 'Verify your email';
  if (u.includes('billing')) return 'Update payment details';
  if (u.includes('statement')) return 'View your statement';
  if (u.includes('invoice')) return 'View your invoice';
  if (u.includes('/pay')) return 'Make a payment';

  const s = String(subject || '').toLowerCase();
  if (s.includes('set up your')) return 'Set your password';
  if (s.includes('statement') || s.includes('invoice')) return 'View your statement';
  return `Open ${brand.name}`;
}

/**
 * Turn the plain text of a notification into the branded email.
 *
 * Blank lines become paragraphs, a lone URL becomes the button, and any other
 * URL becomes an ordinary link. Everything is escaped first: these bodies are
 * built by string concatenation in route handlers from names a user typed, and
 * an apostrophe in a company name should not be able to reach the markup.
 */
function renderTransactional({ subject, message, footerNote = null }) {
  const text = String(message || '').replace(/\r\n/g, '\n').trim();
  const blocks = text.split(/\n{2,}/);

  // Nodes in the order they were written. An earlier version collected
  // paragraphs and a button separately and then spliced the button in after
  // the first paragraph, which put it above the sentence that introduced it:
  // the reader saw the button, then "Set your password to get started"
  // underneath it. Keeping one ordered list means the button cannot drift
  // away from its own lead-in.
  const nodes = [];
  let haveButton = false;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const lines = trimmed.split('\n').map((l) => l.trim());
    // "Set your password to get started: https://..." — one line, but the
    // colon makes it unambiguous that the sentence is introducing the link,
    // so the link can safely become the button.
    //
    // The colon is required. Matching any whitespace before the URL swallowed
    // ordinary prose that happened to end in a link — "if the card has changed
    // you can update it here: <url>" is fine, but "...you can update it here
    // <url>" left the word "here" pointing at nothing once the link had been
    // lifted out into a button further down. Prose with a link in it keeps the
    // link inline, where it still reads.
    const trailing = lines.length === 1
      ? lines[0].match(/^(.{0,140}?):\s*(https?:\/\/\S+)$/)
      : null;

    if (lines.length === 1 && LONE_URL.test(lines[0]) && !haveButton) {
      nodes.push(btn(labelForUrl(lines[0], subject), lines[0]));
      haveButton = true;
      continue;
    }
    if (trailing && !haveButton) {
      const lead = trailing[1].trim().replace(/[:,]$/, '');
      if (lead) nodes.push(`<p style="margin:0 0 4px">${escapeHtml(lead)}</p>`);
      nodes.push(btn(labelForUrl(trailing[2], subject), trailing[2]));
      haveButton = true;
      continue;
    }

    const html = escapeHtml(trimmed)
      .replace(/\n/g, '<br />')
      .replace(/(https?:\/\/\S+)/g,
        `<a href="$1" style="color:${brand.emailHeaderBg};word-break:break-all">$1</a>`);
    nodes.push(`<p style="margin:0 0 16px">${html}</p>`);
  }

  const heading = subject
    ? `<h1 style="margin:0 0 20px;font-size:21px;line-height:1.3;color:#0f172a;font-weight:700">${escapeHtml(subject)}</h1>`
    : '';

  const body = heading + nodes.join('');

  return layout({
    // Escaped like everything else. This was interpolated raw, so a company
    // name with a bracket in it reached the markup through the preheader even
    // though the body it was copied from had been escaped properly.
    preheader: escapeHtml(blocks[0]?.replace(/\s+/g, ' ').slice(0, 140) || ''),
    body,
    footerNote,
  });
}

module.exports = { layout, btn, divider, renderTransactional, escapeHtml, logoUrl, headerStyle };

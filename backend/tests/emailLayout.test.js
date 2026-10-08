import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { renderTransactional, layout, btn } = require_('../src/services/emailLayout.js');
const { brand } = require_('../src/brand.js');

// The shell every email goes through.
//
// This runs on literally every message the platform sends — invites, password
// resets, payment reminders, dunning, alerts — so a mistake here is a mistake
// in all of them at once. That cuts both ways, which is why it is worth
// pinning down rather than eyeballing one render.

describe('transactional email layout', () => {
  const render = (message, subject = 'Test subject') =>
    renderTransactional({ subject, message });

  describe('the shell', () => {
    it('carries the brand name as real text, not only inside the logo image', () => {
      const html = render('Hello.');
      // Images are blocked by default in most clients. An email whose entire
      // identity is an <img> arrives looking like spam.
      expect(html).toContain(`alt="${brand.name}"`);
      expect(html).toContain(brand.fullName);
    });

    it('points the logo at an absolute URL', () => {
      const html = render('Hello.');
      const src = html.match(/<img src="([^"]+)"/)?.[1];
      expect(src, 'a relative logo src resolves against the mail client, not the portal')
        .toMatch(/^https:\/\//);
    });

    it('says why the email arrived, and does not claim a trial signup', () => {
      const html = render('Your password was reset.');
      expect(html).toContain('automated message');
      expect(html, 'a password reset told the reader they had registered for a trial')
        .not.toContain('registered for a');
    });

    it('lets a caller say why it arrived when the default is wrong', () => {
      const html = renderTransactional({
        subject: 'x', message: 'y', footerNote: 'You asked us to email this report.',
      });
      expect(html).toContain('You asked us to email this report.');
    });
  });

  describe('links', () => {
    it('turns a link on its own line into a button', () => {
      const html = render('Set your password.\n\nhttps://portal.example/reset-password?token=abc');
      expect(html).toContain('Set your password<');
      expect(html).toContain('href="https://portal.example/reset-password?token=abc"');
    });

    it('turns "sentence: link" into a button and keeps the sentence above it', () => {
      const html = render('Welcome.\n\nSet your password to get started: https://portal.example/reset-password?t=1');
      const lead = html.indexOf('Set your password to get started');
      const button = html.indexOf('border-radius:8px');
      expect(lead).toBeGreaterThan(-1);
      expect(button).toBeGreaterThan(-1);
      // The button once rendered above its own introduction, so the reader met
      // the button first and the sentence explaining it afterwards.
      expect(lead, 'the button floated above the sentence that introduces it').toBeLessThan(button);
    });

    // A link inside ordinary prose stays inline. Lifting it out leaves the
    // sentence pointing at nothing — "you can update it here" with no "here".
    it('leaves a link that is part of a sentence alone', () => {
      const html = render('If the card has changed you can update it here https://portal.example/fleet/billing');
      expect(html).toContain('update it here');
      expect(html).toContain('<a href="https://portal.example/fleet/billing"');
      expect(html, 'prose with a trailing link was turned into a button, orphaning the sentence')
        .not.toContain('display:inline-block;padding:14px 28px');
    });

    it('labels the button by where it goes, not by the subject', () => {
      const html = renderTransactional({
        subject: 'Your payment could not be collected',
        message: 'Update your card here: https://portal.example/fleet/billing',
      });
      expect(html).toContain('Update payment details');
      expect(html, 'a card-update link was labelled "Make a payment"').not.toContain('Make a payment');
    });

    it('promotes only the first link, so a second does not become a rival button', () => {
      const html = render('One: https://a.example/x\n\nTwo: https://b.example/y');
      const buttons = html.match(/display:inline-block;padding:14px 28px/g) || [];
      expect(buttons.length).toBe(1);
      expect(html).toContain('<a href="https://b.example/y"');
    });
  });

  describe('untrusted text', () => {
    // These bodies are built by string concatenation in route handlers out of
    // names somebody typed into a form.
    it('escapes markup in a company or person name', () => {
      const html = render('Welcome, <script>alert(1)</script> — Bob & Sons is now on the platform.');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('Bob &amp; Sons');
    });

    it('escapes a quote in the subject it puts in the heading', () => {
      const html = renderTransactional({ subject: 'O"Brien\'s <b>account</b>', message: 'Hi.' });
      expect(html).not.toContain('<b>account</b>');
      expect(html).toContain('&lt;b&gt;');
    });
  });

  describe('structure', () => {
    it('keeps blank-line-separated text as separate paragraphs', () => {
      const html = render('First para.\n\nSecond para.');
      expect((html.match(/<p style="margin:0 0 16px">/g) || []).length).toBe(2);
    });

    it('keeps single newlines as line breaks within a paragraph', () => {
      const html = render('Line one\nLine two');
      expect(html).toContain('Line one<br />Line two');
    });

    it('sets a preheader from the opening line', () => {
      const html = render('Your October invoice is ready.\n\nMore detail here.');
      expect(html).toContain('Your October invoice is ready.');
      expect(html).toMatch(/mso-hide:all/);
    });

    it('survives an empty body without producing broken markup', () => {
      const html = render('');
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('</html>');
    });
  });

  describe('the pieces the marketing templates still use', () => {
    it('exports a layout and a button that render', () => {
      expect(layout({ body: '<p>hi</p>' })).toContain('<p>hi</p>');
      expect(btn('Go', 'https://x.example')).toContain('href="https://x.example"');
    });
  });
});

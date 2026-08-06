import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const requireFromHere = createRequire(import.meta.url);
const { parseDateFlexible, parseMoney } = requireFromHere('../src/services/csvImports.js');

describe('csvImports parseDateFlexible', () => {
  it('parses ambiguous DD/MM/YYYY dates as day-first (South African convention)', () => {
    // Regression: this used to assume MM/DD/YYYY (US) for any ambiguous
    // date, silently swapping day and month whenever both were <= 12 —
    // e.g. 5 March read as May 3 — with no error, straight into
    // agreements.start_date (which anchors the whole payment schedule) or
    // payments.paid_at.
    expect(parseDateFlexible('05/03/2026')).toBe('2026-03-05');
    expect(parseDateFlexible('01/12/2026')).toBe('2026-12-01');
  });

  it('self-corrects when the day-first reading puts an impossible month', () => {
    expect(parseDateFlexible('25/03/2026')).toBe('2026-03-25');
    expect(parseDateFlexible('12/25/2026')).toBe('2026-12-25');
  });

  it('passes through ISO dates unchanged', () => {
    expect(parseDateFlexible('2026-03-05')).toBe('2026-03-05');
  });

  it('falls back when nothing is a valid date', () => {
    expect(parseDateFlexible('not a date', 'FALLBACK')).toBe('FALLBACK');
    expect(parseDateFlexible('', 'FALLBACK')).toBe('FALLBACK');
  });
});

describe('csvImports parseMoney', () => {
  it('strips currency symbols and thousands separators', () => {
    expect(parseMoney('R1,500.00')).toBe(1500);
    expect(parseMoney('850')).toBe(850);
    expect(parseMoney('')).toBe(0);
  });
});

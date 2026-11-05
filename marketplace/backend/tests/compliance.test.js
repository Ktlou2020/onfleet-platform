import { describe, it, expect } from 'vitest';
const { parseSaId, isAdult, canSell, deliveryWindowOpen } = require('../src/compliance');
const { saId } = require('./helpers');

const NOW = new Date('2026-11-05T10:00:00Z');

describe('SA ID numbers', () => {
  it('reads the date of birth and age from a valid ID', () => {
    const r = parseSaId(saId('900101'), NOW);
    expect(r).toMatchObject({ valid: true, dob: '1990-01-01', age: 36, gender: 'male' });
  });

  it('rejects a mistyped ID through the check digit', () => {
    const id = saId('900101');
    const wrong = id.slice(0, 12) + ((Number(id[12]) + 1) % 10);
    expect(parseSaId(wrong, NOW).valid).toBe(false);
  });

  it('rejects impossible dates and wrong lengths', () => {
    expect(parseSaId(saId('900231'), NOW).valid).toBe(false);
    expect(parseSaId('12345', NOW).valid).toBe(false);
  });

  it('puts the 18th birthday on the right side of the line', () => {
    expect(isAdult(parseSaId(saId('081105'), NOW))).toBe(true); // 18 today
    expect(isAdult(parseSaId(saId('081106'), NOW))).toBe(false); // 18 tomorrow
  });
});

describe('what may be sold', () => {
  const regulated = { slug: 'flower', name: 'Flower', regulated: 1 };
  const open = { slug: 'papers', name: 'Papers', regulated: 0 };
  const licensed = { licence_verified: 1, licence_categories: '["flower"]' };
  const on = { regulatedSalesEnabled: true };
  const off = { regulatedSalesEnabled: false };

  it('always allows unregulated categories', () => {
    expect(canSell({ category: open, store: {}, settings: off }).ok).toBe(true);
  });

  it('needs the platform switch, a verified licence, and coverage', () => {
    expect(canSell({ category: regulated, store: licensed, settings: off }).ok).toBe(false);
    expect(canSell({ category: regulated, store: { ...licensed, licence_verified: 0 }, settings: on }).ok).toBe(false);
    expect(canSell({ category: regulated, store: { ...licensed, licence_categories: '["edibles"]' }, settings: on }).ok).toBe(false);
    expect(canSell({ category: regulated, store: licensed, settings: on }).ok).toBe(true);
  });

  it('keeps to delivery hours in SAST', () => {
    const s = { deliveryOpenHour: 8, deliveryCloseHour: 22 };
    expect(deliveryWindowOpen(s, new Date('2026-11-05T05:59:00Z'))).toBe(false); // 07:59 SAST
    expect(deliveryWindowOpen(s, new Date('2026-11-05T06:00:00Z'))).toBe(true); // 08:00 SAST
    expect(deliveryWindowOpen(s, new Date('2026-11-05T20:00:00Z'))).toBe(false); // 22:00 SAST
  });
});

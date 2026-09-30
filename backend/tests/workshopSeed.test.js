import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { initialWorkshops, ONFLEET, GENERIC } =
  createRequire(import.meta.url)('../src/constants/workshopSeed.js');

// Whose workshops a new database starts with.
//
// A Pillion deployment was seeded with OnFleet's own two workshops, by name,
// in a product sold to companies OnFleet competes with. The rows are still in
// Pillion's production database — this does not fix those, it stops the next
// environment repeating it.

describe('a new database, seeded', () => {
  it('gives OnFleet the two workshops it actually owns', () => {
    expect(initialWorkshops(true).map((w) => w.name)).toEqual(['OnFix', 'Bikerhouse']);
  });

  it('gives every other brand a placeholder instead', () => {
    const seeded = initialWorkshops(false);
    expect(seeded).toHaveLength(1);
    expect(seeded[0].name).toBe('Main Workshop');
  });

  // The specific thing that went wrong.
  it('never puts OnFleet\'s workshop names in another brand\'s database', () => {
    const onfleetNames = ONFLEET.map((w) => w.name);
    for (const w of initialWorkshops(false)) {
      expect(onfleetNames, `${w.name} is OnFleet's`).not.toContain(w.name);
    }
  });

  // Province decides which workshop a rider is shown first. A placeholder
  // winning that would send riders to a workshop nobody has configured.
  it('leaves the placeholder without a province, so it is never a default', () => {
    expect(initialWorkshops(false).every((w) => w.province == null)).toBe(true);
  });

  // city is NOT NULL, so the placeholder has to carry something.
  it('still satisfies the not-null columns', () => {
    for (const w of [...ONFLEET, ...GENERIC]) {
      expect(w.name, 'name is NOT NULL').toBeTruthy();
      expect(w.city, 'city is NOT NULL').toBeTruthy();
    }
  });

  // One, not two: the rider booking page only draws a workshop picker when
  // there is more than one, and a fresh deployment should not open with a
  // choice between two placeholders.
  it('starts a fresh non-OnFleet deployment with a single workshop', () => {
    expect(initialWorkshops(false)).toHaveLength(1);
  });
});

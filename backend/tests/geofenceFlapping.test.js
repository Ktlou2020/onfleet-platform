import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const load = createRequire(import.meta.url);
const geo = load('../src/services/geofenceGeometry.js');
const incident = load('./fixtures/comoCityFlapping.json');

// MS23NMGP, 22 September 2026. The bike rode a road running along the edge of
// the "Como City" no-go zone. Ordinary GPS scatter put its fixes alternately
// inside and outside, and every inward crossing cut the engine — twice in four
// minutes, with somebody restoring it in between while the rider waited.
//
// The fixture is that afternoon's real polygon and real pings.
describe('a bike riding the edge of a no-go zone', () => {
  const zone = {
    polygon_coords: incident.zone.polygon,
    lat: incident.zone.lat,
    lng: incident.zone.lng,
    radius_m: incident.zone.radius_m,
  };

  const crossings = (enterBufferM, exitBufferM) => {
    let was = null;
    let flips = 0;
    for (const p of incident.pings) {
      const now = geo.resolveInside({
        metres: geo.metresInside(p.lat, p.lng, zone),
        wasInside: was, enterBufferM, exitBufferM,
      });
      if (was !== null && now !== was) flips += 1;
      was = now;
    }
    return flips;
  };

  it('crossed the line three times in eight minutes, judged on which side alone', () => {
    // A zero dead band is the old behaviour: every scattered fix gets a vote.
    expect(crossings(0, 0)).toBe(3);
  });

  it('crosses once with a 75 m dead band — the entry that actually happened', () => {
    expect(crossings(75, 75)).toBe(1);
  });

  // Each inward crossing was an engine cut, so this is the number that
  // mattered to the rider standing next to a bike that would not start.
  it('turns two immobilisations into one', () => {
    const inwardCrossings = (enterBufferM, exitBufferM) => {
      let was = null;
      let cuts = 0;
      for (const p of incident.pings) {
        const now = geo.resolveInside({
          metres: geo.metresInside(p.lat, p.lng, zone),
          wasInside: was, enterBufferM, exitBufferM,
        });
        if (was === false && now === true) cuts += 1;
        was = now;
      }
      return cuts;
    };
    expect(inwardCrossings(0, 0)).toBe(2);
    expect(inwardCrossings(75, 75)).toBe(1);
  });

  // The fix must not become "never cut anything". The bike did go properly
  // inside this zone, and that entry is still caught.
  it('still sees the genuine entry, well inside the boundary', () => {
    const depths = incident.pings.map((p) => geo.metresInside(p.lat, p.lng, zone));
    expect(Math.max(...depths)).toBeGreaterThan(150);
  });

  it('reads the far side of the zone as properly outside', () => {
    const depths = incident.pings.map((p) => geo.metresInside(p.lat, p.lng, zone));
    expect(Math.min(...depths)).toBeLessThan(-500);
  });
});

describe('measuring how far inside a zone a point is', () => {
  // A circle is the easy case and pins the sign convention down.
  const circle = { lat: -26.2041, lng: 28.0473, radius_m: 500, polygon_coords: null };

  it('is positive at the centre, by the whole radius', () => {
    expect(geo.metresInside(-26.2041, 28.0473, circle)).toBeCloseTo(500, 0);
  });

  it('is about zero on the edge', () => {
    // 500 m north of the centre: one degree of latitude is ~111.32 km.
    const edgeLat = -26.2041 + 500 / 111320;
    expect(Math.abs(geo.metresInside(edgeLat, 28.0473, circle))).toBeLessThan(5);
  });

  it('is negative outside, by how far out', () => {
    const outLat = -26.2041 + 1500 / 111320;
    expect(geo.metresInside(outLat, 28.0473, circle)).toBeCloseTo(-1000, -1);
  });

  it('handles a polygon stored as text, as the database returns it', () => {
    const square = [[-26.20, 28.04], [-26.20, 28.06], [-26.22, 28.06], [-26.22, 28.04]];
    const asText = { polygon_coords: JSON.stringify(square) };
    const asArray = { polygon_coords: square };
    expect(geo.metresInside(-26.21, 28.05, asText)).toBeCloseTo(geo.metresInside(-26.21, 28.05, asArray), 0);
    expect(geo.metresInside(-26.21, 28.05, asText)).toBeGreaterThan(0);
  });
});

describe('the dead band itself', () => {
  const band = { enterBufferM: 75, exitBufferM: 75 };

  it('does not let a point just over the line count as entering', () => {
    expect(geo.resolveInside({ metres: 20, wasInside: false, ...band })).toBe(false);
  });

  it('does not let a point just outside count as leaving', () => {
    expect(geo.resolveInside({ metres: -20, wasInside: true, ...band })).toBe(true);
  });

  it('enters once properly inside', () => {
    expect(geo.resolveInside({ metres: 80, wasInside: false, ...band })).toBe(true);
  });

  it('leaves once properly outside', () => {
    expect(geo.resolveInside({ metres: -80, wasInside: true, ...band })).toBe(false);
  });

  // With nothing known yet there is no state to protect, and refusing to
  // decide would leave a bike parked inside a no-go zone unnoticed for ever.
  it('takes the plain answer the first time it sees a bike', () => {
    expect(geo.resolveInside({ metres: 5, wasInside: null, ...band })).toBe(true);
    expect(geo.resolveInside({ metres: -5, wasInside: null, ...band })).toBe(false);
  });
});

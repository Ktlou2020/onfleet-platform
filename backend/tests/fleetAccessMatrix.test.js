import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { FLEET_RESOURCE_ACCESS as FRONTEND } from '../../frontend/src/pages/fleet/access.js';

const BACKEND = createRequire(import.meta.url)('../src/routes/fleet.js').FLEET_RESOURCE_ACCESS;

// Two copies of who may see what.
//
// The backend's copy decides what the API allows. The frontend's decides what
// the menu draws. They are written out separately because they live either
// side of the wire, and nothing has ever checked that they agree — so the
// failure mode is a menu item that 403s when a fleet owner clicks it, or
// worse, a section somebody believes is hidden because it is missing from the
// menu while the endpoint behind it answers perfectly well.

// A section may exist on the frontend alone when there is no API behind it to
// gate. Help is a static page. Anything else appearing here should be
// questioned rather than added.
const FRONTEND_ONLY = ['help'];

describe('the fleet access matrix, on both sides of the wire', () => {
  it('gates every section the API has', () => {
    const missing = Object.keys(BACKEND).filter((k) => !FRONTEND[k]);
    expect(missing, 'the API gates these but the menu does not know about them').toEqual([]);
  });

  it('draws nothing the API does not gate, bar the static pages', () => {
    const extra = Object.keys(FRONTEND).filter((k) => !BACKEND[k] && !FRONTEND_ONLY.includes(k));
    expect(extra, 'the menu offers these but no endpoint gates them').toEqual([]);
  });

  // Where both sides define a section, they must say the same thing.
  for (const key of Object.keys(BACKEND)) {
    it(`agrees on who may view ${key}`, () => {
      expect([...(FRONTEND[key]?.view || [])].sort()).toEqual([...BACKEND[key].view].sort());
    });

    it(`agrees on who may manage ${key}`, () => {
      expect([...(FRONTEND[key]?.manage || [])].sort()).toEqual([...BACKEND[key].manage].sort());
    });
  }
});

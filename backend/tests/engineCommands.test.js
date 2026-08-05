import { describe, it, expect } from 'vitest';
import { cutCommandForModel, restoreCommandForModel } from '../src/services/engineCommands.js';

describe('engineCommands', () => {
  it('maps FMB965 to digital output 2, everything else to output 1', () => {
    expect(cutCommandForModel('FMB965')).toBe('setdigout 2 1');
    expect(restoreCommandForModel('FMB965')).toBe('setdigout 2 0');
    expect(cutCommandForModel('FMB920')).toBe('setdigout 1 1');
    expect(cutCommandForModel('FMC920')).toBe('setdigout 1 1');
  });

  it('is case-insensitive (tracking.js/fleet.js used to look up device.model verbatim and silently fall through to a default on any case mismatch)', () => {
    expect(cutCommandForModel('fmb965')).toBe('setdigout 2 1');
    expect(cutCommandForModel('Fmb965')).toBe('setdigout 2 1');
  });

  it('falls back to output 1 for an unknown/other model', () => {
    expect(cutCommandForModel('SomeOtherModel')).toBe('setdigout 1 1');
    expect(cutCommandForModel(null)).toBe('setdigout 1 1');
    expect(cutCommandForModel(undefined)).toBe('setdigout 1 1');
  });
});

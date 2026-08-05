import { describe, it, expect } from 'vitest';
import { cutCommandForModel, restoreCommandForModel } from '../src/services/engineCommands.js';

describe('engineCommands', () => {
  it('sends state-only commands with no timeout, so the cut/restore holds indefinitely', () => {
    // setdigout <state> <N> holds for N seconds then auto-reverts — a trailing
    // number here is a real, previously-shipped bug (see file comment), not
    // a stylistic choice. Assert the exact opposite: no third token at all.
    expect(cutCommandForModel('FMB920')).toBe('setdigout 1');
    expect(restoreCommandForModel('FMB920')).toBe('setdigout 0');
    for (const model of ['FMB920', 'FMC920', 'FMB965', 'unknown', null, undefined]) {
      expect(cutCommandForModel(model)).not.toMatch(/\d\s+\d+$/);
      expect(restoreCommandForModel(model)).not.toMatch(/\d\s+\d+$/);
    }
  });

  it('maps FMB965 to digital output 2 (DOUT1 left unchanged via "?"), everything else to output 1', () => {
    expect(cutCommandForModel('FMB965')).toBe('setdigout ? 1');
    expect(restoreCommandForModel('FMB965')).toBe('setdigout ? 0');
    expect(cutCommandForModel('FMB920')).toBe('setdigout 1');
    expect(cutCommandForModel('FMC920')).toBe('setdigout 1');
  });

  it('is case-insensitive (tracking.js/fleet.js used to look up device.model verbatim and silently fall through to a default on any case mismatch)', () => {
    expect(cutCommandForModel('fmb965')).toBe('setdigout ? 1');
    expect(cutCommandForModel('Fmb965')).toBe('setdigout ? 1');
  });

  it('falls back to output 1 for an unknown/other model', () => {
    expect(cutCommandForModel('SomeOtherModel')).toBe('setdigout 1');
    expect(cutCommandForModel(null)).toBe('setdigout 1');
    expect(cutCommandForModel(undefined)).toBe('setdigout 1');
  });
});

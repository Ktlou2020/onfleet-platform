import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const requireFromHere = createRequire(import.meta.url);
const { extractAmountCandidates, normalizeAmount } = requireFromHere('../src/services/documentInsights.js');

describe('documentInsights amount extraction', () => {
  it('does not glue separate whitespace-adjacent numbers into one value', () => {
    // Regression for a production bug: numbers separated by whitespace
    // (including non-breaking space, which JS \s matches) were captured
    // as one blob and concatenated once the whitespace was stripped.
    const text = 'BALANCE AS AT 31 MAR 2026  R2,234.71';
    const candidates = extractAmountCandidates(text);
    expect(candidates).toContain(2234.71);
    expect(candidates.every((v) => v < 100000)).toBe(true);
  });

  it('extracts the correct figure from multiple close-together payslip line items', () => {
    const text = 'Basic Pay 12,500.00 Deductions 500.00 Net Pay 12,000.00';
    const candidates = extractAmountCandidates(text);
    expect(candidates).toContain(12000);
    expect(candidates.every((v) => v < 100000)).toBe(true);
  });

  it('does not treat an ID number as an amount just because "r" appears mid-word', () => {
    // Regression: the currency trigger (?:R|ZAR) was case-insensitive with no
    // word boundary, so it matched the "r" in words like "Employer"/"Number"
    // and then swallowed the SA ID number that followed.
    const text = 'Employer Number9603105328084 Pay Period 2024/04/30';
    const candidates = extractAmountCandidates(text);
    expect(candidates).toEqual([]);
  });

  it('still extracts a real payslip amount next to an ID number', () => {
    const text = 'ID Number: 8501015800083\nNet Pay R 15,209.97\nTotal Earnings R15 209.97';
    const candidates = extractAmountCandidates(text);
    expect(candidates[0]).toBe(15209.97);
  });

  it('rejects implausibly large amounts as a sanity ceiling', () => {
    const text = 'R 27600000000000.00';
    const candidates = extractAmountCandidates(text);
    expect(candidates).toEqual([]);
  });

  it('normalizeAmount handles both comma-decimal and comma-thousands formats', () => {
    expect(normalizeAmount('12,500.00')).toBe(12500);
    expect(normalizeAmount('12500,50')).toBe(12500.5);
    expect(normalizeAmount('')).toBe(null);
  });
});

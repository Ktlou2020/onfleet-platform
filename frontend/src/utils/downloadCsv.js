// Shared CSV export for the admin tables.
//
// A CSV is opened in a spreadsheet rather than read, so callers pass values
// rather than the strings their table renders: "14 Nov 2026", "R1 850,50" and
// "0 files" each sort as text and none of them add up. Dates go through
// csvDate so every export spells one the same sortable way.
//
// This exists because the same ten lines had been pasted into five pages and
// had already drifted — some of them quote with String(cell || ''), which
// turns a legitimate 0 into an empty cell. Here it is `??`, once.

/** A date a spreadsheet can sort: YYYY-MM-DD, in the reader's own timezone. */
export const csvDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  // Built from local parts rather than toISOString, which is UTC and would
  // move an early-morning SAST row back to the previous day.
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** Today, for filenames. */
export const csvToday = () => csvDate(new Date());

/**
 * Build a CSV from a header row and rows of values, and hand it to the
 * browser as a download.
 */
export function downloadCsv(filename, headers, rows) {
  const body = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  // The BOM is what makes Excel read the file as UTF-8. Without it a rider
  // named Müller or Sibhóngo arrives mangled on a Windows desktop, which is
  // where these files are opened.
  const blob = new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

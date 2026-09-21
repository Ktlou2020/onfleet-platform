'use strict';

// A small .xlsx reader: enough to turn a spreadsheet into rows of cells.
//
// An .xlsx file is a ZIP of XML parts, and everything needed here — the sheet
// names, the shared string table and each sheet's cells — is plain XML. Node
// already ships the only hard part (raw inflate), so this avoids adding a
// dependency for what is, in the end, reading a grid. The npm 'xlsx' package
// would have been the obvious choice, but the version published there has
// known prototype-pollution advisories, and this service accepts uploads.
//
// Deliberately partial: no formulas (the cached value is used), no styles, no
// dates as dates (Excel stores them as numbers; callers that need dates can
// convert). Anything it cannot read, it says so rather than guessing.

const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_ENTRY_BYTES = 80 * 1024 * 1024;

// ── ZIP ──────────────────────────────────────────────────────────────────────

function findEndOfCentralDirectory(buf) {
  // The end-of-central-directory record is at the end, after an optional
  // comment of up to 64KB, so it is searched for backwards.
  const start = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function readEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('This file is not a spreadsheet (no ZIP directory found)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('This spreadsheet appears to be damaged');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readFile(buf, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error('That spreadsheet is too large to read');
  // The local header repeats the name and extra fields, with its own lengths.
  const nameLength = buf.readUInt16LE(entry.localOffset + 26);
  const extraLength = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
  throw new Error(`This spreadsheet uses an unsupported compression method (${entry.method})`);
}

// ── XML ──────────────────────────────────────────────────────────────────────

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    return XML_ENTITIES[code] ?? whole;
  });
}

// All the text inside one element, with tags stripped — which is what a shared
// string amounts to once its formatting runs are ignored.
function textOf(xml) {
  return decodeXml(xml.replace(/<[^>]*>/g, ''));
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g)].map((m) => (m[1] ? textOf(m[1]) : ''));
}

function columnToIndex(ref) {
  let index = 0;
  for (const ch of ref) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

// One array per row, cells in column order, gaps filled with ''.
//
// Rows are placed by their own r= number, not by the order they appear: a
// spreadsheet may leave a row out entirely, or write it self-closing when it
// is empty (`<row r="11" .../>`), and treating those as "not there" shifts
// every row after them — which is exactly how a supplier's template ends up
// filled in one row off.
function sheetRows(xml, strings) {
  const rows = [];
  // The attribute part is non-greedy and the self-closing form is matched
  // first: `[^>]*` would otherwise swallow the `/` of `<row r="11"/>` and run
  // on to the *next* row's closing tag, silently merging two rows.
  for (const rowMatch of xml.matchAll(/<row(\s[^>]*?)?\/>|<row(\s[^>]*?)?>([\s\S]*?)<\/row>/g)) {
    const attrs = rowMatch[1] ?? rowMatch[2] ?? '';
    const rowNumber = Number(/\br="(\d+)"/.exec(attrs)?.[1]);
    const inner = rowMatch[3] || '';
    const cells = [];
    for (const cellMatch of inner.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttrs = cellMatch[1];
      const cellInner = cellMatch[2] || '';
      const ref = /r="([A-Z]+)\d+"/.exec(cellAttrs)?.[1];
      const type = /t="([^"]+)"/.exec(cellAttrs)?.[1] || 'n';
      let value = '';
      if (type === 'inlineStr') {
        value = textOf(/<is>([\s\S]*?)<\/is>/.exec(cellInner)?.[1] || '');
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cellInner)?.[1];
        if (raw != null) value = type === 's' ? (strings[Number(raw)] ?? '') : decodeXml(raw);
      }
      const at = ref ? columnToIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    if (Number.isFinite(rowNumber) && rowNumber > 0) {
      while (rows.length < rowNumber - 1) rows.push([]);
      rows[rowNumber - 1] = cells;
    } else {
      rows.push(cells);
    }
  }
  return rows;
}

// ── public ───────────────────────────────────────────────────────────────────

// [{ name, rows: [[cell, ...], ...] }] in workbook order.
function readWorkbook(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = readEntries(buf);
  const workbook = readFile(buf, entries, 'xl/workbook.xml');
  if (!workbook) throw new Error('This file is not an Excel spreadsheet');
  const strings = sharedStrings(readFile(buf, entries, 'xl/sharedStrings.xml'));

  // Sheet order in workbook.xml is the order of the tabs; the relationship id
  // maps to the file, but sheetN.xml in order is the practical fallback.
  const rels = readFile(buf, entries, 'xl/_rels/workbook.xml.rels') || '';
  const relTargets = new Map();
  for (const m of rels.matchAll(/<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relTargets.set(m[1], m[2].replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }

  const sheets = [];
  let index = 0;
  for (const m of workbook.matchAll(/<sheet\s([^>]*)\/>/g)) {
    index += 1;
    const attrs = m[1];
    const name = decodeXml(/name="([^"]*)"/.exec(attrs)?.[1] || `Sheet${index}`);
    const relId = /r:id="([^"]+)"/.exec(attrs)?.[1];
    const target = (relId && relTargets.get(relId)) || `worksheets/sheet${index}.xml`;
    const xml = readFile(buf, entries, `xl/${target}`);
    if (!xml) continue;
    sheets.push({ name, rows: sheetRows(xml, strings) });
  }
  if (!sheets.length) throw new Error('That spreadsheet has no readable sheets');
  return sheets;
}

// Rows as objects keyed by the header row, which is the first row that has at
// least `minHeaders` non-empty cells — spreadsheets from suppliers routinely
// start with a title row or a blank line or two.
function rowsAsObjects(rows, { minHeaders = 3 } = {}) {
  const headerIndex = rows.findIndex((r) => r.filter((c) => String(c).trim()).length >= minHeaders);
  if (headerIndex < 0) return { headers: [], records: [] };
  const headers = rows[headerIndex].map((h) => String(h || '').trim());
  const records = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if (!row.some((c) => String(c ?? '').trim())) continue;
    const record = {};
    headers.forEach((h, i) => { if (h) record[h] = row[i] === undefined ? '' : String(row[i]).trim(); });
    records.push(record);
  }
  return { headers, records };
}

module.exports = { readWorkbook, rowsAsObjects };

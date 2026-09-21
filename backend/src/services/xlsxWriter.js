'use strict';

// Filling in a supplier's own spreadsheet template.
//
// Hero's ordering SOP says to send requests on their RFQ form, so the platform
// fills in that exact file rather than inventing a lookalike: their letterhead,
// their field order, their line numbering. That means opening the .xlsx,
// replacing the value of specific cells, and writing the ZIP back out with
// everything else — styles, print settings, branding — untouched.
//
// Values are written as inline strings, keeping each cell's original style, so
// no shared-string table has to be rebuilt.

const zlib = require('zlib');

// ── ZIP writing ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date (1 Jan 1980 is fine and stable)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(0, 38);          // external attributes
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// Reading the entries back out again (same format as xlsxReader, kept here so
// the writer can stand alone).
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That template is not a valid spreadsheet');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(start, start + compressedSize);
    files.push({ name, data: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// ── cell surgery ─────────────────────────────────────────────────────────────

const escapeXml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Excel refuses control characters outright
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const columnIndex = (ref) => [...ref].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

function cellXml(ref, value, style) {
  const styleAttr = style ? ` s="${style}"` : '';
  if (value === '' || value === null || value === undefined) return `<c r="${ref}"${styleAttr}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

// Replace (or insert) the given cells, keeping every other part of the sheet
// exactly as the supplier wrote it.
function setCells(sheetXml, values) {
  let xml = sheetXml;
  const byRow = new Map();
  for (const [ref, value] of Object.entries(values)) {
    const match = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!match) throw new Error(`Not a cell reference: ${ref}`);
    const rowNo = Number(match[2]);
    if (!byRow.has(rowNo)) byRow.set(rowNo, []);
    byRow.get(rowNo).push({ ref, column: match[1], value });
  }

  for (const [rowNo, cells] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    // Self-closing first, and non-greedy attributes: `[^>]*` swallows the `/`
    // of `<row r="11"/>` and then matches to the next row's `</row>`, which
    // quietly deletes a row of the supplier's form.
    const rowPattern = new RegExp(`<row([^>]*?\\br="${rowNo}"[^>]*?)/>|<row([^>]*?\\br="${rowNo}"[^>]*?)>([\\s\\S]*?)</row>`);
    const rowMatch = rowPattern.exec(xml);
    let rowAttrs = ` r="${rowNo}"`;
    let body = '';
    if (rowMatch) {
      rowAttrs = rowMatch[1] ?? rowMatch[2] ?? rowAttrs;
      body = rowMatch[3] || '';
    }

    for (const { ref, column, value } of cells) {
      const cellPattern = new RegExp(`<c\\s[^>]*\\br="${ref}"[^>]*(?:/>|>[\\s\\S]*?</c>)`);
      const existing = cellPattern.exec(body);
      const style = existing ? /\bs="(\d+)"/.exec(existing[0])?.[1] : null;
      const replacement = cellXml(ref, value, style);
      if (existing) {
        body = body.slice(0, existing.index) + replacement + body.slice(existing.index + existing[0].length);
      } else {
        // Insert in column order — Excel will not open a row whose cells are
        // out of order.
        const cellsInRow = [...body.matchAll(/<c\s[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)];
        const after = cellsInRow.find((c) => columnIndex(c[1]) > columnIndex(column));
        if (after) body = body.slice(0, after.index) + replacement + body.slice(after.index);
        else body += replacement;
      }
    }

    const rowXml = `<row${rowAttrs}>${body}</row>`;
    if (rowMatch) {
      xml = xml.slice(0, rowMatch.index) + rowXml + xml.slice(rowMatch.index + rowMatch[0].length);
    } else {
      // A row the template doesn't have yet goes before the next row along.
      const rows = [...xml.matchAll(/<row[^>]*?\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)];
      const after = rows.find((r) => Number(r[1]) > rowNo);
      if (after) xml = xml.slice(0, after.index) + rowXml + xml.slice(after.index);
      else xml = xml.replace('</sheetData>', `${rowXml}</sheetData>`);
    }
  }
  return xml;
}

// Fill a template and return the finished workbook.
function fillTemplate(templateBuffer, values, { sheetPath = 'xl/worksheets/sheet1.xml' } = {}) {
  const files = unzip(Buffer.isBuffer(templateBuffer) ? templateBuffer : Buffer.from(templateBuffer));
  const sheet = files.find((f) => f.name === sheetPath);
  if (!sheet) throw new Error(`That template has no ${sheetPath}`);
  sheet.data = Buffer.from(setCells(sheet.data.toString('utf8'), values), 'utf8');
  return zip(files);
}

module.exports = { fillTemplate, setCells, zip, unzip, crc32 };

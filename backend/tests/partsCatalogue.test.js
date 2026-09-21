import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, authHeader } from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const { readWorkbook, rowsAsObjects } = require('../src/services/xlsxReader.js');
const { fillTemplate, zip } = require('../src/services/xlsxWriter.js');
const { parseWorkbook, importParts, searchParts } = require('../src/services/partsImport.js');
const app = buildApp();

// Build a small .xlsx in memory so the reader and writer are tested against a
// real file rather than a mock of one.
function makeWorkbook(sheets) {
  const sheetXml = (rows) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rows.map((cells, r) => {
      if (cells === null) return `<row r="${r + 1}"/>`; // an empty, self-closing row
      const body = cells.map((value, c) => value === '' ? '' :
        `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('');
      return `<row r="${r + 1}">${body}</row>`;
    }).join('')}</sheetData></worksheet>`;

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0"?><Relationships>${
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`) },
  ];
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows)) }));
  return zip(files);
}

describe('reading a spreadsheet', () => {
  it('reads sheets, names and cells', () => {
    const book = makeWorkbook([{ name: 'Parts', rows: [['Part Code', 'Description'], ['12311AAM300S', 'COVER, CYLINDER HEAD']] }]);
    const sheets = readWorkbook(book);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Parts');
    expect(sheets[0].rows[1]).toEqual(['12311AAM300S', 'COVER, CYLINDER HEAD']);
  });

  // An empty row is written self-closing. Treating it as absent shifts every
  // row after it — which is how a supplier's form gets filled in one row off.
  it('keeps empty rows in place', () => {
    const book = makeWorkbook([{ name: 'Sheet1', rows: [['Header'], null, ['After the gap']] }]);
    const rows = readWorkbook(book)[0].rows;
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual([]);
    expect(rows[2]).toEqual(['After the gap']);
  });

  it('finds the header row even when the sheet starts with titles and blanks', () => {
    const book = makeWorkbook([{ name: 'Parts', rows: [['DEALER PARTS LIST'], null, ['Part Code', 'Description', 'Price'], ['A1', 'Widget', '10']] }]);
    const { headers, records } = rowsAsObjects(readWorkbook(book)[0].rows);
    expect(headers).toEqual(['Part Code', 'Description', 'Price']);
    expect(records).toEqual([{ 'Part Code': 'A1', Description: 'Widget', Price: '10' }]);
  });

  it('refuses a file that isn\'t a spreadsheet', () => {
    expect(() => readWorkbook(Buffer.from('this is a PDF, honestly'))).toThrow(/not a spreadsheet/i);
  });
});

describe('filling in a supplier template', () => {
  const template = () => makeWorkbook([{ name: 'RFQ', rows: [['Hero South Africa', '', 'Date'], null, ['Line', 'Part Number', 'Qty']] }]);

  it('writes values into the cells asked for, leaving the rest alone', () => {
    const filled = fillTemplate(template(), { C1: '2026-09-21', B4: '20K910S', C4: 3 });
    const rows = readWorkbook(filled)[0].rows;
    expect(rows[0]).toEqual(['Hero South Africa', '', '2026-09-21']);
    expect(rows[2]).toEqual(['Line', 'Part Number', 'Qty']); // header untouched
    expect(rows[3][1]).toBe('20K910S');
    expect(rows[3][2]).toBe('3');
  });

  it('adds rows past the end of the template, for an order longer than the form', () => {
    const filled = fillTemplate(template(), { B41: 'K06431KTNA701S', C41: 2 });
    expect(readWorkbook(filled)[0].rows[40][1]).toBe('K06431KTNA701S');
  });

  it('escapes what would otherwise break the file', () => {
    const filled = fillTemplate(template(), { B4: 'BOLT & WASHER <6mm>' });
    expect(readWorkbook(filled)[0].rows[3][1]).toBe('BOLT & WASHER <6mm>');
  });
});

describe('reading a dealer parts list', () => {
  const list = () => makeWorkbook([
    {
      name: 'Parts',
      rows: [
        null,
        ['Part Code', 'MODEL', 'GROUP NO.', 'GROUP DESC', 'SEQUENCE NO.', 'PART DESCRIPTION', 'STATUS', 'SUPERCEDENCE (OLD PART)', 'ALTERNATE PART NO', 'Recommended Retail Price (Ex VAT)'],
        ['12311AAM300S', 'ECO 150 (Dec, 2019)', 'E-1', 'CYLINDER HEAD COVER', '1', 'COVER, CYLINDER HEAD', 'REGULAR', '', '', '314.82000000000005'],
        ['90463KRM840S', 'ECO 150 (Dec, 2019)', 'E-1', 'CYLINDER HEAD COVER', '5', 'WASHER SEALING 6.2 MM', 'REGULAR', '90463-ML7-000', '', '2.97'],
        ['', '', '', '', '', '', '', '', '', ''],
      ],
    },
    {
      name: 'Kits',
      rows: [
        ['S NO.', 'PART NO', 'PART DESCRIPTION', 'PART STATUS', 'SUPERCEDENCE', 'Retail Price (Ex VAT)'],
        ['1', '20K910S', 'CHAIN SPROCKET KIT (ACHIEVER)', 'REGULAR', '-', '313.33500000000004'],
      ],
    },
  ]);

  it('reads both sheets, marks the kits, and tidies the prices', () => {
    const parsed = parseWorkbook(list(), { make: 'Hero', model: 'Eco 150' });
    expect(parsed.parts).toHaveLength(3);
    const cover = parsed.parts.find((p) => p.part_number === '12311AAM300S');
    expect(cover).toMatchObject({ description: 'COVER, CYLINDER HEAD', group_name: 'CYLINDER HEAD COVER', price_ex_vat: 314.82, is_kit: false });
    const kit = parsed.parts.find((p) => p.is_kit);
    expect(kit).toMatchObject({ part_number: '20K910S', price_ex_vat: 313.34 });
    expect(parsed.parts.find((p) => p.part_number === '90463KRM840S').supersedes).toBe('90463-ML7-000');
  });

  // The list says "ECO 150 (Dec, 2019)" on one sheet and nothing on the other;
  // the bikes say "Eco 150". A catalogue that doesn't match the bikes is
  // unsearchable from a job card.
  it('files everything under the model chosen at import', () => {
    const parsed = parseWorkbook(list(), { make: 'Hero', model: 'Eco 150' });
    expect([...new Set(parsed.parts.map((p) => p.model))]).toEqual(['Eco 150']);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the parts catalogue', () => {
  let admin;
  const list = () => makeWorkbook([{
    name: 'Parts',
    rows: [
      ['Part Code', 'PART DESCRIPTION', 'GROUP DESC', 'STATUS', 'SUPERCEDENCE (OLD PART)', 'Recommended Retail Price (Ex VAT)'],
      ['12391AAK900S', 'GASKET HEAD COVER', 'CYLINDER HEAD COVER', 'REGULAR', '12391-KRM-840', '29.70'],
      ['K06431KTNA701S', 'KIT, BRAKE SHOE', 'KITS', 'REGULAR', '', '115.34'],
    ],
  }]);

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
  });

  const upload = (fields = {}) => {
    const req = request(app).post('/api/admin/parts-catalog/import').set(authHeader(admin))
      .field('make', fields.make ?? 'Hero').field('model', fields.model ?? 'Eco 150');
    if (fields.preview) req.field('preview', '1');
    return req.attach('file', list(), 'Dealer Parts List ECO 150.xlsx');
  };

  it('imports a list, and re-importing updates rather than duplicates', async () => {
    const first = await upload();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ added: 2, updated: 0 });

    const again = await upload();
    expect(again.body).toMatchObject({ added: 0, updated: 2 });
    const { rows } = await pgDb.query('SELECT COUNT(*)::int AS n FROM parts_catalog');
    expect(rows[0].n).toBe(2);
  });

  it('previews without writing anything', async () => {
    const res = await upload({ preview: true });
    expect(res.body).toMatchObject({ preview: true, total: 2 });
    expect((await pgDb.query('SELECT COUNT(*)::int AS n FROM parts_catalog')).rows[0].n).toBe(0);
  });

  it('asks which bike the list is for', async () => {
    const res = await request(app).post('/api/admin/parts-catalog/import').set(authHeader(admin))
      .field('make', '').attach('file', list(), 'list.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/make and model/i);
  });

  it('rejects a file that is not a spreadsheet', async () => {
    const res = await request(app).post('/api/admin/parts-catalog/import').set(authHeader(admin))
      .field('make', 'Hero').field('model', 'Eco 150')
      .attach('file', Buffer.from('%PDF-1.4 not a spreadsheet'), 'list.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/spreadsheet/i);
  });

  describe('searching', () => {
    beforeEach(async () => { await upload(); });

    it('finds a part by description', async () => {
      const { results } = await searchParts({ q: 'gasket' });
      expect(results.map((r) => r.part_number)).toEqual(['12391AAK900S']);
      expect(Number(results[0].price_ex_vat)).toBe(29.70);
    });

    // The number on the part in a technician's hand may carry dashes, or be
    // the old number the new part replaced.
    it('finds a part however the number is written, including the old one', async () => {
      for (const q of ['12391AAK900S', '12391aak900s', '12391-AAK-900-S', '12391 AAK 900 S', '12391-KRM-840']) {
        const { results } = await searchParts({ q });
        expect(results.map((r) => r.part_number), q).toContain('12391AAK900S');
      }
    });

    it('puts an exact part number first', async () => {
      const { results } = await searchParts({ q: 'K06431KTNA701S' });
      expect(results[0].part_number).toBe('K06431KTNA701S');
    });

    it('says nothing on a one-letter search rather than returning the catalogue', async () => {
      expect((await searchParts({ q: 'g' })).results).toEqual([]);
    });

    it('is reachable from the admin portal with a total for paging', async () => {
      const res = await request(app).get('/api/admin/parts-catalog?q=kit').set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.results[0].description).toBe('KIT, BRAKE SHOE');
    });

    it('lists the models it holds', async () => {
      const res = await request(app).get('/api/admin/parts-catalog/models').set(authHeader(admin));
      expect(res.body[0]).toMatchObject({ make: 'Hero', model: 'Eco 150', parts: 2, priced: 2 });
    });
  });
});

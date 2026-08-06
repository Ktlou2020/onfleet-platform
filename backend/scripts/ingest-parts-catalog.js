#!/usr/bin/env node
// Ingests a manufacturer parts-catalogue PDF (diagram + table page pairs,
// content rasterized rather than real text — hence OCR, not pdftotext) into
// the parts_catalog table, plus renders each group's exploded-diagram page
// as an image the workshop UI can show alongside search results.
//
// Usage: node scripts/ingest-parts-catalog.js <pdf-path> <make> <model>
//
// Requires poppler-utils (pdfinfo, pdfimages, pdftoppm) and tesseract on PATH.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const pgDb = require('../src/pgDb');
const UPLOAD_DIRS = require('../src/uploadPaths');

const [, , pdfPath, make, model] = process.argv;
if (!pdfPath || !make || !model) {
  console.error('Usage: node ingest-parts-catalog.js <pdf-path> <make> <model>');
  process.exit(1);
}
if (!fs.existsSync(pdfPath)) {
  console.error(`PDF not found: ${pdfPath}`);
  process.exit(1);
}

const modelSlug = `${make}-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const outDir = path.join(UPLOAD_DIRS.partsCatalog, modelSlug);
fs.mkdirSync(outDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-catalog-'));

function sh(cmd, args) {
  return execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 100 }).toString();
}

function getTotalPages() {
  const out = sh('pdfinfo', [pdfPath]);
  const m = out.match(/Pages:\s+(\d+)/);
  if (!m) throw new Error('Could not read page count from pdfinfo');
  return Number(m[1]);
}

// Every page in this catalogue is rasterized (Print-to-PDF output, no real
// text layer) — but diagram pages embed 2 JPEGs and table pages embed none,
// which is a free, OCR-free way to tell them apart.
function getDiagramPages() {
  const out = sh('pdfimages', ['-list', pdfPath]);
  const pages = new Set();
  out.split('\n').slice(2).forEach((line) => {
    const m = line.trim().match(/^(\d+)\s/);
    if (m) pages.add(Number(m[1]));
  });
  return [...pages].sort((a, b) => a - b);
}

// Renders one page to a PNG and rotates it upright (source pages are
// portrait A4 with the actual content laid out rotated 90°).
function renderPageUpright(pageNum, outPngPath) {
  const prefix = path.join(tmpDir, `render-${pageNum}-${Date.now()}`);
  sh('pdftoppm', ['-png', '-f', String(pageNum), '-l', String(pageNum), '-r', '300', pdfPath, prefix]);
  const base = path.basename(prefix);
  const produced = fs.readdirSync(tmpDir).find((f) => f.startsWith(base));
  if (!produced) throw new Error(`pdftoppm produced no output for page ${pageNum}`);
  const producedPath = path.join(tmpDir, produced);
  sh('sips', ['-r', '90', producedPath, '--out', outPngPath]);
  fs.unlinkSync(producedPath);
}

function ocrPage(pngPath) {
  return sh('tesseract', [pngPath, 'stdout', '--psm', '6']);
}

// A real OEM part number in this catalogue: alnum groups joined by hyphens,
// e.g. "12311-AAM-300", "(90003-KFG-000" (OCR sometimes mistakes a table
// border for a stray leading paren). Used to tell "part number" tokens
// apart from "description" tokens (which are plain words, even though both
// are all-caps in this catalogue so case isn't a usable signal).
const PART_TOKEN = /^\(?[\dA-Z]+(?:-[\dA-Z]+)+\)?$/;

function parseTablePageText(text, knownGroupCode) {
  const lines = text.split('\n').map((l) => l.trim());
  let groupCode = knownGroupCode || null;
  let groupName = null;
  const rows = [];

  for (const line of lines) {
    if (!line) continue;

    if (!groupName) {
      const titleMatch = line.match(/^([A-Z]{1,2}-?\d+[A-Z]?)\s*:\s*(.+)$/);
      if (titleMatch && !/^group number/i.test(line)) {
        groupCode = titleMatch[1].trim();
        groupName = titleMatch[2].trim().toUpperCase();
        continue;
      }
    }
    const groupNumMatch = line.match(/group\s*number\s*:?\s*([A-Z]{1,2}-?\d+[A-Z]?)/i);
    if (groupNumMatch) { groupCode = groupNumMatch[1].trim(); continue; }

    if (/^ref\b/i.test(line)) continue;
    if (/^model\b/i.test(line)) continue;
    if (/^\d{1,3}$/.test(line)) continue; // stray page-number-only line

    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;

    let idx = 0;
    let refNo = null;
    if (/^\d{1,2}$/.test(tokens[0]) && tokens.length >= 3) {
      refNo = tokens[0];
      idx = 1;
    }

    const partTokens = [];
    while (idx < tokens.length) {
      const t = tokens[idx];
      if (PART_TOKEN.test(t)) { partTokens.push(t); idx++; continue; }
      // OCR sometimes splits a part number across a stray space, e.g.
      // "9600" + "1-06012-00" instead of "96001-06012-00" — glue a leading
      // bare digit fragment onto the part-token that immediately follows it.
      if (partTokens.length === 0 && /^\d{2,5}$/.test(t) && idx + 1 < tokens.length && PART_TOKEN.test(tokens[idx + 1])) {
        partTokens.push(t); idx++; continue;
      }
      break;
    }
    if (!partTokens.length) continue;
    const partNumber = partTokens.join('').replace(/[()]/g, '').toUpperCase();

    if (idx >= tokens.length) continue;
    const last = tokens[tokens.length - 1];
    if (!/^\d{1,3}$/.test(last)) continue; // no trailing Req. qty — not a data row
    const qty = Number(last);

    const description = tokens.slice(idx, tokens.length - 1).join(' ').trim();
    if (!description) continue;

    rows.push({ refNo, partNumber, description, qty });
  }

  return { groupCode, groupName, rows };
}

async function insertRows(rows) {
  const cols = ['make', 'model', 'group_code', 'group_name', 'ref_no', 'part_number', 'description', 'remark', 'qty_required', 'diagram_image_path'];
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = batch.map((r, rowIdx) => {
      const offset = rowIdx * cols.length;
      cols.forEach((c) => values.push(r[c] ?? null));
      return `(${cols.map((_, colIdx) => `$${offset + colIdx + 1}`).join(',')})`;
    }).join(',');
    await pgDb.query(`INSERT INTO parts_catalog (${cols.join(',')}) VALUES ${placeholders}`, values);
  }
}

async function main() {
  const totalPages = getTotalPages();
  const diagramPages = getDiagramPages();
  console.log(`Total pages: ${totalPages}, diagram pages: ${diagramPages.length}`);

  const groups = diagramPages.map((diagramPage, i) => {
    const nextDiagramPage = diagramPages[i + 1] || (totalPages + 1);
    const tablePages = [];
    for (let p = diagramPage + 1; p < nextDiagramPage; p++) tablePages.push(p);
    return { diagramPage, tablePages };
  });
  console.log(`${groups.length} candidate groups (diagram page + following table page(s))`);

  const allRows = [];
  const failed = [];
  let ok = 0;

  for (const [i, group] of groups.entries()) {
    try {
      if (!group.tablePages.length) {
        failed.push({ diagramPage: group.diagramPage, reason: 'no table pages followed this diagram page' });
        continue;
      }
      let groupCode = null, groupName = null;
      const allGroupRows = [];
      for (const tp of group.tablePages) {
        const png = path.join(tmpDir, `table-${tp}.png`);
        renderPageUpright(tp, png);
        const text = ocrPage(png);
        const parsed = parseTablePageText(text, groupCode);
        if (parsed.groupCode) groupCode = parsed.groupCode;
        if (parsed.groupName) groupName = parsed.groupName;
        allGroupRows.push(...parsed.rows);
        fs.unlinkSync(png);
      }

      if (!groupCode || !allGroupRows.length) {
        failed.push({ diagramPage: group.diagramPage, tablePages: group.tablePages, reason: 'no group code or no rows parsed', groupCode, rowCount: allGroupRows.length });
        continue;
      }

      const safeCode = groupCode.replace(/[^A-Za-z0-9-]/g, '_');
      const diagramOut = path.join(outDir, `${safeCode}.png`);
      renderPageUpright(group.diagramPage, diagramOut);
      const diagramPublicPath = `/uploads/parts-catalog/${modelSlug}/${safeCode}.png`;

      for (const row of allGroupRows) {
        allRows.push({
          make, model,
          group_code: groupCode,
          group_name: groupName || groupCode,
          ref_no: row.refNo,
          part_number: row.partNumber,
          description: row.description,
          remark: null,
          qty_required: row.qty,
          diagram_image_path: diagramPublicPath,
        });
      }
      ok++;
      console.log(`[${i + 1}/${groups.length}] ${groupCode} — ${groupName} (${allGroupRows.length} rows, ${group.tablePages.length} table page(s))`);
    } catch (err) {
      failed.push({ diagramPage: group.diagramPage, reason: err.message });
    }
  }

  console.log(`\nParsed ${ok}/${groups.length} groups, ${allRows.length} total part rows`);
  if (failed.length) {
    console.log(`${failed.length} groups failed or were skipped:`);
    failed.forEach((f) => console.log('  -', JSON.stringify(f)));
  }

  if (allRows.length) {
    await pgDb.query('DELETE FROM parts_catalog WHERE make = $1 AND model = $2', [make, model]);
    await insertRows(allRows);
    console.log(`Inserted ${allRows.length} rows into parts_catalog for ${make} ${model}.`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});

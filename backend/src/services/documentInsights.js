const fs = require('fs');
let pdfParse = null;
let Tesseract = null;

try { pdfParse = require('pdf-parse'); } catch (_) {}
try { Tesseract = require('tesseract.js'); } catch (_) {}

function normalizeAmount(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return null;
  const normalized = cleaned.includes(',') && cleaned.includes('.')
    ? cleaned.replace(/,/g, '')
    : cleaned.replace(/,/g, '.');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? +value.toFixed(2) : null;
}

function extractAmountCandidates(text = '') {
  const patterns = [
    /(?:total\s+paid|net\s+pay|netpay|nett\s+pay|amount\s+paid|take\s+home|salary\s+paid|total\s+earnings?)\D{0,25}(?:R|ZAR)?\s*([\d\s,.]{3,})/gi,
    /(?:R|ZAR)\s*([\d\s,.]{3,})/gi
  ];
  const values = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const amount = normalizeAmount(match[1]);
      if (amount && amount > 0) values.push(amount);
    }
  }
  return [...new Set(values)].sort((a, b) => b - a);
}

async function readDocumentText(filePath, mimeType = '') {
  if (mimeType.includes('pdf') && pdfParse) {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || '';
  }
  if (mimeType.startsWith('image/') && Tesseract) {
    try {
      const size = fs.statSync(filePath).size;
      if (size < 1024) return '';
      const result = await Tesseract.recognize(filePath, 'eng');
      return result?.data?.text || '';
    } catch (_) {
      return '';
    }
  }
  return '';
}

function isoDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const slashMatch = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (slashMatch) {
    const [, dd, mm, yy] = slashMatch;
    const year = yy.length === 2 ? `20${yy}` : yy;
    return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  const monthWords = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', sept: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12'
  };

  const wordMatch = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/) || raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (wordMatch) {
    const isMonthFirst = Number.isNaN(Number(wordMatch[1]));
    const day = isMonthFirst ? wordMatch[2] : wordMatch[1];
    const monthName = (isMonthFirst ? wordMatch[1] : wordMatch[2]).toLowerCase();
    const year = wordMatch[3];
    const month = monthWords[monthName];
    if (month) return `${year}-${month}-${String(day).padStart(2, '0')}`;
  }

  return null;
}

function normalizeLicenseDiscNo(value) {
  if (!value) return null;
  const cleaned = String(value).toUpperCase().replace(/[^A-Z0-9\-\/]/g, '').trim();
  return cleaned.length >= 4 ? cleaned : null;
}

function extractLicenseDiscFields(text = '') {
  const compactText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compactText) return { license_disc_no: null, license_disc_expiry: null };

  const discPatterns = [
    /(?:licen[cs]e\s*disc(?:\s*(?:no|number|nr))?|disc(?:\s*(?:no|number|nr))?)\D{0,12}([A-Z0-9\-/]{4,30})/i,
    /(?:disc\s*serial|serial\s*no)\D{0,12}([A-Z0-9\-/]{4,30})/i
  ];
  let licenseDiscNo = null;
  for (const pattern of discPatterns) {
    const match = compactText.match(pattern);
    if (match?.[1]) {
      licenseDiscNo = normalizeLicenseDiscNo(match[1]);
      if (licenseDiscNo) break;
    }
  }

  const expiryPatterns = [
    /(?:expiry|expires|exp\.?\s*date|valid\s*until|renewal\s*date)\D{0,20}(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /(?:licen[cs]e\s*disc)\D{0,40}(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i
  ];
  let licenseDiscExpiry = null;
  for (const pattern of expiryPatterns) {
    const match = compactText.match(pattern);
    if (match?.[1]) {
      licenseDiscExpiry = isoDate(match[1]);
      if (licenseDiscExpiry) break;
    }
  }

  return {
    license_disc_no: licenseDiscNo,
    license_disc_expiry: licenseDiscExpiry
  };
}

async function extractPayslipInsights(filePath, mimeType) {
  try {
    const text = await readDocumentText(filePath, mimeType);
    const amounts = extractAmountCandidates(text);
    return {
      extracted_text: text ? text.slice(0, 4000) : null,
      extracted_amount: amounts[0] || null
    };
  } catch (error) {
    return { extracted_text: null, extracted_amount: null, extraction_error: error.message };
  }
}

async function extractLicenseDiscInsights(filePath, mimeType) {
  try {
    const text = await readDocumentText(filePath, mimeType);
    const fields = extractLicenseDiscFields(text);
    return {
      extracted_text: text ? text.slice(0, 4000) : null,
      ...fields
    };
  } catch (error) {
    return {
      extracted_text: null,
      license_disc_no: null,
      license_disc_expiry: null,
      extraction_error: error.message
    };
  }
}

module.exports = {
  extractPayslipInsights,
  extractLicenseDiscInsights,
  normalizeLicenseDiscNo,
  extractLicenseDiscFields
};

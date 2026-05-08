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

module.exports = { extractPayslipInsights };

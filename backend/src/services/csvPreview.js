function splitCsvLine(line = '') {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  values.push(current);
  return values;
}

function escapeCsvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { headers: [], rows: [] };

  const headers = splitCsvLine(lines.shift()).map((header) => header.trim());
  const rows = lines.map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = (values[index] || '').trim();
    });
    return row;
  });

  return { headers, rows };
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const IMPORT_CONFIGS = {
  riders: {
    title: 'Riders CSV',
    expected_fields: [
      { key: 'Full Name', label: 'Full name', required: true, aliases: ['Driver', 'Rider Name', 'Name'] },
      { key: 'Mobile Phone', label: 'Mobile phone', required: false, aliases: ['Phone', 'Phone Number', 'Cellphone'] },
      { key: 'Email', label: 'Email', required: false, aliases: ['email', 'Email Address'] },
      { key: 'ID/Passport Number', label: 'ID / passport number', required: false, aliases: ['ID Number', 'ID/Passport/Asylum'] },
      { key: 'Address', label: 'Address', required: false, aliases: ['Street Address'] },
      { key: 'Province', label: 'Province', required: false, aliases: ['Which Province Are Located In?'] },
      { key: 'Which Country Are You From?', label: 'Country of origin', required: false, aliases: ['Country', 'Country of Origin'] },
      { key: 'Profile Picture', label: 'Profile picture', required: false, aliases: ['Selfie', 'Avatar'] },
      { key: 'Status', label: 'Account status', required: false, aliases: ['User Status'] },
      { key: 'Which Platform Do You Use?', label: 'Delivery platforms', required: false, aliases: ['My Fleet', 'Platform'] },
      { key: 'Bank Name', label: 'Bank name', required: false, aliases: [] },
      { key: 'Account Number', label: 'Account number', required: false, aliases: [] },
      { key: 'eWallet Number', label: 'E-wallet number', required: false, aliases: ['eWallet', 'Ewallet Number'] },
      { key: 'Application Status', label: 'Application status', required: false, aliases: [] },
      { key: 'Proof of Address', label: 'Proof of address', required: false, aliases: [] },
      { key: 'Upload Copy/Image of ID or passport', label: 'ID document file', required: false, aliases: ['ID Document', 'ID File'] },
      { key: 'Upload Valid License', label: 'Driver licence file', required: false, aliases: ['Driver License', 'License File'] },
      { key: 'Upload 3 Months Bank Statement', label: 'Bank statement file', required: false, aliases: [] },
      { key: 'Upload Bank Confirmation Letter', label: 'Bank confirmation file', required: false, aliases: [] },
      { key: 'Payslip 1 File', label: 'Payslip 1 file', required: false, aliases: ['Payslip1 File'] },
      { key: 'Payslip 2 File', label: 'Payslip 2 file', required: false, aliases: ['Payslip2 File'] },
      { key: 'Payslip 3 File', label: 'Payslip 3 file', required: false, aliases: ['Payslip3 File'] },
      { key: 'Pay 1', label: 'Payslip 1 amount', required: false, aliases: ['Payment 1'] },
      { key: 'Pay 2', label: 'Payslip 2 amount', required: false, aliases: ['Payment 2'] },
      { key: 'Pay 3', label: 'Payslip 3 amount', required: false, aliases: ['Payment 3'] }
    ]
  },
  bikes: {
    title: 'Bikes CSV',
    expected_fields: [
      { key: 'VIN', label: 'VIN', required: false, aliases: ['vin'] },
      { key: 'Vehicle Reg', label: 'Registration', required: false, aliases: ['Bike Registration', 'registration', 'Bike'] },
      { key: 'Make', label: 'Make', required: false, aliases: [] },
      { key: 'Model', label: 'Model', required: false, aliases: [] },
      { key: 'Year Model', label: 'Year model', required: false, aliases: ['Year'] },
      { key: 'Colour', label: 'Colour', required: false, aliases: ['Color'] },
      { key: 'Payment to be collected', label: 'Weekly rental', required: false, aliases: ['Weekly Rental'] },
      { key: 'Number of Months Remaining', label: 'Months remaining', required: false, aliases: [] },
      { key: 'STATUS', label: 'Fleet status', required: false, aliases: ['Status'] },
      { key: 'Driver', label: 'Allocated rider', required: false, aliases: ['Rider'] },
      { key: 'Fleet', label: 'Fleet', required: false, aliases: [] },
      { key: 'Certificate of Registration', label: 'RC1 url', required: false, aliases: ['RC1'] },
      { key: 'License disc', label: 'License disc url', required: false, aliases: ['Licence disc'] },
      { key: 'Date of bike hand over', label: 'Handover date', required: false, aliases: [] },
      { key: 'Outstanding Balance', label: 'Outstanding balance', required: false, aliases: [] }
    ]
  },
  agreements: {
    title: 'Agreements CSV',
    expected_fields: [
      { key: 'Driver', label: 'Rider name', required: true, aliases: ['Full Name', 'Rider'] },
      { key: 'Vehicle Reg', label: 'Registration', required: false, aliases: ['Bike Registration', 'Bike'] },
      { key: 'VIN', label: 'VIN', required: false, aliases: ['vin'] },
      { key: 'Payment to be collected', label: 'Weekly rental', required: false, aliases: ['Weekly Rental'] },
      { key: 'Total Received From Flexclub', label: 'Total received', required: false, aliases: ['Total Received'] },
      { key: 'Outstanding Balance', label: 'Outstanding balance', required: false, aliases: [] },
      { key: 'Date of bike hand over', label: 'Handover date', required: false, aliases: ['Date Taken'] },
      { key: 'Date Taken', label: 'Date taken', required: false, aliases: [] },
      { key: 'Date Created', label: 'Date created', required: false, aliases: [] },
      { key: 'STATUS', label: 'Agreement status', required: false, aliases: ['Status'] }
    ]
  },
  payments: {
    title: 'Payments CSV',
    expected_fields: [
      { key: 'agreement_no', label: 'Agreement number', required: true, aliases: ['Agreement No', 'agreement number'] },
      { key: 'agreement_id', label: 'Agreement ID', required: false, aliases: ['Agreement Id'] },
      { key: 'amount', label: 'Amount', required: true, aliases: ['Amount Collected'] },
      { key: 'method', label: 'Payment method', required: false, aliases: ['Method'] },
      { key: 'reference', label: 'Reference', required: false, aliases: ['Bike and Date'] },
      { key: 'paid_at', label: 'Paid at', required: false, aliases: ['Date Created', 'Paid At'] },
      { key: 'notes', label: 'Notes', required: false, aliases: ['Comment'] }
    ]
  },
  special_tag_users: {
    title: 'Special tag users CSV',
    expected_fields: [
      { key: 'Email', label: 'Email', required: true, aliases: ['email', 'Email Address', 'email_address'] }
    ]
  }
};

function getImportConfig(importType) {
  const key = importType === 'payments_bulk' ? 'payments' : importType;
  return IMPORT_CONFIGS[key];
}

function buildSuggestedMapping(headers, expectedFields) {
  const byNormalized = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const mapping = {};

  for (const field of expectedFields) {
    const candidates = [field.key, ...(field.aliases || [])];
    const match = candidates.map(normalizeHeader).find((candidate) => byNormalized.has(candidate));
    if (match) mapping[field.key] = byNormalized.get(match);
  }

  return mapping;
}

function validateMapping(expectedFields, mapping = {}) {
  const duplicates = [];
  const sourceUsage = {};

  for (const [target, source] of Object.entries(mapping)) {
    if (!source) continue;
    sourceUsage[source] = sourceUsage[source] || [];
    sourceUsage[source].push(target);
  }

  Object.entries(sourceUsage).forEach(([source, targets]) => {
    if (targets.length > 1) duplicates.push({ source, targets });
  });

  const missingRequired = expectedFields.filter((field) => field.required && !mapping[field.key]);
  return { missingRequired, duplicates };
}

function previewImportCsv(buffer, importType) {
  const config = getImportConfig(importType);
  if (!config) throw new Error('Unsupported import type');

  const { headers, rows } = parseCsvBuffer(buffer);
  const suggested_mapping = buildSuggestedMapping(headers, config.expected_fields);
  const validation = validateMapping(config.expected_fields, suggested_mapping);
  const sample_rows = rows.slice(0, 5);
  const mapped_preview = sample_rows.map((row) => {
    const next = {};
    config.expected_fields.forEach((field) => {
      next[field.key] = suggested_mapping[field.key] ? row[suggested_mapping[field.key]] || '' : '';
    });
    return next;
  });

  return {
    import_type: importType,
    title: config.title,
    headers,
    total_rows: rows.length,
    expected_fields: config.expected_fields,
    suggested_mapping,
    sample_rows,
    mapped_preview,
    warnings: {
      missing_required: validation.missingRequired.map((field) => field.key),
      duplicate_sources: validation.duplicates
    }
  };
}

function applyCsvMapping(buffer, importType, mappingInput = {}) {
  const config = getImportConfig(importType);
  if (!config) throw new Error('Unsupported import type');

  const { rows } = parseCsvBuffer(buffer);
  const mapping = {};
  config.expected_fields.forEach((field) => {
    mapping[field.key] = mappingInput[field.key] || '';
  });

  const validation = validateMapping(config.expected_fields, mapping);
  if (validation.missingRequired.length) {
    throw new Error(`Missing required mapping: ${validation.missingRequired.map((field) => field.label || field.key).join(', ')}`);
  }
  if (validation.duplicates.length) {
    throw new Error(`Each CSV column can only be mapped once. Duplicates: ${validation.duplicates.map((item) => `${item.source} → ${item.targets.join(', ')}`).join(' · ')}`);
  }

  const headers = config.expected_fields.map((field) => field.key);
  const csv = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(mapping[header] ? row[mapping[header]] || '' : '')).join(','))
  ].join('\n');

  return Buffer.from(csv, 'utf8');
}

module.exports = {
  IMPORT_CONFIGS,
  previewImportCsv,
  applyCsvMapping,
  parseCsvBuffer
};

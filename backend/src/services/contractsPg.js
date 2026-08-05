'use strict';

// Postgres equivalent of services/contracts.js's DB-touching functions.
// Pure template/filename functions are reused directly from contracts.js
// (exported there specifically for this file to import).

const fs = require('fs');
const path = require('path');
const pgDb = require('../pgDb');
const { contracts: contractDir } = require('../uploadPaths');
const {
  buildContractFilename,
  buildContractAbsolutePath,
  parseContractFilename,
  safeAgreementNo,
  rentToOwnContractTemplate,
  publicPath,
  writeContractSnapshot
} = require('./contracts');

async function getAgreementContractContext(agreementId) {
  const { rows } = await pgDb.query(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin,
      b.year, b.engine_cc, b.color,
      b.last_known_lat, b.last_known_lng, b.last_location_at, b.next_service_date,
      b.next_service_km, b.odometer_km, b.status AS bike_status,
      u.full_name, u.email, u.phone, u.id_number, u.address, u.city, u.province, u.postal_code
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = $1`, [agreementId]);
  const agreement = rows[0];
  if (!agreement) return null;
  let application = null;
  if (agreement.application_id) {
    const { rows: appRows } = await pgDb.query('SELECT * FROM applications WHERE id = $1', [agreement.application_id]);
    application = appRows[0] || null;
  }
  return { agreement, rider: agreement, bike: agreement, application };
}

async function getFleetOwnerContractContext(agreementId, organizationId) {
  const context = await getAgreementContractContext(agreementId);
  if (!context) return null;
  const { rows } = await pgDb.query('SELECT * FROM organizations WHERE id = $1', [organizationId]);
  const org = rows[0];
  if (!org) return null;
  return { ...context, org };
}

async function writeFleetOwnerContractSnapshot(agreementId, organizationId) {
  const context = await getFleetOwnerContractContext(agreementId, organizationId);
  if (!context) return null;
  const { org, agreement, rider, bike } = context;
  const filename = buildContractFilename(agreement.agreement_no, 'fleet-rto');
  const filePath = path.join(contractDir, filename);
  fs.writeFileSync(filePath, rentToOwnContractTemplate({ org, agreement, rider, bike }));
  return publicPath(filename);
}

// Regenerates a missing contract HTML snapshot from the database — used by
// app.js's /uploads/* static-file fallback when the file isn't on disk
// (e.g. lost volume, manual cleanup).
async function ensureContractSnapshotForAgreement({ agreementId, kind }) {
  const context = await getAgreementContractContext(agreementId);
  if (!context) return null;

  const absolutePath = buildContractAbsolutePath(context.agreement.agreement_no, kind);
  if (!fs.existsSync(absolutePath)) {
    writeContractSnapshot({
      ...context,
      signatureData: kind === 'signed' ? context.agreement.signature_data : null,
      kind
    });
  }

  const generatedPublicPath = publicPath(buildContractFilename(context.agreement.agreement_no, kind));
  if (kind === 'signed' && context.agreement.signed_contract_path !== generatedPublicPath) {
    await pgDb.query(`UPDATE agreements SET signed_contract_path = $1 WHERE id = $2`, [generatedPublicPath, agreementId]);
  }
  if (kind === 'unsigned' && (context.agreement.contract_file_path !== generatedPublicPath || context.agreement.contract_pdf_path !== generatedPublicPath)) {
    await pgDb.query(`UPDATE agreements SET contract_file_path = $1, contract_pdf_path = $2 WHERE id = $3`, [generatedPublicPath, generatedPublicPath, agreementId]);
  }

  return {
    absolutePath,
    publicPath: generatedPublicPath,
    context
  };
}

async function ensureContractSnapshotForRelativePath(relativePath = '') {
  const normalized = String(relativePath || '').replace(/^[/\\]+/, '');
  if (!normalized.startsWith('contracts/')) return null;

  const parsed = parseContractFilename(normalized.slice('contracts/'.length));
  if (!parsed) return null;

  const { rows } = await pgDb.query(`SELECT id, agreement_no FROM agreements`);
  const agreement = rows.find((row) => safeAgreementNo(row.agreement_no) === parsed.safeNo);
  if (!agreement) return null;

  return ensureContractSnapshotForAgreement({ agreementId: agreement.id, kind: parsed.kind });
}

module.exports = {
  getAgreementContractContext,
  getFleetOwnerContractContext,
  writeFleetOwnerContractSnapshot,
  ensureContractSnapshotForAgreement,
  ensureContractSnapshotForRelativePath,
};

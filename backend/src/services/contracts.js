const fs = require('fs');
const path = require('path');

const contractDir = path.join(__dirname, '../../uploads/contracts');
fs.mkdirSync(contractDir, { recursive: true });

function publicPath(filename) {
  return `/uploads/contracts/${filename}`;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function contractTemplate({ agreement, rider, bike, application, signatureData }) {
  const signedLabel = signatureData ? `<div class="signature-box"><div class="signature-mark">${escapeHtml(signatureData)}</div><div>Electronic signature</div></div>` : '<div class="signature-box">Pending rider signature</div>';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>OnFleet Agreement ${escapeHtml(agreement.agreement_no)}</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f4f7fb;color:#111;padding:32px;line-height:1.45}
    .wrap{max-width:900px;margin:0 auto;background:#fff;padding:32px;border-radius:20px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
    .brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:18px;border-bottom:2px solid #1E88D1}
    .badge{background:#e8f4fd;color:#1E88D1;padding:8px 14px;border-radius:999px;font-weight:700;font-size:12px}
    h1,h2,h3{margin:0 0 12px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:20px 0}
    .card{background:#f8fbfe;padding:18px;border-radius:14px;border:1px solid #d7e7f5}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    td{padding:10px 0;border-bottom:1px solid #e6edf5;vertical-align:top}
    td:first-child{color:#6c7b8a;width:35%}
    .signature-box{margin-top:26px;padding:18px;border:2px dashed #1E88D1;border-radius:14px;min-height:90px;background:#f8fbff}
    .signature-mark{font-size:28px;font-family:'Brush Script MT',cursive;color:#0e5a8e;margin-bottom:8px}
    .small{color:#6c7b8a;font-size:12px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div>
        <h1>OnFleet Africa Rent-to-Own Agreement</h1>
        <div class="small">Agreement ${escapeHtml(agreement.agreement_no)}</div>
      </div>
      <div class="badge">${signatureData ? 'SIGNED' : 'PENDING SIGNATURE'}</div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Rider</h3>
        <table>
          <tr><td>Name</td><td>${escapeHtml(rider.full_name)}</td></tr>
          <tr><td>Email</td><td>${escapeHtml(rider.email || '')}</td></tr>
          <tr><td>Phone</td><td>${escapeHtml(rider.phone || '')}</td></tr>
          <tr><td>ID Number</td><td>${escapeHtml(rider.id_number || '')}</td></tr>
        </table>
      </div>
      <div class="card">
        <h3>Bike</h3>
        <table>
          <tr><td>Model</td><td>${escapeHtml(`${bike.make} ${bike.model}`)}</td></tr>
          <tr><td>VIN</td><td>${escapeHtml(bike.vin || '')}</td></tr>
          <tr><td>Registration</td><td>${escapeHtml(bike.registration || 'Pending')}</td></tr>
          <tr><td>Weekly instalment</td><td>R${Number(agreement.weekly_amount).toFixed(2)}</td></tr>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>Commercial terms</h3>
      <table>
        <tr><td>Start date</td><td>${escapeHtml(agreement.start_date)}</td></tr>
        <tr><td>End date</td><td>${escapeHtml(agreement.end_date)}</td></tr>
        <tr><td>Total weeks</td><td>${escapeHtml(String(agreement.total_weeks))}</td></tr>
        <tr><td>Total contract value</td><td>R${Number(agreement.total_amount).toFixed(2)}</td></tr>
        <tr><td>Payout preference</td><td>${escapeHtml(application?.payout_preference || 'Not specified')}</td></tr>
      </table>
      <p>The rider agrees to make weekly payments on time, keep the motorcycle roadworthy, and comply with OnFleet insurance and maintenance requirements. Ownership transfers after all scheduled instalments are fully paid.</p>
    </div>

    <div class="card" style="margin-top:18px">
      <h3>Electronic acceptance</h3>
      ${signedLabel}
      <div class="small">Generated ${new Date().toISOString()} by OnFleet Africa platform.</div>
    </div>
  </div>
</body>
</html>`;
}

function writeContractSnapshot({ agreement, rider, bike, application, signatureData, kind }) {
  const safeNo = agreement.agreement_no.replace(/[^a-zA-Z0-9-]/g, '_');
  const filename = `${safeNo}-${kind}.html`;
  const filePath = path.join(contractDir, filename);
  fs.writeFileSync(filePath, contractTemplate({ agreement, rider, bike, application, signatureData }));
  return publicPath(filename);
}

module.exports = { writeContractSnapshot };

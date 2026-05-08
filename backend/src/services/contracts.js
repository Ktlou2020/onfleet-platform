const fs = require('fs');
const path = require('path');

const contractDir = path.join(__dirname, '../../uploads/contracts');
fs.mkdirSync(contractDir, { recursive: true });

function publicPath(filename) {
  return `/uploads/contracts/${filename}`;
}

function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  return `R${Number(value || 0).toFixed(2)}`;
}

function contractTemplate({ agreement, rider, bike, application, signatureData }) {
  const riderAddress = [rider.address, rider.city, rider.province, rider.postal_code].filter(Boolean).join(', ');
  const payoutDetail = application?.payout_preference === 'eft'
    ? [application.bank_name, application.account_holder, application.account_number].filter(Boolean).join(' · ')
    : (application?.payout_preference === 'ewallet' ? (application.ewallet_number || 'E-wallet number pending') : 'Not specified');
  const signedLabel = signatureData
    ? `<div class="signature-box"><div class="signature-mark">${escapeHtml(signatureData)}</div><div>Electronic signature recorded by OnFleet platform</div></div>`
    : '<div class="signature-box">Pending rider electronic signature</div>';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>OnFleet Agreement ${escapeHtml(agreement.agreement_no)}</title>
  <style>
    :root{--primary:#1E88D1;--primary-soft:#eaf4fb;--text:#112233;--muted:#64748b;--border:#dbe7f1;--danger:#c62828}
    *{box-sizing:border-box}
    body{font-family:Arial,sans-serif;background:#f4f7fb;color:var(--text);padding:28px;line-height:1.58}
    .wrap{max-width:980px;margin:0 auto;background:#fff;padding:36px;border-radius:20px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
    .brand{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px;padding-bottom:18px;border-bottom:3px solid var(--primary)}
    .badge{background:var(--primary-soft);color:var(--primary);padding:8px 14px;border-radius:999px;font-weight:700;font-size:12px;white-space:nowrap}
    h1,h2,h3{margin:0 0 12px}
    h1{font-size:30px}
    h2{margin-top:28px;font-size:18px;color:#0f4f7a}
    h3{font-size:16px}
    p{margin:10px 0}
    .small{color:var(--muted);font-size:12px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:18px 0}
    .card{background:#f8fbfe;padding:18px;border-radius:14px;border:1px solid var(--border)}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    td{padding:9px 0;border-bottom:1px solid #e6edf5;vertical-align:top}
    td:first-child{color:var(--muted);width:36%}
    ul{margin:8px 0 14px 18px;padding:0}
    li{margin:5px 0}
    .clause{padding:16px 18px;border:1px solid var(--border);border-radius:14px;background:#fff;margin-top:14px}
    .signature-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}
    .signature-box{margin-top:14px;padding:18px;border:2px dashed var(--primary);border-radius:14px;min-height:90px;background:#f8fbff}
    .signature-mark{font-size:28px;font-family:'Brush Script MT',cursive;color:#0e5a8e;margin-bottom:8px}
    .legal-note{background:#fff8e1;border:1px solid #f5d37a;padding:14px 16px;border-radius:12px;margin-top:18px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div>
        <div class="small">ONFLEET (PTY) LTD</div>
        <h1>Delivery Bike Rental Agreement</h1>
        <div class="small">Unit E20, 472 Spionkop Avenue, Kya Sand, Johannesburg · 081 539 5612</div>
        <div class="small">Agreement number: ${escapeHtml(agreement.agreement_no)}</div>
      </div>
      <div class="badge">${signatureData ? 'SIGNED' : 'PENDING SIGNATURE'}</div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Client details</h3>
        <table>
          <tr><td>Name & surname</td><td>${escapeHtml(rider.full_name)}</td></tr>
          <tr><td>Address</td><td>${escapeHtml(riderAddress || 'Not recorded')}</td></tr>
          <tr><td>ID / passport number</td><td>${escapeHtml(rider.id_number || 'Not recorded')}</td></tr>
          <tr><td>Contact number</td><td>${escapeHtml(rider.phone || 'Not recorded')}</td></tr>
          <tr><td>E-mail address (domicilium)</td><td>${escapeHtml(rider.email || 'Not recorded')}</td></tr>
        </table>
      </div>
      <div class="card">
        <h3>Product and commercial terms</h3>
        <table>
          <tr><td>Motorcycle</td><td>${escapeHtml(`${bike.make} ${bike.model}`)}</td></tr>
          <tr><td>VIN</td><td>${escapeHtml(bike.vin || '')}</td></tr>
          <tr><td>Registration</td><td>${escapeHtml(bike.registration || 'Pending')}</td></tr>
          <tr><td>Weekly rental</td><td>${money(agreement.weekly_amount)}</td></tr>
          <tr><td>Total weeks</td><td>${escapeHtml(String(agreement.total_weeks))}</td></tr>
          <tr><td>Total contract value</td><td>${money(agreement.total_amount)}</td></tr>
          <tr><td>Commencement date</td><td>${escapeHtml(agreement.start_date)}</td></tr>
          <tr><td>Scheduled end date</td><td>${escapeHtml(agreement.end_date)}</td></tr>
          <tr><td>Payout preference</td><td>${escapeHtml(payoutDetail)}</td></tr>
        </table>
      </div>
    </div>

    <div class="clause">
      <h2>1. RENTAL OF PRODUCTS AND OWNERSHIP</h2>
      <p>Each Product is owned by OnFleet and will at all times remain the property of OnFleet until all amounts due under this Agreement have been paid in full and ownership is formally transferred in terms of the platform process.</p>
      <p>The Client acknowledges that possession and use of the Product do not transfer ownership until completion of the full rent-to-own payment cycle and any other contractual obligations.</p>
    </div>

    <div class="clause">
      <h2>2. DURATION</h2>
      <p>This Agreement commences on the Commencement Date reflected above. The Parties agree that the rental shall run for the Initial Term stated above, subject to earlier cancellation, suspension, default, or completion in accordance with this Agreement.</p>
      <p>Although a motorcycle may have an initial term, the Commencement Date and therefore the end of the initial term may differ for each Product allocated under the platform.</p>
    </div>

    <div class="clause">
      <h2>3. RENTAL PAYMENTS AND PAYMENT GENERALLY</h2>
      <p>The Client shall make payment of the Weekly Rental to OnFleet, weekly in advance, on or before the last day of each week. The rental amount credited to the Agreement is the contractual weekly rental shown above.</p>
      <p>Where card or gateway fees are charged separately for a transaction, those fees are disclosed transparently on the payment screen and transaction history and do not reduce the rental amount credited to the Agreement.</p>
      <p>All amounts shown on the platform are payable in South African Rand. Where applicable, amounts are inclusive of value-added tax (VAT).</p>
    </div>

    <div class="clause">
      <h2>4. INITIATION FEE</h2>
      <p>Any initiation fee, onboarding cost, or once-off setup fee calculated at the date of entering into this Agreement is non-refundable unless OnFleet agrees otherwise in writing.</p>
    </div>

    <div class="clause">
      <h2>7. INSURANCE, RISK AND LIABILITY</h2>
      <p>The Client accepts all risk and liability in respect of the Product immediately upon the Client taking possession of the Product.</p>
      <p>The Client shall keep the Product fully insured to the full amount of its replacement value whenever required by OnFleet or any insurer appointed by OnFleet. The Client remains liable for any excess, uninsured loss, negligence, misuse, traffic fines, impoundment costs, towing, storage, and third-party claims to the extent permitted by law.</p>
    </div>

    <div class="clause">
      <h2>9. CLIENT&apos;S OBLIGATIONS</h2>
      <ul>
        <li>The Client must keep the motorcycle in good order, condition, and repair, fair wear and tear excepted.</li>
        <li>Basic service items such as oil and chain service may be provided once per month where included by OnFleet, but all other maintenance and repairs remain the Client&apos;s responsibility unless the platform records otherwise.</li>
        <li>The Client may not use the Product for any unlawful purpose, racing, carrying passengers for reward, or operating outside the borders of the Republic of South Africa without OnFleet&apos;s prior written consent.</li>
        <li>The Client must immediately report theft, seizure, accident, damage, licence expiry, insurance events, and any change in address, phone number, or domicilium email address.</li>
        <li>The Client must keep all licences, permits, and identity documents valid for the full duration of the Agreement.</li>
      </ul>
    </div>

    <div class="clause">
      <h2>13. BREACH</h2>
      <p>If the Client fails to make any payment when due, breaches any material term, or provides false or misleading information, OnFleet shall be entitled, after any applicable notice period, to suspend the Client, uplift possession of the Product, cancel this Agreement, and claim immediate payment of all amounts payable for the unexpired portion of the Initial Term, together with any reasonable recovery costs permitted by law.</p>
      <p>On termination or cancellation, the Client shall immediately return the Product, together with all tyres, tools, accessories, keys, tracking devices, and other equipment in the same condition as at the Commencement Date, fair wear and tear excepted.</p>
    </div>

    <div class="clause">
      <h2>14. DOMICILIUM CITANDI ET EXECUTANDI</h2>
      <p>The Parties choose the following address as their respective domicilium citandi et executandi for all purposes under this Agreement, including the giving of notices and the service of legal process:</p>
      <table>
        <tr><td>OnFleet domicilium</td><td>Unit E20, 472 Spionkop Avenue, Kya Sand, Johannesburg</td></tr>
        <tr><td>Client physical domicilium</td><td>${escapeHtml(riderAddress || 'Not recorded')}</td></tr>
        <tr><td>Client e-mail domicilium</td><td>${escapeHtml(rider.email || 'Not recorded')}</td></tr>
      </table>
      <p>Any notice sent to the above e-mail address or physical address will be deemed delivered in accordance with applicable law and the notice rules adopted by the platform.</p>
    </div>

    <div class="legal-note">
      <strong>Electronic acceptance.</strong> By signing electronically, the Client confirms that the Agreement was presented in readable form on the OnFleet platform, that the Client had the opportunity to review the terms, and that the electronic signature and audit trail may be used as proof of acceptance.
    </div>

    <div class="signature-grid">
      <div class="card">
        <h3>OnFleet&apos;s signature (duly authorised)</h3>
        <table>
          <tr><td>Full name</td><td>OnFleet Authorised Representative</td></tr>
          <tr><td>Capacity</td><td>Duly authorised</td></tr>
          <tr><td>Place</td><td>Johannesburg</td></tr>
          <tr><td>Date</td><td>${escapeHtml(new Date().toISOString().slice(0, 10))}</td></tr>
        </table>
      </div>
      <div class="card">
        <h3>Client&apos;s signature (duly authorised)</h3>
        <table>
          <tr><td>Full name</td><td>${escapeHtml(rider.full_name)}</td></tr>
          <tr><td>Capacity</td><td>Client / Rider</td></tr>
          <tr><td>Place</td><td>${escapeHtml(rider.city || rider.province || 'Johannesburg')}</td></tr>
          <tr><td>Date</td><td>${escapeHtml(new Date().toISOString().slice(0, 10))}</td></tr>
        </table>
        ${signedLabel}
      </div>
    </div>

    <div class="small" style="margin-top:22px">Generated by OnFleet Africa platform from the active agreement record and the platform&apos;s electronic contract wording set.</div>
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

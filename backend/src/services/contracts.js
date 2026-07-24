const fs = require('fs');
const path = require('path');
const db = require('../db');
const { contracts: contractDir } = require('../uploadPaths');

function publicPath(filename) {
  return `/uploads/contracts/${filename}`;
}

function safeAgreementNo(agreementNo = '') {
  return String(agreementNo || '').replace(/[^a-zA-Z0-9-]/g, '_');
}

function buildContractFilename(agreementNo, kind) {
  return `${safeAgreementNo(agreementNo)}-${kind}.html`;
}

function buildContractAbsolutePath(agreementNo, kind) {
  return path.join(contractDir, buildContractFilename(agreementNo, kind));
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
  const filename = buildContractFilename(agreement.agreement_no, kind);
  const filePath = path.join(contractDir, filename);
  fs.writeFileSync(filePath, contractTemplate({ agreement, rider, bike, application, signatureData }));
  return publicPath(filename);
}

function getAgreementContractContext(agreementId) {
  const agreement = db.prepare(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin,
      b.year, b.engine_cc, b.color,
      b.last_known_lat, b.last_known_lng, b.last_location_at, b.next_service_date,
      b.next_service_km, b.odometer_km, b.status AS bike_status,
      u.full_name, u.email, u.phone, u.id_number, u.address, u.city, u.province, u.postal_code
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ?`).get(agreementId);
  if (!agreement) return null;
  const application = agreement.application_id ? db.prepare('SELECT * FROM applications WHERE id = ?').get(agreement.application_id) : null;
  return { agreement, rider: agreement, bike: agreement, application };
}

function ensureContractSnapshotForAgreement({ agreementId, kind }) {
  const context = getAgreementContractContext(agreementId);
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
    db.prepare(`UPDATE agreements SET signed_contract_path = ? WHERE id = ?`).run(generatedPublicPath, agreementId);
  }
  if (kind === 'unsigned' && (context.agreement.contract_file_path !== generatedPublicPath || context.agreement.contract_pdf_path !== generatedPublicPath)) {
    db.prepare(`UPDATE agreements SET contract_file_path = ?, contract_pdf_path = ? WHERE id = ?`).run(generatedPublicPath, generatedPublicPath, agreementId);
  }

  return {
    absolutePath,
    publicPath: generatedPublicPath,
    context
  };
}

function parseContractFilename(filename = '') {
  const normalized = path.basename(String(filename || ''));
  if (normalized.endsWith('-signed.html')) {
    return { safeNo: normalized.slice(0, -'-signed.html'.length), kind: 'signed' };
  }
  if (normalized.endsWith('-unsigned.html')) {
    return { safeNo: normalized.slice(0, -'-unsigned.html'.length), kind: 'unsigned' };
  }
  return null;
}

function ensureContractSnapshotForRelativePath(relativePath = '') {
  const normalized = String(relativePath || '').replace(/^[/\\]+/, '');
  if (!normalized.startsWith('contracts/')) return null;

  const parsed = parseContractFilename(normalized.slice('contracts/'.length));
  if (!parsed) return null;

  const agreement = db.prepare(`SELECT id, agreement_no FROM agreements`).all().find((row) => safeAgreementNo(row.agreement_no) === parsed.safeNo);
  if (!agreement) return null;

  return ensureContractSnapshotForAgreement({ agreementId: agreement.id, kind: parsed.kind });
}

function rentToOwnContractTemplate({ org, agreement, rider, bike }) {
  const orgName = org.name || 'Fleet Owner';
  const orgAddress = org.address || org.city || 'Address not recorded';
  const orgReg = org.registration_number || 'Not recorded';
  const orgVat = org.vat_number || null;
  const riderAddress = [rider.address, rider.city, rider.province, rider.postal_code].filter(Boolean).join(', ');
  const bikeDesc = [bike.year, bike.make, bike.model].filter(Boolean).join(' ');
  const today = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Rent-to-Own Agreement ${escapeHtml(agreement.agreement_no)}</title>
  <style>
    :root{--primary:#1E3A5F;--accent:#2563EB;--accent-soft:#eff6ff;--text:#111827;--muted:#6B7280;--border:#E5E7EB;--danger:#DC2626;--success:#16A34A}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#F9FAFB;color:var(--text);padding:32px;line-height:1.6}
    .wrap{max-width:900px;margin:0 auto;background:#fff;padding:48px;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    .header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:32px;padding-bottom:24px;border-bottom:3px solid var(--primary)}
    .header-left{}
    .org-name{font-size:22px;font-weight:700;color:var(--primary);margin-bottom:4px}
    .org-meta{font-size:12px;color:var(--muted);line-height:1.7}
    .doc-title{font-size:26px;font-weight:800;color:var(--primary);margin-bottom:6px}
    .doc-sub{font-size:13px;color:var(--muted)}
    .badge{background:var(--primary);color:#fff;padding:8px 16px;border-radius:4px;font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;align-self:flex-start}
    .parties{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0}
    .party-card{background:var(--accent-soft);border:1px solid #BFDBFE;border-radius:6px;padding:16px}
    .party-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:8px}
    .party-name{font-size:15px;font-weight:700;margin-bottom:6px}
    table.details{width:100%;border-collapse:collapse;font-size:13px}
    table.details td{padding:5px 0;border-bottom:1px solid var(--border);vertical-align:top}
    table.details td:first-child{color:var(--muted);width:40%}
    .section{margin-top:20px;border:1px solid var(--border);border-radius:6px;overflow:hidden}
    .section-head{background:var(--primary);color:#fff;padding:10px 16px;font-size:13px;font-weight:700;letter-spacing:.04em}
    .section-body{padding:16px;font-size:13px;line-height:1.7}
    .section-body p{margin-bottom:10px}
    .section-body p:last-child{margin-bottom:0}
    .section-body ul{margin:8px 0 10px 20px}
    .section-body li{margin:4px 0}
    .terms-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:20px 0}
    .term-card{background:#F8FAFC;border:1px solid var(--border);border-radius:6px;padding:14px;text-align:center}
    .term-value{font-size:22px;font-weight:800;color:var(--primary);margin-bottom:2px}
    .term-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
    .highlight{background:#FFF7ED;border:1px solid #FED7AA;border-radius:6px;padding:14px 16px;margin:16px 0;font-size:13px}
    .highlight strong{color:#C2410C}
    .sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:24px}
    .sig-card{border:1px solid var(--border);border-radius:6px;padding:16px}
    .sig-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:12px}
    .sig-line{border-bottom:1px solid var(--text);margin-top:40px;margin-bottom:6px}
    .sig-label{font-size:11px;color:var(--muted)}
    .sig-date{margin-top:14px}
    .footer-note{margin-top:24px;font-size:11px;color:var(--muted);border-top:1px solid var(--border);padding-top:14px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="header-left">
        <div class="org-name">${escapeHtml(orgName)}</div>
        <div class="org-meta">
          ${escapeHtml(orgAddress)}<br/>
          Reg. No: ${escapeHtml(orgReg)}${orgVat ? ` &nbsp;·&nbsp; VAT: ${escapeHtml(orgVat)}` : ''}
        </div>
        <div class="doc-title" style="margin-top:14px">Rent-to-Own Agreement</div>
        <div class="doc-sub">Agreement No: <strong>${escapeHtml(agreement.agreement_no)}</strong> &nbsp;·&nbsp; Date: ${escapeHtml(today)}</div>
      </div>
      <div class="badge">Rent-to-Own</div>
    </div>

    <div class="parties">
      <div class="party-card">
        <div class="party-label">Lessor (Fleet Owner)</div>
        <div class="party-name">${escapeHtml(orgName)}</div>
        <table class="details">
          <tr><td>Registration</td><td>${escapeHtml(orgReg)}</td></tr>
          ${orgVat ? `<tr><td>VAT number</td><td>${escapeHtml(orgVat)}</td></tr>` : ''}
          <tr><td>Address</td><td>${escapeHtml(orgAddress)}</td></tr>
        </table>
      </div>
      <div class="party-card">
        <div class="party-label">Lessee (Rider)</div>
        <div class="party-name">${escapeHtml(rider.full_name)}</div>
        <table class="details">
          <tr><td>ID / Passport</td><td>${escapeHtml(rider.id_number || 'Not recorded')}</td></tr>
          <tr><td>Phone</td><td>${escapeHtml(rider.phone || 'Not recorded')}</td></tr>
          <tr><td>E-mail</td><td>${escapeHtml(rider.email || 'Not recorded')}</td></tr>
          <tr><td>Address</td><td>${escapeHtml(riderAddress || 'Not recorded')}</td></tr>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-head">VEHICLE DESCRIPTION</div>
      <div class="section-body">
        <table class="details">
          <tr><td>Motorcycle</td><td><strong>${escapeHtml(bikeDesc || `${bike.make} ${bike.model}`)}</strong></td></tr>
          <tr><td>VIN number</td><td>${escapeHtml(bike.vin || 'Not recorded')}</td></tr>
          <tr><td>Registration number</td><td>${escapeHtml(bike.registration || 'Pending')}</td></tr>
          <tr><td>Engine capacity</td><td>${bike.engine_cc ? `${escapeHtml(String(bike.engine_cc))} cc` : 'Not recorded'}</td></tr>
          <tr><td>Colour</td><td>${escapeHtml(bike.color || 'Not recorded')}</td></tr>
        </table>
      </div>
    </div>

    <div class="terms-grid">
      <div class="term-card"><div class="term-value">${money(agreement.weekly_amount)}</div><div class="term-label">Weekly Rental</div></div>
      <div class="term-card"><div class="term-value">${escapeHtml(String(agreement.total_weeks || 0))} weeks</div><div class="term-label">Contract Term</div></div>
      <div class="term-card"><div class="term-value">${money(agreement.total_amount)}</div><div class="term-label">Total Contract Value</div></div>
      <div class="term-card"><div class="term-value">${escapeHtml(agreement.start_date || '—')} → ${escapeHtml(agreement.end_date || '—')}</div><div class="term-label">Commencement → End Date</div></div>
    </div>

    <div class="section">
      <div class="section-head">1. NATURE OF AGREEMENT AND OWNERSHIP</div>
      <div class="section-body">
        <p>The Lessor agrees to lease the Vehicle described above to the Lessee on a rent-to-own basis for the Initial Term and at the Weekly Rental set out above.</p>
        <p>The Vehicle shall at all times remain the sole property of the Lessor until such time as the Lessee has paid the full Total Contract Value and all other amounts due under this Agreement in full. Possession of the Vehicle by the Lessee does not, under any circumstances, transfer ownership. Ownership shall only vest in the Lessee upon formal written confirmation of transfer by the Lessor following completion of all payments.</p>
        <p>The Lessee acknowledges that no right, title, or interest in the Vehicle passes to the Lessee other than the right to use the Vehicle for the duration of this Agreement, subject to the terms hereof.</p>
      </div>
    </div>

    <div class="section">
      <div class="section-head">2. PAYMENTS</div>
      <div class="section-body">
        <p>The Lessee shall pay the Weekly Rental of <strong>${money(agreement.weekly_amount)}</strong> to the Lessor, in advance, on or before the last day of each week for the duration of the Initial Term.</p>
        <p>All amounts are payable in South African Rand and are inclusive of VAT where applicable. Payments must be made via the platform or such other method as the Lessor may specify in writing from time to time.</p>
        <p>A failure to make payment on the due date shall constitute a breach of this Agreement and shall entitle the Lessor to exercise its rights under clause 5 below.</p>
      </div>
    </div>

    <div class="section">
      <div class="section-head">3. WEAR AND TEAR — LESSEE'S RESPONSIBILITY</div>
      <div class="section-body">
        <p>The Lessee accepts full and sole responsibility for all wear and tear on the Vehicle throughout the term of this Agreement. This obligation is unconditional and not limited to fair or reasonable wear and tear.</p>
        <ul>
          <li>The Lessee shall maintain the Vehicle in good, safe, and roadworthy condition at all times and at the Lessee's own expense.</li>
          <li>All tyres, brakes, chains, sprockets, batteries, lights, mirrors, indicators, and other consumable or wear components must be replaced by the Lessee as and when required, at the Lessee's cost.</li>
          <li>Any mechanical failure, damage, or deterioration arising from the Lessee's use, neglect, misuse, or failure to maintain the Vehicle is the Lessee's sole responsibility.</li>
          <li>The Lessee shall pay for all repairs, parts, and labour required to keep the Vehicle in roadworthy condition. The Lessor is not obligated to contribute to any repair or maintenance cost unless separately agreed in writing.</li>
          <li>Upon return or repossession of the Vehicle, the Lessee shall be liable for the cost of restoring the Vehicle to the condition it was in at commencement, less an allowance only for normal mechanical depreciation consistent with proper use and maintenance. The Lessee bears the cost of any damage or deterioration beyond that allowance.</li>
          <li>Traffic fines, impoundment fees, towing charges, and storage costs arising during the period of the Lessee's possession are the sole responsibility of the Lessee.</li>
        </ul>
      </div>
    </div>

    <div class="section">
      <div class="section-head">4. INSURANCE AND RISK</div>
      <div class="section-body">
        <p>Risk in the Vehicle passes to the Lessee immediately upon taking possession of the Vehicle and remains with the Lessee until the Vehicle is returned to or recovered by the Lessor.</p>
        <p>The Lessee shall, at the Lessee's own cost, insure the Vehicle for its full replacement value throughout the term of this Agreement. Proof of insurance must be provided to the Lessor upon request.</p>
        <p>In the event of theft, accident, or total loss, the Lessee remains liable for any outstanding balance under this Agreement unless the insurance proceeds are sufficient to settle the full outstanding amount.</p>
        <p>The Lessee must immediately report any theft, accident, damage, or seizure of the Vehicle to the Lessor and, where applicable, to the South African Police Service.</p>
      </div>
    </div>

    <div class="section">
      <div class="section-head">5. DEFAULT AND LESSOR'S RIGHT TO CANCEL</div>
      <div class="section-body">
        <div class="highlight"><strong>Important:</strong> The Lessor has the right to cancel this Agreement immediately upon the Lessee's failure to make any payment when due or upon any other material breach of this Agreement.</div>
        <p>Without limiting the Lessor's rights, the following shall each constitute an event of default:</p>
        <ul>
          <li>Failure to pay any Weekly Rental amount on or before the due date;</li>
          <li>Failure to maintain the Vehicle in roadworthy condition;</li>
          <li>Use of the Vehicle for any unlawful purpose, racing, or carrying passengers for reward;</li>
          <li>Allowing any unauthorised person to operate the Vehicle;</li>
          <li>Failure to maintain valid insurance on the Vehicle;</li>
          <li>Any misrepresentation or material omission made in connection with this Agreement;</li>
          <li>Insolvency, sequestration, or liquidation of the Lessee.</li>
        </ul>
        <p>Upon default, the Lessor shall be entitled, without further notice, to:</p>
        <ul>
          <li>Cancel this Agreement with immediate effect;</li>
          <li>Repossess the Vehicle, wherever it may be located, without legal process where permitted by law;</li>
          <li>Claim all arrears, outstanding amounts for the unexpired term, and reasonable recovery costs;</li>
          <li>Report the Lessee to any credit bureau as may be permitted by law.</li>
        </ul>
        <p>On cancellation or termination, the Lessee shall immediately return the Vehicle, together with all keys, accessories, tracking devices, and documents, in the condition required by clause 3 above.</p>
      </div>
    </div>

    <div class="section">
      <div class="section-head">6. LESSEE'S GENERAL OBLIGATIONS</div>
      <div class="section-body">
        <ul>
          <li>The Lessee shall not sub-let, transfer, encumber, or otherwise deal with this Agreement or the Vehicle without the Lessor's prior written consent.</li>
          <li>The Lessee shall comply with all applicable traffic laws, licensing requirements, and regulations.</li>
          <li>The Lessee shall not operate the Vehicle outside the borders of the Republic of South Africa without the Lessor's prior written consent.</li>
          <li>The Lessee shall keep all personal licences, identity documents, and permits valid for the full duration of this Agreement.</li>
          <li>The Lessee shall immediately notify the Lessor of any change in address, phone number, or e-mail address.</li>
        </ul>
      </div>
    </div>

    <div class="section">
      <div class="section-head">7. DOMICILIUM CITANDI ET EXECUTANDI</div>
      <div class="section-body">
        <p>The Parties choose the following addresses as their respective domicilium citandi et executandi for all purposes under this Agreement:</p>
        <table class="details">
          <tr><td>Lessor</td><td>${escapeHtml(orgAddress)}</td></tr>
          <tr><td>Lessee (physical)</td><td>${escapeHtml(riderAddress || 'Not recorded')}</td></tr>
          <tr><td>Lessee (e-mail)</td><td>${escapeHtml(rider.email || 'Not recorded')}</td></tr>
        </table>
        <p style="margin-top:10px">Any notice sent to the above addresses shall be deemed delivered: if by e-mail, on the date sent; if by registered post, 7 days after posting.</p>
      </div>
    </div>

    <div class="section">
      <div class="section-head">8. GOVERNING LAW AND JURISDICTION</div>
      <div class="section-body">
        <p>This Agreement shall be governed by the laws of the Republic of South Africa. The Parties consent to the jurisdiction of the Magistrate's Court having jurisdiction over the Lessor's domicilium for any dispute arising out of or in connection with this Agreement, notwithstanding that the matter may otherwise exceed the jurisdiction of the Magistrate's Court.</p>
        <p>Each Party shall bear their own legal costs unless a court orders otherwise.</p>
      </div>
    </div>

    <div class="sig-grid">
      <div class="sig-card">
        <div class="sig-title">Lessor — ${escapeHtml(orgName)}</div>
        <table class="details" style="margin-bottom:8px">
          <tr><td>Name</td><td></td></tr>
          <tr><td>Capacity</td><td>Duly authorised signatory</td></tr>
        </table>
        <div class="sig-line"></div>
        <div class="sig-label">Signature</div>
        <div class="sig-date">
          <div class="sig-line" style="margin-top:28px"></div>
          <div class="sig-label">Date</div>
        </div>
      </div>
      <div class="sig-card">
        <div class="sig-title">Lessee — ${escapeHtml(rider.full_name)}</div>
        <table class="details" style="margin-bottom:8px">
          <tr><td>Full name</td><td>${escapeHtml(rider.full_name)}</td></tr>
          <tr><td>ID / Passport</td><td>${escapeHtml(rider.id_number || 'Not recorded')}</td></tr>
        </table>
        <div class="sig-line"></div>
        <div class="sig-label">Signature</div>
        <div class="sig-date">
          <div class="sig-line" style="margin-top:28px"></div>
          <div class="sig-label">Date</div>
        </div>
      </div>
    </div>

    <div class="footer-note">
      Generated by the OnFleet platform on ${escapeHtml(today)} from the active agreement record. This document constitutes a legally binding agreement between the Lessor and Lessee named above. Each party should retain a signed copy.
    </div>
  </div>
</body>
</html>`;
}

function getFleetOwnerContractContext(agreementId, organizationId) {
  const context = getAgreementContractContext(agreementId);
  if (!context) return null;
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
  if (!org) return null;
  return { ...context, org };
}

function writeFleetOwnerContractSnapshot(agreementId, organizationId) {
  const context = getFleetOwnerContractContext(agreementId, organizationId);
  if (!context) return null;
  const { org, agreement, rider, bike } = context;
  const filename = buildContractFilename(agreement.agreement_no, 'fleet-rto');
  const filePath = path.join(contractDir, filename);
  fs.writeFileSync(filePath, rentToOwnContractTemplate({ org, agreement, rider, bike }));
  return publicPath(filename);
}

module.exports = {
  writeContractSnapshot,
  ensureContractSnapshotForAgreement,
  ensureContractSnapshotForRelativePath,
  getAgreementContractContext,
  writeFleetOwnerContractSnapshot,
  getFleetOwnerContractContext
};

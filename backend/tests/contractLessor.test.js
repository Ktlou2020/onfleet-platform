import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const load = createRequire(import.meta.url);

// Who the agreement says owns the bike.
//
// Every clause used to say OnFleet, whoever the bike belonged to. An operator
// who signed their own rider onto the platform got a document asserting that
// OnFleet owned that operator's motorcycle, that the rider owed the weekly
// rental to OnFleet, and that legal process was served at OnFleet's address —
// none of it true, and none of it enforceable by the operator who actually
// owned the bike.

function loadContracts(brandKey) {
  const prev = process.env.BRAND;
  if (brandKey) process.env.BRAND = brandKey; else delete process.env.BRAND;
  for (const k of Object.keys(load.cache)) {
    if (k.includes('/src/brand.js') || k.includes('/services/contracts.js')) delete load.cache[k];
  }
  const mod = load('../src/services/contracts.js');
  if (prev === undefined) delete process.env.BRAND; else process.env.BRAND = prev;
  return mod;
}

const AGREEMENT = {
  agreement_no: 'AG-2026-0100', weekly_amount: 850, total_weeks: 78,
  total_amount: 66300, start_date: '2026-01-05', end_date: '2027-07-05',
};
const RIDER = {
  full_name: 'Thandi Mokoena', email: 'thandi@example.com', phone: '0820000000',
  id_number: '9001015800083', address: '12 Long Street', city: 'Johannesburg', province: 'Gauteng',
};
const BIKE = { make: 'Hero', model: 'Eco 150', vin: 'VIN123', registration: 'ABC123GP' };

const OPERATOR = {
  name: 'Swift Couriers (Pty) Ltd',
  address: '5 Rivonia Road, Sandton',
  city: 'Johannesburg',
  registration_number: '2019/123456/07',
  vat_number: '4123456789',
  contact_phone: '011 000 0000',
};

const render = (mod, org) =>
  mod.contractTemplate({ agreement: AGREEMENT, rider: RIDER, bike: BIKE, application: null, org });

describe('an agreement on a fleet operator\'s bike', () => {
  const mod = loadContracts(null);
  const html = render(mod, OPERATOR);

  it('names the operator as the owner of the motorcycle', () => {
    expect(html).toContain('owned by Swift Couriers (Pty) Ltd');
    expect(html).toContain('remain the property of Swift Couriers (Pty) Ltd');
  });

  it('sends the weekly rental to the operator', () => {
    expect(html).toContain('payment of the Weekly Rental to Swift Couriers (Pty) Ltd');
  });

  it('serves notices at the operator\'s address, not the platform\'s', () => {
    expect(html).toContain('5 Rivonia Road, Sandton, Johannesburg');
    expect(html).not.toContain('Spionkop');
  });

  it('is signed by the operator', () => {
    expect(html).toContain('Swift Couriers (Pty) Ltd — authorised representative');
  });

  it('carries the operator\'s registration and VAT numbers', () => {
    expect(html).toContain('2019/123456/07');
    expect(html).toContain('4123456789');
  });

  // The point of the whole change: the platform must not appear as a party.
  it('never names the platform as owner, payee or addressee', () => {
    for (const clause of [
      'owned by OnFleet', 'property of OnFleet', 'Rental to OnFleet',
      'OnFleet shall be entitled', 'OnFleet domicilium', 'OnFleet Authorised Representative',
      'ONFLEET (PTY) LTD',
    ]) {
      expect(html).not.toContain(clause);
    }
  });
});

describe('an agreement on a bike the deployment owns itself', () => {
  const mod = loadContracts(null); // no BRAND set = OnFleet
  const html = render(mod, null);

  // OnFleet runs its own fleet, so for its own bikes the old wording was
  // right all along and must not have moved.
  it('still names OnFleet Africa, because OnFleet does own those bikes', () => {
    expect(html).toContain('owned by OnFleet Africa');
    expect(html).toContain('payment of the Weekly Rental to OnFleet Africa');
    expect(html).toContain('Unit E20, 472 Spionkop Avenue, Kya Sand, Johannesburg');
    expect(html).toContain('OnFleet Authorised Representative');
  });
});

describe('a deployment that owns no bikes at all', () => {
  const mod = loadContracts('pillion');

  it('says the lessor is not recorded rather than borrowing the platform\'s name', () => {
    const html = render(mod, null);
    expect(html).toContain('owned by Lessor not recorded');
    expect(html).not.toContain('Pillion and will at all times remain');
    expect(html).not.toContain('OnFleet');
  });

  it('still names the operator when there is one', () => {
    const html = render(mod, OPERATOR);
    expect(html).toContain('owned by Swift Couriers (Pty) Ltd');
    expect(html).not.toContain('OnFleet');
  });

  // The platform legitimately appears as the thing that recorded the signature
  // and generated the page — that is not a party to the agreement.
  it('still names itself as the platform that recorded the signature', () => {
    const signed = mod.contractTemplate({
      agreement: AGREEMENT, rider: RIDER, bike: BIKE, application: null,
      org: OPERATOR, signatureData: 'Thandi Mokoena',
    });
    expect(signed).toContain('recorded by the Pillion platform');
  });
});

describe('forgetting the lessor', () => {
  const mod = loadContracts(null);

  // Omitting it used to be invisible: the document just said OnFleet. A new
  // call site could put the wrong company on a signed contract and nothing
  // would go wrong until somebody tried to enforce it.
  it('is refused rather than quietly defaulted', () => {
    expect(() => mod.writeContractSnapshot({
      agreement: AGREEMENT, rider: RIDER, bike: BIKE, application: null, kind: 'unsigned',
    })).toThrow(/pass org/);
  });
});

describe('an operator with gaps in its record', () => {
  const mod = loadContracts(null);

  // Narrowed to the lessor's own clauses on purpose. The footer still reads
  // "Generated by the OnFleet Africa platform", and that is correct — it
  // names the software that produced the page, not a party to the agreement.
  // Keeping the two apart is the whole point of the change.
  it('says the name is not recorded rather than falling back to the platform', () => {
    const html = render(mod, { ...OPERATOR, name: null });
    expect(html).toContain('owned by Lessor name not recorded');
    expect(html).not.toContain('owned by OnFleet');
    expect(html).not.toContain('Rental to OnFleet');
    expect(html).not.toContain('OnFleet domicilium');
  });

  it('leaves out the VAT line when the operator has no VAT number', () => {
    const html = render(mod, { ...OPERATOR, vat_number: null });
    expect(html).not.toContain('VAT:');
    expect(html).toContain('Reg. No: 2019/123456/07');
  });
});

describe('an operator whose name is hostile to HTML', () => {
  const mod = loadContracts(null);

  it('escapes it everywhere it appears', () => {
    const html = render(mod, { ...OPERATOR, name: 'Bell & <script>Co</script>' });
    expect(html).not.toContain('<script>Co</script>');
    expect(html).toContain('Bell &amp; &lt;script&gt;Co&lt;/script&gt;');
  });
});

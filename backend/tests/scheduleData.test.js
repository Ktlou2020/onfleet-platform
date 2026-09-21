import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schedule = require('../assets/service-parts-hero-eco-150.json');
const chart = require('../assets/service-chart-hero-eco-150.json');
const catalogue = require('../assets/parts-hero-eco-150.json');

const plain = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The seeded reference data is the manufacturer's, transcribed from their
// spreadsheet and their PDF. These check the transcription, since a wrong
// number here is a rejected order or a service done at the wrong distance.
describe('the Hero Eco 150 reference data', () => {
  it('keeps the schedule and the chart to the shape the documents have', () => {
    expect(schedule.items).toHaveLength(29);
    expect(chart.services).toHaveLength(11);
    expect(chart.services[0]).toMatchObject({ service_no: 1, km_from: 500, km_to: 750 });
    expect(chart.services[10]).toMatchObject({ service_no: 11, km_from: 30000, km_to: 30500 });
    expect(chart.items.length).toBeGreaterThan(25);
  });

  it('services engine oil every 6 000 km from the first service, as the chart says', () => {
    const oil = schedule.items.find((i) => /engine\s+oil$/i.test(i.description));
    expect(oil.at_km.slice(0, 4)).toEqual([500, 6500, 12500, 18500]);
  });

  // Hero print 31916KRM4099S in the 36-month schedule but sell 31916KRM84099S.
  // They supply against the number requested, so the schedule's number would
  // be rejected; it is corrected here and the correction is recorded.
  it('uses the spark plug number Hero actually sell', () => {
    const plug = schedule.items.find((i) => /spark/i.test(i.description));
    expect(plug.part_number).toBe('31916KRM84099S');
    expect(plug.corrected_from).toBe('31916KRM4099S');
    expect(plug.correction_note).toMatch(/price list/i);
    expect(catalogue.parts.some((p) => plain(p.part_number) === plain(plug.part_number))).toBe(true);
  });

  // Read by description and confirmed, not matched on digits: the clutch
  // cable's nearest number is the cable's boot at a tenth of the price.
  it('uses the clutch parts Hero actually sell', () => {
    const cable = schedule.items.find((i) => i.description.trim() === 'Clutch Cable');
    expect(cable).toMatchObject({ part_number: '22870KTN950S', corrected_from: '22870KTN700S' });
    const kit = schedule.items.find((i) => i.description.trim() === 'Friction Plate Kit');
    expect(kit).toMatchObject({ part_number: 'K22222KTNA900EES', corrected_from: 'K22222KTNA900S' });

    const inList = new Set(catalogue.parts.map((p) => plain(p.part_number)));
    expect(inList.has(plain(cable.part_number))).toBe(true);
    expect(inList.has(plain(kit.part_number))).toBe(true);
  });

  // One is left: the price list has both a head cover gasket at R29.70 and a
  // second, different gasket at R1.98, and guessing between them would put the
  // wrong part on a bike. It stays flagged on the job card instead.
  it('knows exactly which scheduled part is still missing from the price list', () => {
    const inList = new Set(catalogue.parts.map((p) => plain(p.part_number)));
    const missing = schedule.items.filter((i) => !inList.has(plain(i.part_number))).map((i) => i.description.trim());
    expect(missing).toEqual(['Tappet Cover Gasket']);
  });

  it('carries a price for every part it does have', () => {
    expect(catalogue.parts).toHaveLength(860);
    expect(catalogue.parts.filter((p) => p.price_ex_vat == null)).toHaveLength(0);
    expect(catalogue.parts.filter((p) => p.is_kit)).toHaveLength(21);
  });
});

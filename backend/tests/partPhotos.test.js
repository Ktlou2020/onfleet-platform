import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgUser, createPgBike } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const partPhotos = load('../src/services/partPhotos.js');

// A technician does not know the part number — it is not written on the part.
// The photograph is how "which one is this" gets answered, so the thing these
// tests protect is that a photograph, once taken, is actually found again.

describe('finding a photo by the number on the page', () => {
  it('ignores how the number was punctuated', () => {
    expect(partPhotos.partKey('15410-KWB-601')).toBe('15410KWB601');
    expect(partPhotos.partKey('15410 KWB 601')).toBe('15410KWB601');
    expect(partPhotos.partKey('15410kwb601')).toBe('15410KWB601');
  });

  it('treats an empty or missing number as no key at all', () => {
    expect(partPhotos.partKey('')).toBe('');
    expect(partPhotos.partKey(null)).toBe('');
    expect(partPhotos.partKey('---')).toBe('');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('photographs of parts', () => {
  let tech;

  const add = (over = {}) => partPhotos.addPhoto({
    make: 'Honda', model: 'ACE 125', partNumber: '15410-KWB-601',
    filePath: 'part-1.jpg', originalName: 'IMG_0001.jpg', userId: tech.id, ...over,
  });

  beforeEach(async () => {
    await resetAllPgTables();
    tech = (await createPgUser({ role: 'technician', full_name: 'Thabo Technician' })).user;
  });

  it('files a photo against the part and hands back a usable url', async () => {
    const photo = await add();
    expect(photo).toMatchObject({ part_number: '15410-KWB-601', url: '/uploads/part-photos/part-1.jpg' });
  });

  // The rule the whole design rests on. The same physical part exists as two
  // catalogue rows — the OCR'd manufacturer book and the priced dealer list —
  // and the search shows the priced one. Keyed on the row, a photo would be
  // invisible about half the time.
  it('is found by any spelling of the same part number', async () => {
    await add({ partNumber: '15410-KWB-601' });
    for (const spelling of ['15410-KWB-601', '15410KWB601', '15410 kwb 601']) {
      const found = await partPhotos.photosForPart({ make: 'Honda', model: 'ACE 125', partNumber: spelling });
      expect(found, spelling).toHaveLength(1);
    }
  });

  it('does not hand a Honda photo to a different make or model', async () => {
    await add();
    expect(await partPhotos.photosForPart({ make: 'Bajaj', model: 'ACE 125', partNumber: '15410-KWB-601' })).toEqual([]);
    expect(await partPhotos.photosForPart({ make: 'Honda', model: 'CG 125', partNumber: '15410-KWB-601' })).toEqual([]);
  });

  it('matches the make and model whatever case they are written in', async () => {
    await add();
    expect(await partPhotos.photosForPart({ make: 'honda', model: 'ace 125', partNumber: '15410-KWB-601' })).toHaveLength(1);
  });

  it('answers for a whole page of results in one query', async () => {
    await add({ partNumber: '15410-KWB-601', filePath: 'a.jpg' });
    await add({ partNumber: '06430-KWB-601', filePath: 'b.jpg' });
    const byKey = await partPhotos.photosForParts({
      make: 'Honda', model: 'ACE 125',
      partNumbers: ['15410-KWB-601', '06430KWB601', '99999-NONE-000'],
    });
    expect(Object.keys(byKey).sort()).toEqual(['06430KWB601', '15410KWB601']);
  });

  it('asks nothing of the database when there are no numbers to look up', async () => {
    expect(await partPhotos.photosForParts({ make: 'Honda', model: 'ACE 125', partNumbers: [] })).toEqual({});
  });

  // A better photo supersedes a worse one without deleting the history.
  it('shows the newest photograph first', async () => {
    await add({ filePath: 'old.jpg' });
    await new Promise((r) => setTimeout(r, 10));
    await add({ filePath: 'new.jpg' });
    const found = await partPhotos.photosForPart({ make: 'Honda', model: 'ACE 125', partNumber: '15410-KWB-601' });
    expect(found[0].url).toContain('new.jpg');
    expect(found).toHaveLength(2);
  });

  it('says who took it, so a wrong one can be asked about', async () => {
    await add();
    const [photo] = await partPhotos.photosForPart({ make: 'Honda', model: 'ACE 125', partNumber: '15410-KWB-601' });
    expect(photo.taken_by).toBe('Thabo Technician');
  });

  it('refuses a photograph with no part number to file it against', async () => {
    await expect(add({ partNumber: '' })).rejects.toThrow(/part number/i);
  });

  it('removes a photo and reports what to unlink', async () => {
    const photo = await add();
    expect(await partPhotos.deletePhoto(photo.id)).toMatchObject({ file_path: 'part-1.jpg' });
    expect(await partPhotos.photosForPart({ make: 'Honda', model: 'ACE 125', partNumber: '15410-KWB-601' })).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the parts this workshop actually fits', () => {
  let tech;
  let bike;

  const fitPart = async (partNumber, description, { make = 'Honda', model = 'ACE 125', cost = 62 } = {}) => {
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, make, model, job_type, description, status, created_by)
       VALUES ($1,$2,$3,'service','x','completed',$4) RETURNING id`, [bike.id, make, model, tech.id]);
    await pgDb.query(
      `INSERT INTO job_card_items (job_card_id, item_type, description, quantity, unit_cost, part_number)
       VALUES ($1,'part',$2,1,$3,$4)`, [rows[0].id, description, cost, partNumber]);
  };

  beforeEach(async () => {
    await resetAllPgTables();
    tech = (await createPgUser({ role: 'technician' })).user;
    bike = await createPgBike();
  });

  // With thousands of parts in the book, search is the fallback. The part a
  // technician wants is usually one they fitted last week.
  it('ranks by how often a part is actually fitted', async () => {
    for (let i = 0; i < 3; i += 1) await fitPart('15410-KWB-601', 'FILTER, OIL');
    await fitPart('06430-KWB-601', 'PAD SET, REAR BRAKE');

    const top = await partPhotos.mostFitted({ make: 'Honda', model: 'ACE 125' });
    expect(top[0]).toMatchObject({ part_number: '15410-KWB-601', times_fitted: 3 });
    expect(top[1]).toMatchObject({ part_number: '06430-KWB-601', times_fitted: 1 });
  });

  // A part that is common on one bike is irrelevant on another.
  it('only counts what was fitted to this model', async () => {
    await fitPart('99999-XXX-001', 'SOMETHING ELSE', { model: 'CG 125' });
    await fitPart('15410-KWB-601', 'FILTER, OIL');
    const top = await partPhotos.mostFitted({ make: 'Honda', model: 'ACE 125' });
    expect(top.map((p) => p.part_number)).toEqual(['15410-KWB-601']);
  });

  it('ignores free-text lines that were never matched to a number', async () => {
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, make, model, job_type, description, status, created_by)
       VALUES ($1,'Honda','ACE 125','service','x','completed',$2) RETURNING id`, [bike.id, tech.id]);
    await pgDb.query(
      `INSERT INTO job_card_items (job_card_id, item_type, description, quantity, unit_cost)
       VALUES ($1,'part','some oil filter off the shelf',1,60)`, [rows[0].id]);
    expect(await partPhotos.mostFitted({ make: 'Honda', model: 'ACE 125' })).toEqual([]);
  });

  it('carries each part\'s photo so the list can be looked at rather than read', async () => {
    await fitPart('15410-KWB-601', 'FILTER, OIL');
    await partPhotos.addPhoto({
      make: 'Honda', model: 'ACE 125', partNumber: '15410KWB601',
      filePath: 'filter.jpg', userId: tech.id,
    });
    const [top] = await partPhotos.mostFitted({ make: 'Honda', model: 'ACE 125' });
    expect(top.photos[0].url).toBe('/uploads/part-photos/filter.jpg');
  });

  it('reports the last price paid, so a quote has somewhere to start', async () => {
    await fitPart('15410-KWB-601', 'FILTER, OIL', { cost: 71.5 });
    const [top] = await partPhotos.mostFitted({ make: 'Honda', model: 'ACE 125' });
    expect(top.last_cost).toBe(71.5);
  });
});

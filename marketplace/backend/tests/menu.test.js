import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { setup } = require('./helpers');
const orders = require('../src/orders');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };

beforeAll(() => { process.env.MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-media-')); });
// Thursday 5 Nov 2026, 12:00 SAST.
beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

async function world() {
  const t = await setup();
  const merchant = t.api(await t.login('merchant1@clicknpuff.africa'));
  const customer = t.api(await t.login('customer@clicknpuff.africa'));
  const storePage = async () => (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  const store = await storePage();
  const mine = async () => (await merchant.get('/api/merchant/products')).body.products;
  return { ...t, merchant, customer, store, storePage, mine };
}

describe('product photos', () => {
  it('uploads, serves and replaces a photo, and refuses non-images', async () => {
    const w = await world();
    const p = w.store.products[0];
    const up = await w.merchant.post(`/api/merchant/products/${p.id}/photo`, { dataUrl: PNG });
    expect(up.body.photoUrl).toMatch(/^\/media\/[a-f0-9]{24}\.png$/);
    const img = await request(w.app).get(up.body.photoUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await w.storePage()).products.find((x) => x.id === p.id).photoUrl).toBe(up.body.photoUrl);

    const fake = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
    expect((await w.merchant.post(`/api/merchant/products/${p.id}/photo`, { dataUrl: fake })).status).toBe(400);
    expect((await request(w.app).get('/media/../../etc/passwd')).status).toBe(404);
    await w.merchant.delete(`/api/merchant/products/${p.id}/photo`);
    expect((await w.storePage()).products.find((x) => x.id === p.id).photoUrl).toBeNull();
    const other = w.api(await w.login('merchant2@clicknpuff.africa'));
    expect((await other.post(`/api/merchant/products/${p.id}/photo`, { dataUrl: PNG })).status).toBe(404);
  });
});

describe('variants, featuring and availability', () => {
  it('hangs options off a main product, one level deep', async () => {
    const w = await world();
    const main = w.store.products[0];
    await w.merchant.patch(`/api/merchant/products/${main.id}`, { variantLabel: 'Small', featured: true });
    const opt = await w.merchant.post('/api/merchant/products', { name: main.name, category: main.category.slug, priceCents: main.priceCents + 5000, stock: 5, variantOf: main.id, variantLabel: 'Large' });
    expect(opt.status).toBe(201);
    const page = (await w.storePage()).products;
    expect(page.find((x) => x.id === opt.body.id)).toMatchObject({ variantOf: main.id, variantLabel: 'Large' });
    expect(page.find((x) => x.id === main.id)).toMatchObject({ featured: true, variantLabel: 'Small' });
    // No options of options, and a main product with options stays main.
    expect((await w.merchant.post('/api/merchant/products', { name: 'x', category: main.category.slug, priceCents: 100, stock: 1, variantOf: opt.body.id })).status).toBe(400);
    expect((await w.merchant.patch(`/api/merchant/products/${main.id}`, { variantOf: w.store.products[1].id })).status).toBe(400);
  });

  it('hides products outside their days or hours and refuses them at checkout', async () => {
    const w = await world();
    const p = w.store.products.find((x) => x.stock >= 10);
    expect((await w.merchant.patch(`/api/merchant/products/${p.id}`, { availableFrom: '18:00', availableTo: '09:00' })).status).toBe(400);
    await w.merchant.patch(`/api/merchant/products/${p.id}`, { availableFrom: '14:00' });
    expect((await w.storePage()).products.find((x) => x.id === p.id)).toBeUndefined();
    expect((await w.mine()).find((x) => x.id === p.id)).toMatchObject({ availableNow: false, availabilityNote: 'Available from 14:00' });
    const res = await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: p.id, qty: Math.ceil(10000 / p.priceCents) }], ...DROP });
    expect(res.status).toBe(409);

    await w.merchant.patch(`/api/merchant/products/${p.id}`, { availableFrom: '', availableDays: ['sat', 'sun'] });
    expect((await w.storePage()).products.find((x) => x.id === p.id)).toBeUndefined(); // it's Thursday
    await w.merchant.patch(`/api/merchant/products/${p.id}`, { availableDays: ['thu'] });
    expect((await w.storePage()).products.find((x) => x.id === p.id)).toBeTruthy();
  });
});

describe('stock', () => {
  it('alerts when an order takes stock past the store\'s own line, and suggests a reorder', async () => {
    const w = await world();
    const p = w.store.products.find((x) => x.priceCents >= 10000 && x.stock >= 3);
    await w.merchant.patch(`/api/merchant/products/${p.id}`, { stock: 6, lowStockAt: 5 });
    const seen = [];
    const on = (id) => seen.push(id);
    orders.bus.on('low_stock', on);
    try {
      await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: p.id, qty: 2 }], ...DROP });
      await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: p.id, qty: 1 }], ...DROP });
    } finally { orders.bus.off('low_stock', on); }
    expect(seen).toEqual([p.id]); // once, when it crossed the line
    expect((await w.mine()).find((x) => x.id === p.id)).toMatchObject({ stock: 3, lowStock: true, lowStockAt: 5 });
    const restock = (await w.merchant.get('/api/merchant/restock')).body.items;
    expect(restock.find((r) => r.id === p.id).suggestedOrder).toBeGreaterThan(0);
    const sheet = await w.merchant.get('/api/merchant/restock?format=csv');
    expect(sheet.headers['content-type']).toMatch(/text\/csv/);
    expect(sheet.text).toContain('suggested_order');
  });
});

describe('spreadsheet import and export', () => {
  it('round-trips the menu, previews changes and applies them only when clean', async () => {
    const w = await world();
    const exported = (await w.merchant.get('/api/merchant/products.csv')).text;
    expect(exported.split('\r\n')[0]).toBe('﻿id,name,category,price,unit,stock,low_stock_at,active,featured,option_of,option_label,description');
    const first = w.store.products[0];
    const sheet = `id,name,category,price,stock\n${first.id},${first.name},${first.category.slug},R 99.50,40\n,"Rolling tray, bamboo",accessories,149,12\n`;
    const preview = (await w.merchant.post('/api/merchant/products/import', { csv: sheet })).body;
    expect(preview).toMatchObject({ applied: false, created: 1, updated: 1, errors: 0 });
    expect((await w.mine()).find((x) => x.id === first.id).priceCents).toBe(first.priceCents); // nothing changed yet

    const done = (await w.merchant.post('/api/merchant/products/import', { csv: sheet, apply: true })).body;
    expect(done.applied).toBe(true);
    const after = await w.mine();
    expect(after.find((x) => x.id === first.id)).toMatchObject({ priceCents: 9950, stock: 40 });
    expect(after.find((x) => x.name === 'Rolling tray, bamboo')).toMatchObject({ priceCents: 14900, stock: 12 });

    const bad = (await w.merchant.post('/api/merchant/products/import', { csv: 'id,name,category,price\n99999,Ghost,papers,10\n,No category,,10\n', apply: true })).body;
    expect(bad).toMatchObject({ applied: false, errors: 2 });
    expect(bad.rows.map((r) => r.row)).toEqual([2, 3]);

    // Re-uploading an untouched export changes nothing.
    const again = (await w.merchant.post('/api/merchant/products/import', { csv: (await w.merchant.get('/api/merchant/products.csv')).text })).body;
    expect(again).toMatchObject({ created: 0, updated: 0, errors: 0 });
    expect(again.unchanged).toBe(after.length);
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const ordering = require('../src/services/partsOrdering.js');
const notifier = require('../src/services/notifier.js');
const { readWorkbook } = require('../src/services/xlsxReader.js');
const app = buildApp();

async function seedCatalogueAndSchedule() {
  await pgDb.query(`INSERT INTO parts_catalog (make, model, group_code, group_name, part_number, description, price_ex_vat, source)
    VALUES ('Hero','Eco 150','KIT','KITS','20K910S','CHAIN SPROCKET KIT (ACHIEVER)', 313.34, 'dealer_list'),
           ('Hero','Eco 150','KIT','KITS','K06431KTNA701S','KIT, BRAKE SHOE', 115.34, 'dealer_list'),
           ('Hero','Eco 150','E-1','CYLINDER HEAD COVER','12391AAK900S','GASKET HEAD COVER', 29.70, 'dealer_list')`);
  await pgDb.query(`INSERT INTO service_schedules (make, model, service_no, km_from, km_to)
    VALUES ('Hero','Eco 150',5,12000,12500)`);
  await pgDb.query(`INSERT INTO service_schedule_parts (make, model, description, part_number, at_km, qty)
    VALUES ('Hero','Eco 150','Brake Pads Front','K06431KTNA701S', ARRAY[12500]::int[], 1)`);
}

// A bike due for service, so the suggestion has something to find.
async function bikeDueForService() {
  const bike = await createPgBike({ make: 'Hero', model: 'Eco 150' });
  await pgDb.query(`UPDATE bikes SET odometer_km = 12500, next_service_km = 12500 WHERE id = $1`, [bike.id]);
  return bike;
}

describe.skipIf(!process.env.DATABASE_URL)('ordering parts from Hero', () => {
  let admin;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    await seedCatalogueAndSchedule();
  });

  describe('working out what to order', () => {
    it('gathers the parts a due service needs, priced from the dealer list', async () => {
      await bikeDueForService();
      const suggestion = await ordering.suggestOrder();
      const brake = suggestion.lines.find((l) => l.part_number === 'K06431KTNA701S');
      expect(brake).toMatchObject({ qty_to_order: 1, unit_price_ex_vat: 115.34 });
      expect(brake.reasons).toContain('Service due');
      expect(suggestion.total_ex_vat).toBe(115.34);
    });

    it('gathers parts a technician has put on an open job card', async () => {
      const bike = await createPgBike({ make: 'Hero', model: 'Eco 150' });
      const { rows } = await pgDb.query(
        `INSERT INTO job_cards (bike_id, job_type, status, make, model) VALUES ($1,'repair','open','Hero','Eco 150') RETURNING id`, [bike.id]);
      await pgDb.query(
        `INSERT INTO job_card_items (job_card_id, item_type, description, quantity, unit_cost, part_number)
         VALUES ($1,'part','GASKET HEAD COVER',2,29.70,'12391AAK900S')`, [rows[0].id]);
      const suggestion = await ordering.suggestOrder();
      const gasket = suggestion.lines.find((l) => l.part_number === '12391AAK900S');
      expect(gasket).toMatchObject({ qty_to_order: 2 });
      expect(gasket.reasons).toContain('On a job card');
    });

    it('adds up the same part across bikes instead of listing it twice', async () => {
      await bikeDueForService();
      await bikeDueForService();
      const suggestion = await ordering.suggestOrder();
      const lines = suggestion.lines.filter((l) => l.part_number === 'K06431KTNA701S');
      expect(lines).toHaveLength(1);
      expect(lines[0].qty_to_order).toBe(2);
    });

    it('leaves out what is already on an open order', async () => {
      await bikeDueForService();
      const first = await ordering.suggestOrder();
      await ordering.createOrder({ lines: first.lines, actorId: admin.id });
      const second = await ordering.suggestOrder();
      expect(second.lines.find((l) => l.part_number === 'K06431KTNA701S')).toBeUndefined();
    });

    it('counts it again once the order has been received', async () => {
      await bikeDueForService();
      const order = await ordering.createOrder({ lines: (await ordering.suggestOrder()).lines, actorId: admin.id });
      await ordering.setStatus({ orderId: order.id, status: 'received' });
      const again = await ordering.suggestOrder();
      expect(again.lines.find((l) => l.part_number === 'K06431KTNA701S')).toBeTruthy();
    });
  });

  describe('the request for quotation', () => {
    it('fills in Hero\'s own form, and leaves the rest of it alone', async () => {
      await bikeDueForService();
      const order = await ordering.createOrder({
        lines: (await ordering.suggestOrder()).lines, actorId: admin.id, deliveryMethod: 'collect', neededBy: '2026-09-28',
      });
      const rows = readWorkbook(ordering.renderRfq(order, { today: new Date('2026-09-21T08:00:00Z') }))[0].rows;

      expect(rows[1][0]).toMatch(/IMSA Motorcycles/);     // their letterhead, untouched
      expect(rows[19]).toEqual(expect.arrayContaining(['Line', 'Part Number', 'Description', 'Qty', 'Bike Model']));
      expect(rows[4][6]).toBe('2026-09-21');              // date
      expect(rows[7][6]).toBe('2026-09-28');              // required delivery date
      expect(rows[12][1]).toBe('OnFleet Africa');         // dealer name
      expect(rows[20].slice(1, 5)).toEqual(['K06431KTNA701S', 'KIT, BRAKE SHOE', '1', 'Hero Eco 150']);
    });

    it('names the file after the reference so a reply can be matched to it', async () => {
      const order = await ordering.createOrder({ lines: [{ part_number: 'X', description: 'Thing', qty: 1 }], actorId: admin.id });
      expect(ordering.rfqFileName(order)).toBe(`${order.reference}-Hero-SA.xlsx`);
      expect(order.reference).toMatch(/^RFQ-\d{4}-0001$/);
    });

    it('states the delivery term, as their SOP asks', async () => {
      const order = await ordering.createOrder({ lines: [{ part_number: 'X', description: 'Thing', qty: 1 }], actorId: admin.id, deliveryMethod: 'courier_hero' });
      expect(ordering.rfqEmailBody(order)).toMatch(/arrange courier delivery/i);
    });
  });

  describe('sending and tracking', () => {
    let order;
    let send;

    beforeEach(async () => {
      await bikeDueForService();
      order = await ordering.createOrder({ lines: (await ordering.suggestOrder()).lines, actorId: admin.id });
      send = vi.spyOn(notifier, 'sendEmailWithAttachment').mockResolvedValue({ delivered: true, provider: 'brevo' });
    });
    afterEach(() => send.mockRestore());

    it('emails the RFQ to Hero, with the form attached, and records who sent it', async () => {
      const res = await request(app).post(`/api/admin/parts-orders/${order.id}/send`).set(authHeader(admin)).send({});
      expect(res.status).toBe(200);
      const [to, subject, , attachment] = send.mock.calls[0];
      expect(to).toBe('parts@heromotorcycles.co.za');
      expect(subject).toMatch(order.reference);
      expect(attachment.name).toMatch(/\.xlsx$/);
      expect(readWorkbook(attachment.content)[0].rows[20][1]).toBe('K06431KTNA701S');

      const { rows } = await pgDb.query('SELECT status, sent_by, sent_to FROM parts_orders WHERE id = $1', [order.id]);
      expect(rows[0]).toMatchObject({ status: 'sent', sent_by: admin.id, sent_to: 'parts@heromotorcycles.co.za' });
    });

    it('will not send the same order twice', async () => {
      await request(app).post(`/api/admin/parts-orders/${order.id}/send`).set(authHeader(admin)).send({});
      const again = await request(app).post(`/api/admin/parts-orders/${order.id}/send`).set(authHeader(admin)).send({});
      expect(again.status).toBe(409);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('says so, and stays a draft, when no email provider is configured', async () => {
      send.mockResolvedValue({ delivered: false, reason: 'no_provider' });
      const res = await request(app).post(`/api/admin/parts-orders/${order.id}/send`).set(authHeader(admin)).send({});
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/download it and send it yourself/i);
      const { rows } = await pgDb.query('SELECT status FROM parts_orders WHERE id = $1', [order.id]);
      expect(rows[0].status).toBe('draft');
    });

    it('follows the quote back through to received', async () => {
      const put = (body) => request(app).put(`/api/admin/parts-orders/${order.id}/status`).set(authHeader(admin)).send(body);
      expect((await put({ status: 'quoted', quote_reference: 'QUO-4471', quoted_total_ex_vat: 115.34 })).body)
        .toMatchObject({ status: 'quoted', quote_reference: 'QUO-4471' });
      expect((await put({ status: 'ordered' })).body.status).toBe('ordered');
      const received = await put({ status: 'received' });
      expect(received.body.status).toBe('received');
      expect(received.body.received_at).toBeTruthy();
    });

    it('refuses a status that is not part of the flow', async () => {
      const res = await request(app).put(`/api/admin/parts-orders/${order.id}/status`).set(authHeader(admin)).send({ status: 'paid' });
      expect(res.status).toBe(400);
    });

    it('downloads the form for sending by hand', async () => {
      const res = await request(app).get(`/api/admin/parts-orders/${order.id}/rfq`)
        .set(authHeader(admin)).buffer(true).parse((response, cb) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/RFQ-\d{4}-\d{4}-Hero-SA\.xlsx/);
      expect(readWorkbook(res.body)[0].rows[20][1]).toBe('K06431KTNA701S');
    });
  });

  it('creates an order straight from what is needed, with no lines given', async () => {
    await bikeDueForService();
    const res = await request(app).post('/api/admin/parts-orders').set(authHeader(admin)).send({ delivery_method: 'collect' });
    expect(res.status).toBe(201);
    expect(res.body.items.map((i) => i.part_number)).toEqual(['K06431KTNA701S']);
    expect(res.body.items[0].reason).toMatch(/Service due/);
  });

  it('says there is nothing to order rather than making an empty one', async () => {
    const res = await request(app).post('/api/admin/parts-orders').set(authHeader(admin)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing to order/i);
  });
});

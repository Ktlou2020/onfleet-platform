import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const partsStock = createRequire(import.meta.url)('../src/services/partsStock.js');
const app = buildApp();

// The dealership half of the workshop.
//
// Until now a part could only leave the building fitted to a motorcycle.
// There was no stock, no buy price against a sell price, and nothing at all
// recorded when somebody bought a part across the counter.
//
// The thing these tests care most about is that the two ways of knowing how
// many are on a shelf never disagree. parts_stock.on_hand is a cache of the
// movements ledger, and a cache that can drift is a number nobody can argue
// with — so after every sequence here, the two are reconciled.

const PART = '12391AAK900S';

describe.skipIf(!process.env.DATABASE_URL)('stock on a shelf', () => {
  let manager, tech, rapid;

  const adjust = (user, body) =>
    request(app).post('/api/workshop/stock/adjust').set(authHeader(user)).send(body);
  const stock = (user, query = '') =>
    request(app).get(`/api/workshop/stock${query}`).set(authHeader(user));

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    manager = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });
  });

  it('starts at nothing and takes a delivery', async () => {
    expect(await partsStock.onHand(PART)).toBe(0);
    const res = await adjust(manager.user, { part_number: PART, quantity: 12, note: 'Opening count' });
    expect(res.status).toBe(200);
    expect(res.body.on_hand).toBe(12);
  });

  // A stock take says what is on the shelf, whatever the system believed. The
  // difference is what gets written, so the ledger still adds up to the count.
  it('a count overrides the number and the ledger still agrees', async () => {
    await adjust(manager.user, { part_number: PART, quantity: 12, note: 'Opening count' });
    const res = await adjust(manager.user, { part_number: PART, counted: 9, note: 'Monthly stock take' });
    expect(res.body.on_hand).toBe(9);

    const { rows } = await pgDb.query(
      `SELECT SUM(quantity)::numeric AS total FROM parts_stock_movements WHERE part_number_key = $1`,
      [partsStock.partKey(PART)]);
    expect(Number(rows[0].total)).toBe(9);
    expect(await partsStock.reconcile()).toEqual([]);
  });

  it('a count that matches changes nothing at all', async () => {
    await adjust(manager.user, { part_number: PART, quantity: 5, note: 'Opening' });
    const res = await adjust(manager.user, { part_number: PART, counted: 5, note: 'Stock take' });
    expect(res.body.unchanged).toBe(true);
    const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM parts_stock_movements');
    expect(rows[0].n, 'a movement was written for a count that did not move').toBe(1);
  });

  it('refuses an adjustment with no reason given', async () => {
    const res = await adjust(manager.user, { part_number: PART, quantity: 3 });
    expect(res.status).toBe(400);
  });

  it('shows what is low, and what the shelves are worth', async () => {
    await request(app).put('/api/workshop/stock/pricing').set(authHeader(manager.user))
      .send({ part_number: PART, cost_price_ex_vat: 30, sell_price_ex_vat: 55, reorder_level: 10 });
    await adjust(manager.user, { part_number: PART, quantity: 4, note: 'Opening' });

    const res = await stock(manager.user);
    expect(res.body.summary).toMatchObject({ low: 1 });
    expect(res.body.summary.value_at_cost).toBe(120);
    expect(res.body.stock[0]).toMatchObject({ low: true, on_hand: '4.00' });
  });

  // 860 Hero parts arrived with a list price. Making somebody retype each one
  // before the margin works would mean the margin never works.
  it('falls back to the Hero catalogue for a cost nobody has set', async () => {
    await pgDb.query(
      `INSERT INTO parts_catalog (make, model, group_code, group_name, part_number, description, price_ex_vat, source)
       VALUES ('Hero','Eco 150','E01','ENGINE',$1,'GASKET HEAD COVER',29.70,'dealer_list')`, [PART]);
    const price = await partsStock.priceFor(PART);
    expect(price).toMatchObject({ cost_price_ex_vat: 29.7, cost_is_catalogue: true });
  });

  it('and a price somebody has set wins over the catalogue', async () => {
    await pgDb.query(
      `INSERT INTO parts_catalog (make, model, group_code, group_name, part_number, description, price_ex_vat, source)
       VALUES ('Hero','Eco 150','E01','ENGINE',$1,'GASKET HEAD COVER',29.70,'dealer_list')`, [PART]);
    await request(app).put('/api/workshop/stock/pricing').set(authHeader(manager.user))
      .send({ part_number: PART, cost_price_ex_vat: 24 });
    const price = await partsStock.priceFor(PART);
    expect(price).toMatchObject({ cost_price_ex_vat: 24, cost_is_catalogue: false });
  });

  it('a technician may not set prices', async () => {
    const res = await request(app).put('/api/workshop/stock/pricing').set(authHeader(tech.user))
      .send({ part_number: PART, sell_price_ex_vat: 1 });
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('selling a part', () => {
  let manager, tech, rapid;

  const sell = (user, body) =>
    request(app).post('/api/workshop/sales').set(authHeader(user)).send(body);

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    manager = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });

    await request(app).put('/api/workshop/stock/pricing').set(authHeader(manager.user))
      .send({ part_number: PART, description: 'GASKET HEAD COVER', cost_price_ex_vat: 30, sell_price_ex_vat: 55 });
    await request(app).post('/api/workshop/stock/adjust').set(authHeader(manager.user))
      .send({ part_number: PART, quantity: 20, note: 'Opening stock' });
  });

  describe('across the counter', () => {
    it('takes the money, the stock and the margin', async () => {
      const res = await sell(tech.user, {
        channel: 'counter', payment_method: 'cash', customer_name: 'Walk-in',
        items: [{ part_number: PART, quantity: 2 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.sale).toMatchObject({ channel: 'counter', status: 'completed' });
      expect(Number(res.body.sale.subtotal_ex_vat)).toBe(110);
      expect(Number(res.body.sale.vat)).toBe(16.5);
      expect(Number(res.body.sale.total)).toBe(126.5);
      expect(res.body.margin, 'sold at 55, cost 30, two of them').toBe(50);
      expect(await partsStock.onHand(PART)).toBe(18);
    });

    // A cash sale to a stranger is still a sale. Demanding an account would
    // mean the till never gets used.
    it('and needs no name attached', async () => {
      const res = await sell(tech.user, { channel: 'counter', items: [{ part_number: PART, quantity: 1 }] });
      expect(res.status).toBe(201);
    });

    it('priced from the line when one is given', async () => {
      const res = await sell(tech.user, {
        channel: 'counter', items: [{ part_number: PART, quantity: 1, unit_price_ex_vat: 70 }],
      });
      expect(Number(res.body.sale.subtotal_ex_vat)).toBe(70);
      expect(res.body.margin).toBe(40);
    });

    it('but refused where nobody has said what it sells for', async () => {
      const res = await sell(tech.user, { channel: 'counter', items: [{ part_number: 'NOPRICE123', quantity: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/No selling price/);
    });
  });

  describe('on a fleet\'s account', () => {
    it('is owed by the fleet', async () => {
      const res = await sell(manager.user, {
        channel: 'account', organization_id: rapid.id, items: [{ part_number: PART, quantity: 3 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.sale).toMatchObject({ channel: 'account', organization_id: rapid.id, payment_method: 'account' });
    });

    it('and has to say whose account', async () => {
      const res = await sell(manager.user, { channel: 'account', items: [{ part_number: PART, quantity: 1 }] });
      expect(res.status).toBe(400);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM parts_sales');
      expect(rows[0].n).toBe(0);
    });

    it('and a fleet that does not exist is refused too', async () => {
      const res = await sell(manager.user, {
        channel: 'account', organization_id: 999999, items: [{ part_number: PART, quantity: 1 }],
      });
      expect(res.status).toBe(404);
    });
  });

  describe('when the shelf cannot cover it', () => {
    it('is refused, and says what is actually there', async () => {
      const res = await sell(tech.user, { channel: 'counter', items: [{ part_number: PART, quantity: 25 }] });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'NOT_ENOUGH_STOCK', on_hand: 20 });
      expect(await partsStock.onHand(PART), 'a refused sale moved stock').toBe(20);
    });

    // The part is in somebody's hand and the count is what is wrong. Overridable,
    // but it takes saying so.
    it('unless it is overridden deliberately', async () => {
      const res = await sell(tech.user, {
        channel: 'counter', allow_negative: true, items: [{ part_number: PART, quantity: 25 }],
      });
      expect(res.status).toBe(201);
      expect(await partsStock.onHand(PART)).toBe(-5);
    });

    // Nothing half-happens: a sale of four parts where the third runs out
    // must not leave two off the shelf and no sale recorded.
    it('and a multi-line sale is all or nothing', async () => {
      await request(app).post('/api/workshop/stock/adjust').set(authHeader(manager.user))
        .send({ part_number: 'SECOND999', quantity: 1, note: 'one only' });
      await request(app).put('/api/workshop/stock/pricing').set(authHeader(manager.user))
        .send({ part_number: 'SECOND999', cost_price_ex_vat: 10, sell_price_ex_vat: 20 });

      const res = await sell(tech.user, {
        channel: 'counter',
        items: [{ part_number: PART, quantity: 2 }, { part_number: 'SECOND999', quantity: 5 }],
      });
      expect(res.status).toBe(409);
      expect(await partsStock.onHand(PART), 'the first line moved although the sale failed').toBe(20);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM parts_sales');
      expect(rows[0].n).toBe(0);
    });
  });

  describe('undoing one', () => {
    let saleId;

    beforeEach(async () => {
      const res = await sell(tech.user, { channel: 'counter', items: [{ part_number: PART, quantity: 4 }] });
      saleId = res.body.sale.id;
    });

    it('puts the parts back without forgetting the sale', async () => {
      const res = await request(app).post(`/api/workshop/sales/${saleId}/void`)
        .set(authHeader(manager.user)).send({ reason: 'Customer returned them' });
      expect(res.status).toBe(200);
      expect(await partsStock.onHand(PART)).toBe(20);

      const { rows } = await pgDb.query('SELECT status, void_reason FROM parts_sales WHERE id = $1', [saleId]);
      expect(rows[0], 'a till that can forget a sale cannot be audited')
        .toMatchObject({ status: 'void', void_reason: 'Customer returned them' });
    });

    it('needs a reason', async () => {
      const res = await request(app).post(`/api/workshop/sales/${saleId}/void`)
        .set(authHeader(manager.user)).send({});
      expect(res.status).toBe(400);
    });

    it('only once', async () => {
      await request(app).post(`/api/workshop/sales/${saleId}/void`).set(authHeader(manager.user)).send({ reason: 'x' });
      const again = await request(app).post(`/api/workshop/sales/${saleId}/void`).set(authHeader(manager.user)).send({ reason: 'x' });
      expect(again.status).toBe(409);
      expect(await partsStock.onHand(PART), 'voiding twice put the parts back twice').toBe(20);
    });

    it('and not by a technician', async () => {
      const res = await request(app).post(`/api/workshop/sales/${saleId}/void`)
        .set(authHeader(tech.user)).send({ reason: 'oops' });
      expect(res.status).toBe(403);
    });
  });

  it('the day\'s takings add up', async () => {
    await sell(tech.user, { channel: 'counter', items: [{ part_number: PART, quantity: 2 }] });
    await sell(manager.user, { channel: 'account', organization_id: rapid.id, items: [{ part_number: PART, quantity: 1 }] });
    const res = await request(app).get('/api/workshop/sales').set(authHeader(manager.user));
    expect(res.body.summary).toMatchObject({ count: 2, counter: 1, account: 1 });
    expect(res.body.summary.sold_ex_vat).toBe(165);
    expect(res.body.summary.margin).toBe(75);
  });

  // The whole reason the ledger exists.
  it('and the shelf still agrees with its own history', async () => {
    await sell(tech.user, { channel: 'counter', items: [{ part_number: PART, quantity: 2 }] });
    const res = await sell(tech.user, { channel: 'counter', items: [{ part_number: PART, quantity: 3 }] });
    await request(app).post(`/api/workshop/sales/${res.body.sale.id}/void`)
      .set(authHeader(manager.user)).send({ reason: 'wrong part' });
    await request(app).post('/api/workshop/stock/adjust').set(authHeader(manager.user))
      .send({ part_number: PART, counted: 17, note: 'stock take' });

    expect(await partsStock.onHand(PART)).toBe(17);
    expect(await partsStock.reconcile(), 'the cached count drifted from the ledger').toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('stock moves with the rest of the workshop', () => {
  let manager, tech, bike, jobCardId;

  beforeEach(async () => {
    await resetAllPgTables();
    manager = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });
    bike = await createPgBike({ registration: 'RAP001GP' });
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, registration, job_type, description, status)
       VALUES ($1,'RAP001GP','service','Service','open') RETURNING id`, [bike.id]);
    jobCardId = rows[0].id;
    await request(app).post('/api/workshop/stock/adjust').set(authHeader(manager.user))
      .send({ part_number: PART, quantity: 10, note: 'Opening' });
  });

  // A part fitted to a motorcycle came off a shelf.
  it('fitting a part takes it off the shelf', async () => {
    const res = await request(app).post(`/api/workshop/job-cards/${jobCardId}/items`)
      .set(authHeader(tech.user))
      .send({ item_type: 'part', description: 'GASKET HEAD COVER', quantity: 2, unit_cost: 55, part_number: PART });
    expect(res.status).toBe(200);
    expect(await partsStock.onHand(PART)).toBe(8);
  });

  it('but labour does not', async () => {
    await request(app).post(`/api/workshop/job-cards/${jobCardId}/items`)
      .set(authHeader(tech.user))
      .send({ item_type: 'labor', description: 'Two hours', quantity: 2, unit_cost: 350 });
    expect(await partsStock.onHand(PART)).toBe(10);
  });

  // A phone replaying a write it queued offline must not eat the stock twice.
  it('and a replayed offline write does not take it twice', async () => {
    const line = {
      item_type: 'part', description: 'GASKET HEAD COVER', quantity: 1, unit_cost: 55,
      part_number: PART, client_request_id: 'phone-abc-123',
    };
    await request(app).post(`/api/workshop/job-cards/${jobCardId}/items`).set(authHeader(tech.user)).send(line);
    await request(app).post(`/api/workshop/job-cards/${jobCardId}/items`).set(authHeader(tech.user)).send(line);
    expect(await partsStock.onHand(PART), 'bad signal ate the stock twice').toBe(9);
  });

  it('receiving a parts order puts it on the shelf', async () => {
    const { rows: order } = await pgDb.query(
      `INSERT INTO parts_orders (reference, supplier, status) VALUES ('PO-1','Hero SA','ordered') RETURNING id`);
    await pgDb.query(
      `INSERT INTO parts_order_items (order_id, part_number, description, qty) VALUES ($1,$2,'GASKET HEAD COVER',6)`,
      [order[0].id, PART]);

    const res = await request(app).put(`/api/admin/parts-orders/${order[0].id}/status`)
      .set(authHeader(manager.user)).send({ status: 'received' });
    expect(res.status).toBe(200);
    expect(await partsStock.onHand(PART)).toBe(16);
  });

  it('and receiving it twice does not count the delivery twice', async () => {
    const { rows: order } = await pgDb.query(
      `INSERT INTO parts_orders (reference, supplier, status) VALUES ('PO-2','Hero SA','ordered') RETURNING id`);
    await pgDb.query(
      `INSERT INTO parts_order_items (order_id, part_number, description, qty) VALUES ($1,$2,'GASKET',6)`,
      [order[0].id, PART]);

    await request(app).put(`/api/admin/parts-orders/${order[0].id}/status`)
      .set(authHeader(manager.user)).send({ status: 'received' });
    await request(app).put(`/api/admin/parts-orders/${order[0].id}/status`)
      .set(authHeader(manager.user)).send({ status: 'received' });
    expect(await partsStock.onHand(PART)).toBe(16);
  });
});

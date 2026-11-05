'use strict';
const bcrypt = require('bcryptjs');
const { open } = require('./db');

// Demo data: four cities, eight stores, a rider in each city, and an admin.
// Every demo account uses the password "password123".
//
// Regulated categories are seeded but stay hidden until an admin both turns
// on regulated sales and verifies a store's licence — so a fresh install
// only shows the categories that are always allowed.

const CITIES = [
  ['johannesburg', 'Johannesburg', -26.1076, 28.0567],
  ['cape-town', 'Cape Town', -33.9249, 18.4241],
  ['durban', 'Durban', -29.8587, 31.0218],
  ['pretoria', 'Pretoria', -25.7479, 28.2293],
];

const CATEGORIES = [
  ['flower', 'Flower', '🌿', 1],
  ['pre-rolls', 'Pre-rolls', '🚬', 1],
  ['edibles', 'Edibles', '🍫', 1],
  ['extracts', 'Extracts', '💧', 1],
  ['cbd', 'CBD & Wellness', '🧴', 0],
  ['papers', 'Papers & Rolling', '📜', 0],
  ['accessories', 'Accessories', '🔥', 0],
  ['grow', 'Grow at Home', '🌱', 0],
];

const STORES = [
  ['johannesburg', 'Rosebank Botanicals', 'Small-batch, lab-tested, and delivered in under 40 minutes across the northern suburbs.', '12 Baker St, Rosebank', -26.1452, 28.0420, '#2f855a'],
  ['johannesburg', 'Maboneng Supply Co.', 'Rolling papers, glass and grow kit from the heart of Maboneng.', '286 Fox St, Maboneng', -26.2044, 28.0592, '#b7791f'],
  ['cape-town', 'Bree Street Apothecary', 'Wellness-first CBD, topicals and accessories in the city bowl.', '101 Bree St, Cape Town', -33.9186, 18.4180, '#2c7a7b'],
  ['cape-town', 'Observatory Grow Shop', 'Everything you need to grow your own, legally, at home.', '45 Lower Main Rd, Observatory', -33.9378, 18.4705, '#6b46c1'],
  ['durban', 'Florida Road Collective', 'Durban’s favourite for papers, pipes and CBD.', '200 Florida Rd, Morningside', -29.8296, 31.0119, '#c05621'],
  ['durban', 'Umhlanga Wellness', 'Premium CBD oils and balms on the coast.', '2 Lagoon Dr, Umhlanga', -29.7266, 31.0848, '#2b6cb0'],
  ['pretoria', 'Hatfield Hub', 'Student-friendly prices on papers, grinders and grow kit.', '1122 Burnett St, Hatfield', -25.7487, 28.2380, '#9b2c2c'],
  ['pretoria', 'Menlyn Leaf & Co.', 'Curated CBD and accessories, delivered fast in the east.', 'Menlyn Maine, Pretoria', -25.7826, 28.2775, '#276749'],
];

// [category, name, description, price R, unit, thc, cbd, strain]
const PRODUCTS = [
  ['papers', 'King-size slim papers (32)', 'Unbleached, slow-burning.', 35, 'pack'],
  ['papers', 'Rolling tips booklet', '50 perforated tips.', 20, 'pack'],
  ['papers', 'Pre-rolled cones (6)', 'King-size, unbleached hemp.', 60, 'pack'],
  ['accessories', '4-piece aluminium grinder', 'Kief catcher, 55 mm.', 220, 'each'],
  ['accessories', 'Glass water pipe', '25 cm borosilicate.', 650, 'each'],
  ['accessories', 'Smell-proof stash bag', 'Carbon-lined, lockable.', 280, 'each'],
  ['accessories', 'Refillable lighter', 'Windproof jet flame.', 90, 'each'],
  ['cbd', 'CBD oil 600 mg', 'Broad-spectrum, 30 ml. Within the daily exempt limit.', 450, 'bottle', 0, 2],
  ['cbd', 'CBD muscle balm', 'Arnica and menthol, 50 ml.', 320, 'tub', 0, 1],
  ['cbd', 'CBD sleep gummies (20)', '10 mg each, with melatonin-free chamomile.', 380, 'pack', 0, 10],
  ['grow', 'Autoflower grow kit', 'Fabric pot, coco, nutrients, pH strips.', 890, 'kit'],
  ['grow', 'LED grow light 100 W', 'Full spectrum, dimmable.', 1650, 'each'],
  ['grow', 'Organic bloom nutrients', '1 L concentrate.', 260, 'bottle'],
  ['flower', 'Durban Poison', 'Sativa landrace. Sweet, anise, energising.', 140, 'gram', 19, 0.5, 'sativa'],
  ['flower', 'Swazi Gold', 'Sativa landrace, citrus and spice.', 130, 'gram', 17, 0.3, 'sativa'],
  ['flower', 'Malawi Gold', 'Sativa, earthy and sweet.', 150, 'gram', 21, 0.2, 'sativa'],
  ['pre-rolls', 'Classic pre-roll (1 g)', 'Hand-rolled, unbleached cone.', 120, 'each', 18, 0.4, 'hybrid'],
  ['edibles', 'Dark chocolate square', '70% cacao. Start low, go slow.', 90, 'each', 5, 0, null],
  ['extracts', 'Full-spectrum tincture', '10 ml with dropper.', 550, 'bottle', 30, 10, null],
];

async function seed(db = open()) {
  const hash = await bcrypt.hash('password123', 10);
  const tx = db.transaction(() => {
    for (const [slug, name, lat, lng] of CITIES) db.prepare('INSERT OR IGNORE INTO cities (slug, name, lat, lng) VALUES (?, ?, ?, ?)').run(slug, name, lat, lng);
    CATEGORIES.forEach(([slug, name, icon, regulated], i) => db.prepare('INSERT OR IGNORE INTO categories (slug, name, icon, regulated, sort) VALUES (?, ?, ?, ?, ?)').run(slug, name, icon, regulated, i));
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n) return false;

    const user = (email, name, role, extra = {}) => db.prepare(`
      INSERT INTO users (email, password_hash, name, phone, role, id_number, dob, age_verified) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(email, hash, name, extra.phone || '0821234567', role, extra.id || null, '1990-01-01').lastInsertRowid;

    user('admin@verdant.africa', 'Platform Admin', 'admin');
    user('customer@verdant.africa', 'Naledi Dlamini', 'customer');

    const cityId = (slug) => db.prepare('SELECT id FROM cities WHERE slug = ?').get(slug).id;
    const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;

    STORES.forEach(([city, name, description, address, lat, lng, accent], i) => {
      const owner = user(`merchant${i + 1}@verdant.africa`, `${name} Owner`, 'merchant');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
      const storeId = db.prepare(`
        INSERT INTO stores (owner_id, slug, name, description, city_id, address, lat, lng, status, accent, prep_minutes, licence_number, rating_sum, rating_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)
      `).run(owner, slug, name, description, cityId(city), address, lat, lng, accent, 8 + (i % 4) * 3, i % 2 === 0 ? `DEMO-LIC-${1000 + i}` : null, 46 * (i + 3), 10 * (i + 3)).lastInsertRowid;
      PRODUCTS.forEach(([cat, pname, pdesc, rand, unit, thc, cbd, strain], j) => {
        if ((i + j) % 3 === 2) return; // vary each store's range
        db.prepare(`INSERT INTO products (store_id, category_id, name, description, price_cents, unit, stock, thc_pct, cbd_pct, strain_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(storeId, catId(cat), pname, pdesc, Math.round(rand * (1 + (i % 3) * 0.05)) * 100, unit, 5 + ((i * 7 + j * 3) % 40), thc ?? null, cbd ?? null, strain ?? null);
      });
    });

    CITIES.forEach(([city, name, lat, lng], i) => {
      const id = user(`rider${i + 1}@verdant.africa`, `${name} Rider`, 'rider');
      db.prepare('INSERT INTO riders (user_id, vehicle, plate, online, lat, lng) VALUES (?, ?, ?, 0, ?, ?)').run(id, 'motorbike', `DEMO ${100 + i} GP`, lat, lng);
    });
    return true;
  });
  return tx();
}

if (require.main === module) {
  seed().then((did) => {
    console.log(did ? 'Seeded demo data. Every demo account uses password123.' : 'Database already has users — left it alone.');
  });
}

module.exports = { seed };

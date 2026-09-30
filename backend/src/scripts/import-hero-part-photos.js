'use strict';

// Manufacturer photographs for the parts catalogue.
//
// A technician does not know a part number — it is not written on the part —
// so the parts picker shows a photograph and offers the camera where there is
// none. That fills in slowly, in the order parts actually get used. Hero
// publishes a photograph of most of its parts on its own spares shop, and the
// part number is in the product's address, so the obvious first pass is to
// take the ones that match and leave the camera for the rest.
//
// Where the data comes from, and why it is the sitemap rather than the shop:
// shop.heromotocorp.com/robots.txt disallows /search, and publishes
// sitemap.xml. The product sitemaps are image sitemaps — every product entry
// carries its primary photograph — so the whole index costs three requests
// against a file published for exactly this, instead of seven thousand page
// loads against a search the site has asked crawlers not to use.
//
// The match is the part number, normalised the same way the catalogue's own
// index normalises it: 15410-KWB-601 and 15410KWB601 are one part. A number
// is only taken when it appears in full; the shop truncates some filenames
// (12213-ksp.jpeg for 12213KSP910S) and a prefix is not a match.
//
// What this cannot do: the shop sells India's models. Roughly a third of an
// Eco 150 catalogue is there, because Hero shares fasteners, bearings and
// engine internals across models; the rest is body and trim that India's
// range does not use. The camera is still how those get covered.
//
// Usage:
//   node src/scripts/import-hero-part-photos.js                  # dry run
//   node src/scripts/import-hero-part-photos.js --write
//   node src/scripts/import-hero-part-photos.js --model "Eco 150" --write

const fs = require('fs');
const path = require('path');
const https = require('https');
const pgDb = require('../pgDb');
const storageService = require('../services/storageService');

const SITEMAP = 'https://shop.heromotocorp.com/sitemap.xml';
// Says who this is and why, so an operator reading their logs can tell it
// from a scraper and find a person to ask.
const USER_AGENT = 'OnFleet-workshop-catalogue/1.0 (+https://portal.onfleet.africa; parts catalogue photographs)';
const PAUSE_MS = 300;

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] || true);
};
const WRITE = args.includes('--write');
const MAKE = String(flag('make', 'Hero'));
const MODEL = String(flag('model', 'Eco 150'));
const LIMIT = Number(flag('limit', 0)) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The catalogue's own normalisation, repeated here so the two agree. */
const partKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function get(url, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, { binary }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(binary ? { buffer: buf, contentType: res.headers['content-type'] } : buf.toString('utf8'));
      });
    }).on('error', reject);
  });
}

/** Every product the shop publishes, as a haystack to match part numbers in. */
async function shopIndex() {
  const index = await get(SITEMAP);
  const maps = [...index.matchAll(/<loc>([^<]*sitemap-products[^<]*)<\/loc>/g)].map((m) => m[1]);
  const products = [];
  for (const map of maps) {
    const xml = await get(map);
    const entries = xml.matchAll(
      /<loc>([^<]+?\/product\/[^<]+)<\/loc>\s*(?:<image:image><image:loc>([^<]+)<\/image:loc><\/image:image>)?/g);
    for (const [, product, image] of entries) {
      if (!image) continue;
      const slug = product.split('/').pop();
      const file = image.split('/').pop();
      products.push({ product, image, haystack: partKey(slug + file) });
    }
    await sleep(PAUSE_MS);
  }
  return products;
}

function findPhoto(partNumber, products) {
  const key = partKey(partNumber);
  if (key.length < 8) return null;
  // Our dealer numbers carry a trailing S the shop's sometimes drops.
  const alt = key.endsWith('S') && key.length > 9 ? key.slice(0, -1) : null;
  const hit = products.find((p) => p.haystack.includes(key) || (alt && p.haystack.includes(alt)));
  if (!hit) return null;
  return picturesThePart(key, hit.image) ? hit : null;
}

/**
 * Whether the photograph is of this part, or just of Hero.
 *
 * Some products carry a marketing image instead of the part: a red "Hero
 * Genuine Parts" box, captioned "image shown is for representation purposes
 * only". Fifteen of two hundred and fifty-six in the first run were that box.
 * It is worse than no photograph — a technician looking for the part they are
 * holding learns nothing from a picture of packaging, and it fills the square
 * that would otherwise be the camera button.
 *
 * The test is the image's own filename. A real one is named for the part
 * (12213-ksp.jpeg for 12213KSP910S, 30700kj9020s-a.jpeg for 30700KJ9020S),
 * truncated to the first block or two; the marketing image is named after the
 * campaign. Five characters is the shortest truncation the shop uses.
 */
function picturesThePart(key, imageUrl) {
  const file = partKey(imageUrl.split('/').pop());
  if (file.includes(key)) return true;
  if (key.endsWith('S') && file.includes(key.slice(0, -1))) return true;
  for (let n = key.length; n >= 5; n -= 1) {
    if (file.includes(key.slice(0, n))) return true;
  }
  return false;
}

async function store(buffer, contentType, filename) {
  if (storageService.isConfigured()) {
    await storageService.putObject(`part-photos/${filename}`, buffer, contentType || 'image/jpeg');
    return 'r2';
  }
  // Required here rather than at the top on purpose: uploadPaths creates
  // every upload directory the moment it is required, and the path it creates
  // is the one the deployment's environment names. Run with a production
  // environment from a laptop, that is a container path like
  // /app/backend/data/uploads and the script dies on require before it has
  // done anything. Where R2 is configured no local directory is wanted at
  // all, so this is only reached when one genuinely is.
  const UPLOAD_DIRS = require('../uploadPaths');
  fs.mkdirSync(UPLOAD_DIRS.partPhotos, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIRS.partPhotos, filename), buffer);
  return 'disk';
}

async function main() {
  console.log(`[hero-photos] ${MAKE} ${MODEL} — ${WRITE ? 'writing' : 'dry run, nothing will be written'}`);

  const { rows: parts } = await pgDb.query(
    `SELECT DISTINCT ON (UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')))
            part_number, description
       FROM parts_catalog
      WHERE LOWER(make) = LOWER($1) AND LOWER(model) = LOWER($2)
      ORDER BY UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')), id`,
    [MAKE, MODEL]);
  if (!parts.length) {
    console.log('[hero-photos] no parts in the catalogue for that make and model');
    return;
  }

  // Already photographed — by a technician or by an earlier run — is left
  // alone. A photograph somebody took of the part in their hand beats a
  // catalogue picture of it.
  const { rows: existing } = await pgDb.query(
    `SELECT part_number_key FROM part_photos WHERE LOWER(make) = LOWER($1) AND LOWER(model) = LOWER($2)`,
    [MAKE, MODEL]);
  const have = new Set(existing.map((r) => r.part_number_key));

  const products = await shopIndex();
  console.log(`[hero-photos] ${products.length} products on the shop, ${parts.length} parts in the catalogue`);

  const todo = [];
  let already = 0;
  let unmatched = 0;
  for (const part of parts) {
    if (have.has(partKey(part.part_number))) { already += 1; continue; }
    const hit = findPhoto(part.part_number, products);
    if (!hit) { unmatched += 1; continue; }
    todo.push({ ...part, ...hit });
  }

  console.log(`[hero-photos] ${todo.length} to fetch · ${already} already have a photo · ${unmatched} not on the shop or pictured only by a stock image`);
  if (!WRITE) {
    for (const t of todo.slice(0, 10)) console.log(`   ${t.part_number}  ${t.image.split('/').pop()}`);
    if (todo.length > 10) console.log(`   … and ${todo.length - 10} more`);
    console.log('[hero-photos] dry run — pass --write to fetch and store these');
    return;
  }

  let stored = 0;
  let failed = 0;
  for (const [i, item] of (LIMIT ? todo.slice(0, LIMIT) : todo).entries()) {
    try {
      const { buffer, contentType } = await get(item.image, { binary: true });
      const matched = item.image.match(/\.(jpe?g|png|webp)$/i);
      const ext = (matched ? matched[1] : 'jpg').toLowerCase();
      const filename = `hero-${partKey(item.part_number)}.${ext}`;
      await store(buffer, contentType, filename);

      // client_request_id carries a unique index, so a second run cannot
      // produce a second row for the same part.
      await pgDb.query(
        `INSERT INTO part_photos
           (make, model, part_number, part_number_key, file_path, original_name, caption, client_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING`,
        [MAKE, MODEL, item.part_number, partKey(item.part_number), filename,
         item.image.split('/').pop(),
         'Manufacturer photograph — Hero MotoCorp',
         `hero-shop:${MAKE}:${MODEL}:${partKey(item.part_number)}`]);
      stored += 1;
      if ((i + 1) % 25 === 0) console.log(`[hero-photos] ${i + 1}/${todo.length}…`);
    } catch (e) {
      failed += 1;
      console.warn(`[hero-photos] ${item.part_number}: ${e.message}`);
    }
    await sleep(PAUSE_MS);
  }

  console.log(`[hero-photos] done — ${stored} stored, ${failed} failed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('[hero-photos]', e); process.exit(1); });

# ClickNPuff — on-demand delivery marketplace

A multi-store, one-hour delivery marketplace for South Africa's four biggest metros (Johannesburg, Cape Town, Durban, Pretoria). Customers order from nearby local stores, riders are dispatched automatically, and the order is tracked live from store to door.

This lives beside the OnFleet bike platform but is fully self-contained: its own API, database and web app. Riders and bikes from OnFleet are an obvious supply of delivery capacity.

> **Legal first.** South Africa's Cannabis for Private Purposes Act (2024) decriminalises private adult use, possession and cultivation. As far as we know it does **not** create a lawful route for commercial sale or delivery of cannabis. The platform is therefore built **compliance-first**:
>
> - Regulated categories (flower, pre-rolls, edibles, extracts) are **off by default** platform-wide.
> - Even when switched on, a regulated product only goes live if an admin has **verified that store's licence** and the licence **covers that category**.
> - Unregulated categories (papers, accessories, grow-at-home kit, exempt-dose CBD) work from day one.
>
> Get written advice from a South African cannabis/regulatory attorney before switching regulated sales on. Also confirm with your payment provider that your merchant category is accepted. Paystack and card acquirers apply their own restricted-goods rules.

## What makes it better than the incumbents

| | |
|---|---|
| **Speed you can see** | Live rider map over Server-Sent Events, honest ETAs (prep time + dispatch + road-distance travel), automatic nearest-rider dispatch. |
| **Trust & responsibility** | 18+ gate, SA ID number verification (Luhn check + date of birth + age) before the first order, one ID per account, and a **door handover that needs both an ID check and the customer's 4-digit code**. |
| **Transparent pricing** | VAT-inclusive prices (as the CPA requires), delivery + service fees shown before payment, free delivery over R600, minimum order R100. |
| **Store console** | Tablet-first live board (New → Preparing → Ready → With rider) that keeps chiming until a new order is accepted; accept with a prep-time choice that resets the customer's ETA; decline with a reason (or pause instead); prep countdowns, "rider is at the counter", printable packing slips. Busy mode (+10/20/30 min), pause for 15 min–2 h, weekly opening hours that close the store automatically (customers see "Opens tomorrow at 09:00"). Menu with search, sold-out toggle, quick stock, low-stock alerts and weekly sales per item. Insights (sales, orders, average order, prep time, acceptance, rating, busiest hours, best sellers), weekly payout statements, and reviews with public replies. |
| **Customer app** | Saved addresses (Home, Work…) picked with one tap; favourite stores (♥) with their own row on home; *Order again* from home or any past order, flagging what's sold out; promo codes at checkout with suggested offers (WELCOME20 — 20% off a first order up to R60; FREEDEL — free delivery over R250), funded by the platform so stores keep their full item total; sort by fastest / top rated / nearest and filter by open now or cheap delivery; a live *arriving in ~N min* countdown from the rider's position; optional browser alerts when the order moves on; *Report a problem* on any order, answered by the control room; an Account page with details, password, ID status and addresses. |
| **Rider app** | Full-screen, map-first driver app. Trip offers with a 30-second countdown that show pay, tip, distances and time up front; a declined or missed offer moves to the next nearest rider. Step-by-step trips (arrive at store → tick off items → collect → arrive at door → ID check + code), a proper return-to-store flow that still pays the rider, busy-area map layer, Google Maps/Waze hand-off, sound + vibration on offers, screen kept awake while online, pause new trips. Earnings by day and trip with tips, acceptance/completion rates and rating. SOS (SAPS 10111, ambulance 10177, alert to the control room) and incident reports. |
| **Control room** | Sidebar console. **Dashboard**: today vs yesterday (orders, sales, net revenue after rider pay, order-to-door time, cancellation rate, new customers), a *Needs attention* queue (SOS, late orders, orders with no rider, stores slow to accept, approvals), 14-day and hourly charts, top stores. **Live map** of every active order, online rider and store. **Orders**: filters, search, a detail drawer with timeline and offer history, reassign rider, cancel & refund. **Stores**, **Riders** and **Customers** with suspend/reinstate. **Incidents**, compliance **Settings**, a searchable **Audit log**, and **Profile & team**: edit your details, change password, last sign-in, your activity, add admins with a one-time password (forced change on first sign-in) and remove access. |

## Run it

```bash
# API (port 4100)
cd marketplace/backend
npm install
npm run seed        # 4 cities, 8 stores, riders, demo accounts
npm run dev

# Web app (port 5174), in another terminal
cd marketplace/frontend
npm install
npm run dev
```

Open http://localhost:5174. On the sign-in page (dev mode) there are one-tap demo logins. Every demo password is `password123`:

| Role | Email |
|---|---|
| Customer | `customer@clicknpuff.africa` |
| Store (Rosebank Botanicals) | `merchant1@clicknpuff.africa` … `merchant8@` |
| Rider (Jo'burg, CPT, DBN, PTA) | `rider1@clicknpuff.africa` … `rider4@` |
| Admin | `admin@clicknpuff.africa` |

To try the whole loop, use three browser windows: the customer orders, the store accepts and marks the order ready, and the rider goes online, collects and delivers. In dev the rider screen has a **Simulate move** button, so you can watch the rider pin move on the customer's map.

Tests: `cd marketplace/backend && npm test` (SA ID parsing, licence gating, delivery hours, the full order lifecycle, stock, permissions).

## Ordering outside delivery hours

Customers can order and pay at any time. If the platform isn't delivering yet (outside the hours set under Admin → Settings), or the store is closed by its own opening hours, the order is held as **Scheduled**, and the customer is told exactly when it will be delivered, for example "tomorrow at 08:00". The server releases it to the store as a normal new order at that time. The delivery estimate restarts from then, and the customer can cancel for a full refund until it's released. Stores see upcoming pre-orders under their board. A store that is paused or switched off still can't take orders. Logic: `backend/src/schedule.js`.

## Installable app (PWA)

ClickNPuff installs to the home screen on Android and iPhone (Share → Add to Home Screen), opens full-screen, and still opens with no signal (`frontend/public/sw.js`; live data is never cached). Push notifications reach phones with the app closed:

- **Customers:** store accepted, packed, on the way, rider outside, delivered, declined, refunded.
- **Riders:** new trip offers with the payout, even with the screen off.
- **Stores:** new orders.

iPhone needs iOS 16.4+ and the app added to the home screen before push works. A PWA can't track GPS in the background, so riders keep the app on screen on a mount. A native Android wrapper is the next step for background GPS.

Push keys: set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` to pin them. Otherwise a pair is generated once and kept in the database (`VAPID_SUBJECT` defaults to `mailto:help@clicknpuff.co.za`).

## Rider pay

R18 per trip + R5 per km (to the store and on to the customer), at least R25. Customer tips (chosen at checkout) are added on top and go to the rider in full. The rider sees the total before accepting. Rates live in `backend/src/orders.js` (`RIDER_PAY`).

## Store console

Stores run everything from `/merchant`, on a counter tablet or a phone.

- **Orders:** a live board (New → Preparing → Ready → With rider) with a repeating chime and push alerts. Stores can accept orders by hand or automatically, and set busy time or pause. If an order is still waiting after 3 minutes there's a reminder push (plus an SMS when BulkSMS is set up); after 10 minutes the order is declined and the customer refunded. When something is sold out the customer chooses: go ahead without it (refunded for that item) or cancel. Packing slips fit 58/80 mm receipt printers or A4 and carry a bag code and barcode, which the rider confirms at pickup. Regulated orders must be sealed in a labelled 18+ bag.
- **Menu:**
  - photos
  - sizes and flavours as options of one product
  - ⭐ store picks
  - days and hours each product is on sale
  - a low-stock line per product, with alerts and a restock list
  - spreadsheet export and import with a preview before anything changes
- **Money:**
  - the balance owed
  - bank details (changing them needs the password)
  - payout history
  - statements for any dates, as PDF or CSV
  - earnings by week
  - VAT and company details
- **Promotions:** the store's own codes, paid for by the store (the discount comes off its payout) and valid only at that store.
- **Insights:**
  - sales
  - acceptance
  - prep time
  - busy hours
  - best sellers
  - new vs returning customers, repeat rate and top suburbs
- **Reviews:** public replies. Ratings of 3 stars or less send a push and stay flagged until someone replies.
- **Team:**
  - The owner adds packers (the order board and stock only) and managers (everything except money and the team). Each person gets their own login and must choose a password at first sign-in.
  - An activity log records who did what.
- **Branches:** one owner login runs several stores, switched from the top of the console. The server checks every request is for a store that person belongs to (the `X-Store-Id` header).
- **Licence:** the expiry date gets reminders at 60, 30 and 7 days. Once it lapses, regulated products hide automatically until a renewal is verified.

The platform side (admin → Payouts) shows what each store is owed, downloads a payment list, and records each EFT with its bank reference. Bank details changed in the past 7 days are flagged so they can be confirmed by phone first. Refunds after delivery are charged to the store (up to what it earned on that order) or the platform. Customers get a tax invoice that splits the goods (from the store) from delivery and service (from the platform). Set the platform's VAT number under admin → Settings once registered.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `4100` | API port |
| `CLICKNPUFF_DB` | `backend/clicknpuff.db` | SQLite file (`CLOUD9_DB`, the old name, still works) |
| `JWT_SECRET` | dev value | **Required** in production |
| `PAYMENT_PROVIDER` | `mock` | `paystack` for live payments |
| `PAYSTACK_SECRET_KEY` | | Paystack secret key |
| `PUBLIC_URL` | `http://localhost:5174` | Where Paystack sends customers back |
| `CORS_ORIGIN` | any | Comma-separated allowed origins |
| `MAP_TILE_URL` | OpenStreetMap tiles | Map tile template, e.g. a MapTiler or Stadia URL with your key. OpenStreetMap's own tiles are free for light use only |
| `MAP_TILE_ATTRIBUTION` | © OpenStreetMap contributors | Credit line shown on maps (required by every provider) |
| `GEOCODER` | `photon` | Address search: `photon` (free OpenStreetMap search, fair use) or `maptiler` |
| `MAPTILER_KEY` | | Needed when `GEOCODER=maptiler` |

Paystack webhook: point it at `POST /api/payments/paystack/webhook` (HMAC-SHA512 signature verified). Cancelled and declined paid orders are refunded through the provider.

The brand name lives in `frontend/src/lib.jsx` (`BRAND`), so renaming takes one line.

## Architecture

```
backend/src
  app.js         routes (auth, catalogue, basket/quote, orders, merchant, rider, admin)
  compliance.js  SA ID parsing, age, what may be sold, delivery hours: one file for counsel to review
  orders.js      the order state machine, live-update bus, rider dispatch
  pricing.js     distance, fees, VAT, ETA
  payments.js    mock + Paystack (initialise, verify, refund, webhook signature)
  merchant.js    store console: board, menu, insights, reviews, missed-order sweep
  money.js       balances, payouts, statements, refunds after delivery, invoices, store promos
  team.js        store roles and branches (who may do what, in which store)
  staff.js       staff logins, activity log, review alerts, licence expiry sweep
  push.js        web push (VAPID) for customers, riders and store teams
  db.js          SQLite schema
frontend/src
  lib.jsx        API client, auth/cart/location state, live order hook
  pages/         Home, Store, Checkout, Orders/Track, Merchant, Rider, Admin, Auth, Docs (statement, invoice)
```

Every order status change goes through `orders.transition()`, which checks who may move the order from which status to which, and handles restocking, refunds, the event log, live pushes and dispatch.

## Roadmap to world class

1. **Native apps.** Wrap the web app with Capacitor for the stores and add push notifications (order status, rider nearby). The rider app needs background GPS.
2. **Liveness + document KYC.** Match a selfie to the ID document through a provider such as Smile ID or VerifyNow, on top of the ID-number check.
3. **Smarter dispatch.** Batch two orders from the same store, use a road-routing ETA (OSRM or Google), and add surge pay for riders in peak hours.
4. **Payments.** Instant EFT (Ozow or Capitec Pay), SnapScan or Zapper, cash-free only. Automated weekly store and rider payouts.
5. **Growth.** Referral credit, first-order promos, loyalty points, scheduled deliveries, reorder in one tap, and WhatsApp ordering and updates.
6. **Scale.** Postgres instead of SQLite and Redis pub/sub for the live bus, so more than one API instance can run. Add product images on S3/R2 and full-text search.
7. **Store growth tools.** Sales analytics, low-stock alerts, CSV/POS inventory sync and promotions.

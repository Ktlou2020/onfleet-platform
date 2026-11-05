# Verdant — on-demand delivery marketplace (working name)

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
| **Merchant tools** | Live order board with sound alerts, accept/decline/pack/ready flow, stock that is reserved on order and returned on cancel, open/close toggle, per-product "why isn't this live?" explanations. |
| **Rider app** | Online/offline toggle, GPS sharing, job board + auto-assignment, one-tap navigation, today's trips and earnings. |
| **Control room** | Today's GMV, fees, average order-to-door time, live orders, orders waiting for a rider, store approvals, licence verification, compliance switches, delivery hours. |

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
| Customer | `customer@verdant.africa` |
| Store (Rosebank Botanicals) | `merchant1@verdant.africa` … `merchant8@` |
| Rider (Jo'burg, CPT, DBN, PTA) | `rider1@verdant.africa` … `rider4@` |
| Admin | `admin@verdant.africa` |

To try the whole loop, use three browser windows: the customer orders, the store accepts and marks the order ready, and the rider goes online, collects and delivers. In dev the rider screen has a **Simulate move** button, so you can watch the rider pin move on the customer's map.

Tests: `cd marketplace/backend && npm test` (SA ID parsing, licence gating, delivery hours, the full order lifecycle, stock, permissions).

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `4100` | API port |
| `VERDANT_DB` | `backend/verdant.db` | SQLite file |
| `JWT_SECRET` | dev value | **Required** in production |
| `PAYMENT_PROVIDER` | `mock` | `paystack` for live payments |
| `PAYSTACK_SECRET_KEY` | | Paystack secret key |
| `PUBLIC_URL` | `http://localhost:5174` | Where Paystack sends customers back |
| `CORS_ORIGIN` | any | Comma-separated allowed origins |

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
  db.js          SQLite schema
frontend/src
  lib.jsx        API client, auth/cart/location state, live order hook
  pages/         Home, Store, Checkout, Orders/Track, Merchant, Rider, Admin, Auth
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

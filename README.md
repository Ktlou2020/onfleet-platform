# 🏍️ OnFleet Africa — Rent-to-Own Bike Platform

A complete, production-ready rent-to-own platform for delivery bikes. Built for the South African market with **Paystack** integration, **18-month (78-week)** rent-to-own agreements, GPS tracking, KYC, automated payment reminders, and a full admin console.

## 🚀 What's included

### Rider portal (`/dashboard`)
- 📝 **Sign up + 2-step onboarding** with personal & address details
- 🆔 **KYC document upload** (ID, Proof of Address, License, Bank Statement, Selfie)
- 📋 **Application form** with bike preference, income, delivery platforms
- 🎯 **Live progress bar** to ownership (% paid, weeks paid, R remaining)
- 💳 **Pay weekly via Paystack** (or pay multiple weeks / pay off entirely)
- 📅 **Full payment schedule** showing every week with status (paid / partial / overdue)
- 🛰️ **Live GPS map** of your bike with route history
- 🔧 **Service history** of your bike (free monthly services highlighted)
- 👤 **Profile & password management**

### Admin console (`/admin`)
- 📊 **Real-time dashboard** — revenue, riders, fleet, overdue, action queue
- 📈 **Weekly revenue chart** (last 90 days)
- 📋 **Application review** — approve & instantly allocate bike + auto-generate 78-week schedule, or reject with reason
- 📄 **Agreement management** — pause / resume / mark completed / mark defaulted
- 💰 **Manual payment recording** (EFT, cash, card)
- 🏍️ **Bike fleet CRUD** with filters by status (available, allocated, maintenance, sold, retired)
- 🛰️ **Per-bike GPS map**, odometer & insurance tracking
- 🔧 **Service log** with free-monthly tracking
- ✅ **KYC review queue** with approve / reject + reason
- 👥 **User management** with suspend / activate
- 📜 **Audit log** of every action in the system

### Backend features
- 🔐 **JWT auth** with role-based access (rider / admin / superadmin)
- 💳 **Paystack integration** — initialize, callback verify, webhook
- ⚡ **Auto payment allocation** — payments cascade to oldest unpaid week first
- 📅 **Automatic 78-week schedule generation** on agreement approval
- 🔔 **Cron jobs** — daily reminders for due / overdue payments + service alerts (WhatsApp / SMS / email pluggable)
- 📝 **Audit logging** of every state-changing action
- 🛰️ **GPS ping ingest endpoint** for hardware devices

## 🏗️ Tech stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + Vite + React Router 6 + Recharts + React-Leaflet + Lucide Icons + react-hot-toast |
| Backend | Node.js + Express + better-sqlite3 (SQLite — easily swap to PostgreSQL) |
| Auth | JWT + bcrypt |
| Payments | Paystack (cards, EFT, mobile money) |
| Notifications | Pluggable: SMTP (email), Twilio (SMS / WhatsApp) |
| Scheduling | node-cron |
| File uploads | multer (KYC docs, signatures) |

## 🏃 Run locally

```bash
# Backend
cd backend
cp .env.example .env       # then add your Paystack keys
npm install
npm run seed               # creates demo admin + 4 riders + 8 bikes + 2 active agreements
npm run dev                # http://localhost:4000

# Frontend (separate terminal)
cd frontend
cp .env.example .env       # optional: add GA4 Measurement ID and other Vite env vars
npm install
npm run dev                # http://localhost:5173
```

## 🔑 Demo accounts

| Role | Email | Password | What they have |
|------|-------|----------|----------------|
| Super Admin | `admin@onfleet.africa` | `admin123` | Full admin access |
| Rider | `thabo@example.com` | `rider123` | Active agreement, 12 weeks paid (15% complete) |
| Rider | `lerato@example.com` | `rider123` | Active agreement, 6 weeks paid |
| Rider | `sipho@example.com` | `rider123` | Pending application |
| Rider | `ayanda@example.com` | `rider123` | Brand new rider, no application yet |

## 💳 Paystack setup

1. Create a free account at [paystack.com](https://paystack.com)
2. Copy your **Test Secret Key** and **Public Key** from the Dashboard → Settings → API Keys
3. Paste them into `backend/.env`:
   ```
   PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxx
   PAYSTACK_PUBLIC_KEY=pk_test_xxxxxxxxxxxxx
   PAYSTACK_CALLBACK_URL=http://localhost:5173/payments/callback
   ```
4. (Optional) Add a webhook URL `https://your-domain.com/api/payments/paystack/webhook` in the Paystack dashboard for server-to-server reconciliation.

## 📊 GA4 analytics setup

To enable Google Analytics 4 page view tracking in the frontend, set this Vite environment variable in `frontend/.env`:

```
VITE_GA4_MEASUREMENT_ID=G-RZFE5KMNCD
```

If `VITE_GA4_MEASUREMENT_ID` is not set, GA4 tracking stays disabled.

## 🚀 Production deployment

### Option 1 — Single server (Docker recommended)
- Backend: Node 18+ on port 4000 behind nginx with SSL
- Frontend: build with `npm run build`, serve `dist/` from nginx
- Database: replace `better-sqlite3` with `pg` (PostgreSQL) — schema in `src/db.js` translates 1:1
- File storage: replace local `uploads/` with S3 / Cloudflare R2 (multer-s3)

### Option 2 — Managed
- Backend: Railway / Render / Fly.io
- Frontend: Vercel / Netlify / Cloudflare Pages
- DB: Neon / Supabase / RDS

### Notification providers
Edit `backend/src/services/notifier.js` to wire in:
- **WhatsApp / SMS** → Twilio (env vars already scaffolded)
- **Email** → SendGrid / Mailgun / SMTP

## 📁 Project layout

```
onfleet/
├── backend/
│   ├── src/
│   │   ├── server.js          # Express bootstrap
│   │   ├── db.js              # SQLite schema (10+ tables)
│   │   ├── seed.js            # Demo data
│   │   ├── middleware/auth.js # JWT + role guards
│   │   ├── routes/            # auth, kyc, bikes, applications, agreements, payments, admin, notifications
│   │   ├── services/
│   │   │   ├── notifier.js    # Pluggable email/SMS/WhatsApp
│   │   │   └── scheduler.js   # Daily cron jobs
│   │   └── utils/helpers.js   # Schedule builder, agreement no., audit
│   └── data/onfleet.db        # auto-created
└── frontend/
    └── src/
        ├── App.jsx            # Routes
        ├── auth.jsx           # Auth context
        ├── api.js             # axios instance
        ├── pages/
        │   ├── Landing.jsx
        │   ├── Login.jsx, Signup.jsx
        │   ├── rider/         # RiderShell + 7 pages
        │   └── admin/         # AdminShell + 9 pages
        └── components/ui.jsx  # Stat, Badge, Modal, Loading
```

## 🔮 Roadmap (next iterations)

- [ ] PDF agreement generation + e-signature on signup (PDFKit + signature_pad)
- [ ] In-app rider chat with admin (Socket.IO)
- [ ] Mobile app (React Native — same API)
- [ ] Insurance auto-renewal workflow
- [ ] Bike geofencing alerts (after-hours movement)
- [ ] Rider score / credit rating
- [ ] Multi-tenant (other African countries)

---

**Built with ❤️ for the African gig economy.**

# 🚀 Deploy OnFleet Africa

This repo includes ready-to-go configuration for **Railway**, **Render**, **Fly.io**, and **Docker** deployments. Pick your favourite and you'll have a permanent URL in under 15 minutes.

---

## ⭐ Option 1 — Railway (recommended, easiest)

1. Push this repo to GitHub (see `PUSH_TO_GITHUB.md`)
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick your fork
3. Railway auto-detects the `Dockerfile`. Set these environment variables:

   | Key | Value |
   |-----|-------|
   | `JWT_SECRET` | _click "Generate" — Railway makes a strong random one for you_ |
   | `PAYSTACK_SECRET_KEY` | `sk_test_0c7c99c5215402bbe9e30a69513c9d9c62fed0cc` |
   | `PAYSTACK_PUBLIC_KEY` | `pk_test_2aadcb48fc9f5df6b4041f1191a61e804cb9ac09` |
   | `PAYSTACK_CALLBACK_URL` | `https://YOUR-APP.up.railway.app/payments/callback` _(set after Railway gives you a URL)_ |
   | `NODE_ENV` | `production` |

4. Click **Deploy**. Railway gives you a public URL — paste it into `PAYSTACK_CALLBACK_URL` and redeploy.
5. To persist the SQLite database between deploys, attach a **Volume** mounted at `/app/backend/data` (Railway → Settings → Volumes → New Volume).

**Cost:** ~$5/month on Hobby plan, free trial credits to start.

---

## ⭐ Option 2 — Render (free tier available)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New** → **Blueprint** → connect your repo
3. Render reads `render.yaml` and creates the service automatically
4. After the service is created, go to **Environment** and set:
   - `PAYSTACK_SECRET_KEY` = `sk_test_0c7c99c5215402bbe9e30a69513c9d9c62fed0cc`
   - `PAYSTACK_PUBLIC_KEY` = `pk_test_2aadcb48fc9f5df6b4041f1191a61e804cb9ac09`
   - `PAYSTACK_CALLBACK_URL` = `https://YOUR-APP.onrender.com/payments/callback`
5. Click **Save and Deploy**. The persistent disk for SQLite is already configured in `render.yaml`.

**Cost:** Free tier supports the app (will sleep after 15 min idle). Starter plan is $7/month for always-on.

---

## ⭐ Option 3 — Fly.io (closest to South Africa — Johannesburg region!)

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Sign up / log in
flyctl auth signup   # or `flyctl auth login`

# From the project root:
flyctl launch --copy-config --no-deploy
flyctl volumes create onfleet_data --size 1 --region jnb

# Set secrets
flyctl secrets set \
  JWT_SECRET="$(openssl rand -hex 32)" \
  PAYSTACK_SECRET_KEY="sk_test_0c7c99c5215402bbe9e30a69513c9d9c62fed0cc" \
  PAYSTACK_PUBLIC_KEY="pk_test_2aadcb48fc9f5df6b4041f1191a61e804cb9ac09" \
  PAYSTACK_CALLBACK_URL="https://onfleet-platform.fly.dev/payments/callback"

# Deploy
flyctl deploy
```

The `fly.toml` is preconfigured for the **Johannesburg (jnb) region** — best latency for your South African riders.

**Cost:** Free tier supports it (3 small VMs free). Otherwise ~$2-3/month.

---

## ⭐ Option 4 — Self-hosted Docker (any VPS, ~$4/mo)

```bash
git clone https://github.com/YOUR-USERNAME/onfleet-platform.git
cd onfleet-platform

# Create .env file
cat > backend/.env << EOF
PORT=4000
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 32)
PAYSTACK_SECRET_KEY=sk_test_0c7c99c5215402bbe9e30a69513c9d9c62fed0cc
PAYSTACK_PUBLIC_KEY=pk_test_2aadcb48fc9f5df6b4041f1191a61e804cb9ac09
PAYSTACK_CALLBACK_URL=https://your-domain.com/payments/callback
DB_PATH=/app/backend/data/onfleet.db
EOF

# Build and run
docker build -t onfleet .
docker run -d --name onfleet \
  -p 4000:4000 \
  -v onfleet-data:/app/backend/data \
  -v onfleet-uploads:/app/backend/uploads \
  --env-file backend/.env \
  --restart unless-stopped \
  onfleet
```

Then put nginx + Let's Encrypt in front for SSL. Done.

---

## 🔐 Production checklist

Before going fully live with **real money**:

- [ ] Replace Paystack **test keys** with **live keys** from your dashboard
- [ ] Set `PAYSTACK_CALLBACK_URL` to your custom domain
- [ ] Add a Paystack **webhook URL** (`/api/payments/paystack/webhook`) in the Paystack dashboard for server-to-server reconciliation
- [ ] Wire up **Twilio WhatsApp + SMS** in `backend/src/services/notifier.js` (env vars are already scaffolded)
- [ ] Wire up **SMTP** for email reminders (e.g. SendGrid, Mailgun)
- [ ] Generate a strong `JWT_SECRET` — `openssl rand -hex 32`
- [ ] Move file uploads from local disk to **S3 / Cloudflare R2** (multer-s3) for horizontal scaling
- [ ] (Optional) Migrate from SQLite to **PostgreSQL** when you exceed ~10k agreements — schema in `backend/src/db.js` translates 1:1
- [ ] Change all default seed passwords (`admin123`, `rider123`)
- [ ] Set up automated DB backups (your hosting provider's snapshot feature)

---

## 🆘 Need help?

The full README has the local dev setup, demo accounts, and architecture overview. Open an issue on the repo if you get stuck.

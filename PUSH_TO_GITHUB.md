# 📤 Push this project to GitHub (5 minutes)

The project is ready to commit. Follow these steps to push it to GitHub so you can one-click deploy from Railway / Render / Fly.io.

## 1. Create a new GitHub repository

1. Go to [github.com/new](https://github.com/new)
2. Name it `onfleet-platform` (or anything you like)
3. **Leave it private** if you want to keep your business logic private
4. Do **NOT** initialise with a README, .gitignore, or license — we already have those
5. Click **Create repository**

## 2. Push the code from this project folder

Open your terminal in the project root and run:

```bash
# Initialise git (if not already done)
git init
git branch -M main

# Stage everything (the .gitignore excludes node_modules, .env, data/, etc.)
git add .
git commit -m "Initial commit — OnFleet Africa rent-to-own platform"

# Connect to your new GitHub repo (replace YOUR-USERNAME)
git remote add origin https://github.com/YOUR-USERNAME/onfleet-platform.git

# Push
git push -u origin main
```

## 3. One-click deploy

Once the code is on GitHub, you can deploy with one click:

### Railway
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)
- New Project → Deploy from GitHub → pick your repo → set env vars (see `DEPLOY.md`)

### Render
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)
- New → Blueprint → connect repo → set Paystack keys

### Fly.io
```bash
flyctl launch --copy-config
flyctl deploy
```

See `DEPLOY.md` for full instructions including environment variables and persistent storage setup.

## 4. Set the deploy badge in your README (optional)

Once deployed, you can add a "Live demo" badge to the top of your README:

```md
🌐 **Live:** https://onfleet-platform.up.railway.app
```

## ⚠️ Before pushing — sanity check

Make sure your `.env` file is **NOT** committed (it's already in `.gitignore`):

```bash
git status | grep -i env  # should show nothing
```

If it shows `.env` as tracked, run:
```bash
git rm --cached backend/.env
git commit -m "Remove .env from tracking"
```

The `.env.example` IS committed (and should be) — it's a template with no real secrets.

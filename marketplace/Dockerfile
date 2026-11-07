# ClickNPuff: one image runs the API and serves the built web app.
FROM node:20-bookworm-slim AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY --from=web /app/frontend/dist /app/frontend/dist
RUN mkdir -p /data
# The file keeps its original name so the existing database is found.
ENV CLICKNPUFF_DB=/data/cloud9.db
EXPOSE 4100
# Seeding is idempotent: it only adds demo data to an empty database.
CMD ["sh", "-c", "node src/seed.js && node src/server.js"]

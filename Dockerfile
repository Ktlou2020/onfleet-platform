# Multi-stage build for OnFleet Africa
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine AS backend
WORKDIR /app
# Install backend deps
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production
# Copy backend source
COPY backend/ ./backend/
# Copy frontend build
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
# Create data directory for SQLite
RUN mkdir -p /app/backend/data /app/backend/uploads
EXPOSE 4000
WORKDIR /app/backend
# Run seed once (idempotent — only seeds if DB is empty), then start
CMD ["sh", "-c", "node src/seed.js 2>/dev/null || true; node src/server.js"]

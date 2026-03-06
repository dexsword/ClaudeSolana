# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Build tools required for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Build tools needed to compile better-sqlite3 for this platform
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist/

# Persist trade database outside the container via volume mount
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/trades.db
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]

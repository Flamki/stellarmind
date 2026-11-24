# StellarMind Docker Image
# Multi-stage build for optimal image size

FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/
COPY public/ ./public/

FROM node:20-alpine AS runtime

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 stellarmind && \
    adduser -u 1001 -G stellarmind -s /bin/sh -D stellarmind

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
COPY package*.json ./
COPY .env.example ./

# Writable state for the non-root runtime user.
#
# /app belongs to root, so the stellarmind user cannot create the directory the
# run history lives in: the store's `mkdir -p` on the default
# /app/data/run-history.json fails with EACCES and the first run dies. Create
# the directories as root, hand them to the runtime user, and pin
# RUN_HISTORY_FILE at the path docker-compose mounts as a volume.
RUN mkdir -p /app/data /app/logs && \
    chown -R stellarmind:stellarmind /app/data /app/logs

ENV RUN_HISTORY_FILE=/app/data/run-history.json

# Expose port (configurable via PORT env var, defaults to 3001 per src/config.js)
EXPOSE 3001

# Health check using the implemented /healthz endpoint
# Uses ${PORT:-3001} to respect PORT env var overrides
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3001}/healthz || exit 1

USER stellarmind

CMD ["node", "src/server.js"]

# Generated for Stellar Wave bounty #28

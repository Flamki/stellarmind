# ---- Stage 1: Build ----
FROM node:20.19.0-alpine AS build

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY src/ ./src/
COPY public/ ./public/

# ---- Stage 2: Runtime ----
FROM node:20.19.0-alpine

RUN addgroup -g 1001 stellarmind && \
    adduser -u 1001 -G stellarmind -s /bin/sh -D stellarmind

WORKDIR /app

# Install Playwright system dependencies (for demo recording)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium --with-deps 2>/dev/null || true

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./

# Create data directory for run history
RUN mkdir -p /app/data && chown -R stellarmind:stellarmind /app

USER stellarmind

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/healthz || exit 1

CMD ["node", "src/server.js"]

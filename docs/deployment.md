# Deployment Guide

## Prerequisites

- Node.js 18, 20, or 22
- npm 9+
- A Stellar Testnet account (or Mainnet for production)
- x402 facilitator endpoint URL

## Local Deployment

### Standard Setup

```bash
git clone https://github.com/Flamki/stellarmind.git
cd stellarmind
nvm install && nvm use
npm ci
cp .env.example .env
npm run dev
```

The server starts on `http://localhost:3000` by default.

### Production Build

```bash
npm run build
NODE_ENV=production npm start
```

## Docker Deployment

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "server.js"]
```

Build and run:

```bash
docker build -t stellarmind .
docker run -p 3000:3000 \
  -e STELLAR_NETWORK=TESTNET \
  -e STELLAR_SECRET_KEY=your_key \
  -e X402_FACILITATOR_URL=https://facilitator.example.com \
  stellarmind
```

## Environment Configuration

### Required Variables

```bash
STELLAR_NETWORK=TESTNET
STELLAR_SECRET_KEY=S...
X402_FACILITATOR_URL=https://x402-facilitator.example.com
```

### Optional Variables

```bash
AGENT_REGISTRY_PATH=./custom-registry.json
MAX_BUDGET_PER_TASK=100
SSE_HEARTBEAT_INTERVAL=30000
LOG_LEVEL=info
PORT=3000
```

## Health Monitoring

### Health Check Endpoint

```
GET /health
Response: {"status":"ok","uptime":3600,"agents":5,"network":"TESTNET"}
```

### Metrics

The server exposes basic metrics:

- **Active agents**: Number of registered agents
- **Pending payments**: Transactions awaiting settlement
- **SSE connections**: Active event stream connections
- **Budget utilization**: Current spending vs global cap

## Scaling Considerations

### Horizontal Scaling

For multi-instance deployments:

1. Use a shared agent registry (Redis, database)
2. Distribute SSE connections via sticky sessions
3. Centralize budget tracking to prevent overspend
4. Use a message queue for cross-instance task distribution

### Rate Limiting

Configure per-agent rate limits:

```javascript
// In src/config.js
module.exports = {
  rateLimits: {
    maxCallsPerAgent: 60,
    maxConcurrentTasks: 10,
    globalBudgetCap: 1000,
  }
};
```

## Rollback Procedure

If a deployment causes issues:

```bash
git revert HEAD --no-edit
git push origin master

# If using Docker
docker stop stellarmind
docker run -d --name stellarmind \
  $(docker inspect stellarmind-prev --format='{{range .Config.Env}}{{println "-e" .}}{{end}}') \
  stellarmind:previous
```

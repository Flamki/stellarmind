# Docker Setup

StellarMind can be run locally using Docker and Docker Compose for a
reproducible, dependency-free setup.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24.0+
- [Docker Compose](https://docs.docker.com/compose/install/) 2.20+

## Quick Start

### 1) Clone and configure

```bash
git clone https://github.com/Flamki/stellarmind.git
cd stellarmind
cp .env.example .env
# Edit .env with your Stellar testnet keys and Anthropic API key
```

### 2) Start with Docker Compose

```bash
docker compose up -d
```

The server starts on `http://localhost:3001`.

### 3) Verify

```bash
curl http://localhost:3001/healthz
# → {"status":"ok","uptime":...}

curl http://localhost:3001/api/status
# → Full system status including x402 config and wallet info
```

### 4) Stop

```bash
docker compose down
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| `stellarmind` | 3001 | Production server (default) |
| `stellarmind-dev` | 3002 | Development with `--watch` (profile: `dev`) |

### Development mode

```bash
docker compose --profile dev up stellarmind-dev
```

Mounts `src/` and `public/` as volumes for live reload.

## Environment

All variables from `.env` are passed to the container. Key variables:

| Variable | Required | Default |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | — |
| `SERVER_STELLAR_ADDRESS` | For x402 | — |
| `SERVER_STELLAR_SECRET` | For x402 | — |
| `ORCHESTRATOR_STELLAR_ADDRESS` | For payments | — |
| `ORCHESTRATOR_STELLAR_SECRET` | For payments | — |
| `FACILITATOR_URL` | No | `https://www.x402.org/facilitator` |
| `NETWORK` | No | `stellar:testnet` |
| `PORT` | No | `3001` |

## Dockerfile

Multi-stage build:

1. **Build stage** — installs production dependencies with `npm ci --omit=dev`
2. **Runtime stage** — minimal Alpine image with Chromium (for Playwright demo recording)

Non-root user `stellarmind` (UID 1001) runs the process.

## Persistence

Run history is stored in `./data/` on the host (mounted as a volume).
To reset: `rm -rf data/ && docker compose restart`.

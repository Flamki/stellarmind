# StellarMind

[![License: MIT](https://img.shields.io/badge/license-MIT-0f172a.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-0f172a.svg)
![Stellar](https://img.shields.io/badge/network-Stellar%20Testnet-0f172a.svg)
![x402](https://img.shields.io/badge/payments-x402-0f172a.svg)

Multi-agent AI marketplace on Stellar Testnet with x402-protected premium endpoints, budget
guardrails, and on-chain payment verification.

## Why This Repo Exists

StellarMind demonstrates a production-style pattern for agent commerce:

- agents can call each other through paid APIs
- payment is enforced by protocol (`x402`), not trust alone
- spending is controlled with explicit budget policies
- every paid step can be verified on-chain

## Core Capabilities

- Orchestrator that decomposes tasks and routes work to specialized agents
- Premium agent endpoints protected by `@x402/express`
- Automatic payment handling via `@x402/fetch` and Stellar settlement
- Real-time event stream (SSE) in the web dashboard
- Demo automation pipeline for recording and narrated video export

## Architecture (High-Level)

```text
Client Task + Budget
        |
        v
Orchestrator (plan, select agents, enforce spend limits)
        |
        v
/api/premium/* endpoints (x402-protected)
        |
        v
402 challenge -> signed payment -> facilitator verification
        |
        v
Agent execution + streamed updates + tx proof links
```

For a deeper, standalone walkthrough — components plus the request, payment, and orchestration flows
— see [docs/architecture.md](docs/architecture.md).

## Quick Start

### 1) Clone and install

```bash
git clone https://github.com/Flamki/stellarmind.git
cd stellarmind
npm install
```

### 2) Configure environment

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Then either:

- run `npm run setup` to generate testnet wallets automatically, or
- manually fill wallet fields in `.env`

Security note:

- `npm run setup` masks wallet secrets in terminal output by default.
- Use `node src/setup-wallets.js --show-secrets` only when you explicitly need full secret printing.

Add your Anthropic key:

```env
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic API key for Claude agents |
| `ADMIN_TOKEN` | (optional) | Token required for runtime config changes (e.g. `POST /api/config/apikey`) |
| `SERVER_STELLAR_ADDRESS` | `G...` | Public Key of the server wallet (receives payments) |
```

Optional for deployments:

```env
# Defaults to http://localhost:3001 in local dev
INTERNAL_BASE_URL=http://server:3001
```

Structured logging mode:

```env
LOG_FORMAT=json
```

Run history persistence (for orchestration/payment audit):

```env
RUN_HISTORY_STORAGE=file
RUN_HISTORY_FILE=./data/run-history.json
RUN_HISTORY_MAX_RUNS=200
```

### 3) Prepare USDC trustlines

```bash
npm run setup:usdc
```

### 4) Start the app

```bash
npm run dev
```

Open `http://localhost:3001`.

> [!NOTE] **Mobile UI Limitations**: The dashboard is currently optimized for desktop viewports.
> Mobile responsiveness improvements are planned (see
> [#34](https://github.com/Flamki/stellarmind/issues/34)), but elements like the sidebar navigation
> are currently hidden on screens narrower than 768px. For the best experience, we recommend using a
> desktop browser with a viewport width of 1024px or wider during development and testing.

Because `INTERNAL_BASE_URL` defaults to `http://localhost:$PORT`, local demo setup stays one-command
simple: `npm run dev`.

## API Quick Reference (curl)

With the dev server running (`npm run dev`), copy-paste these local-first examples:

**System status**

```bash
curl -s http://localhost:3001/api/status
```

**Agent registry**

```bash
curl -s http://localhost:3001/api/agents
```

**Orchestrate a task**

```bash
curl -s -X POST http://localhost:3001/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"task":"Summarize why x402 on Stellar matters in one concise paragraph.","budget":0.15}'
```

Live agent calls require a configured `ANTHROPIC_API_KEY` and funded testnet wallets.

**Wallet balances**

```bash
curl -s http://localhost:3001/api/wallet/balances
```

## Deployment Notes

The orchestrator uses `INTERNAL_BASE_URL` for its paid internal calls to `/api/premium/*`.

- Local development: leave `INTERNAL_BASE_URL` unset and run `npm run dev`
- Single container / Docker Compose: set `INTERNAL_BASE_URL=http://<service-name>:3001`
- Remote or reverse-proxied deployment: set `INTERNAL_BASE_URL` to the server origin the
  orchestrator can actually reach, for example `https://stellarmind.example.com`

Examples:

```env
# Local
PORT=3001

# Docker Compose
PORT=3001
INTERNAL_BASE_URL=http://stellarmind:3001

# Remote deployment behind HTTPS
PORT=3001
INTERNAL_BASE_URL=https://stellarmind.example.com
```

## Operational Health Checks

StellarMind exposes lightweight endpoints for deployment tooling and load balancer probes:

- `GET /healthz`
  - returns `200` and `status: ok` when the process is alive
  - no external dependency checks are performed
- `GET /readyz`
  - returns `200` when the configured critical components are ready
  - returns `503` when required configuration is missing

Example `/readyz` response:

```json
{
  "status": "ready",
  "ready": true,
  "timestamp": "2026-05-28T12:00:00.000Z",
  "components": {
    "app": { "ready": true, "description": "Core HTTP server initialized" },
    "anthropic": {
      "configured": true,
      "ready": true,
      "description": "Anthropic API key is configured for Claude-powered agents"
    },
    "x402": { "enabled": true, "ready": true, "description": "x402 payment wallet is configured" }
  }
}
```

## Request Correlation and Logs

- Every API request is assigned a correlation ID (`x-correlation-id`).
- Incoming `x-correlation-id` / `x-request-id` headers are reused when provided.
- Response always includes `x-correlation-id`.
- Structured logs default to JSON (`LOG_FORMAT=json`) and include correlation data for request
  lifecycle, orchestrator flow, and payment events.

## Audit Run History

StellarMind persists orchestration and payment audit history.

- `GET /api/runs?limit=20`
  - returns recent runs across restarts when `RUN_HISTORY_STORAGE=file`
  - includes task, budget/spend summary, status, and tx proof linkage (`txHash`, `explorerUrl`)

Storage modes:

- `RUN_HISTORY_STORAGE=file` (default): durable JSON file
- `RUN_HISTORY_STORAGE=memory`: in-memory only (cleared on restart)

## Available Commands

| Command                   | Purpose                                                 |
| ------------------------- | ------------------------------------------------------- |
| `npm run dev`             | Start local server                                      |
| `npm run demo`            | Run end-to-end demo flow                                |
| `npm run preflight`       | Validate readiness (x402, wallets, model, payment path) |
| `npm run setup`           | Generate/fund Stellar testnet wallets                   |
| `npm run setup:usdc`      | Add USDC trustlines for settlement                      |
| `npm run lint`            | Run ESLint against the repository                       |
| `npm run lint:fix`        | Fix ESLint issues automatically                         |
| `npm run format`          | Format source and docs with Prettier                    |
| `npm run record:video`    | Capture website-only demo video                         |
| `npm run voiceover`       | Generate narration track                                |
| `npm run record:narrated` | Full narrated demo render pipeline                      |

## Demo Acceptance Checklist

- `npm run preflight` reaches ready state
- main run shows live orchestration events
- at least one transaction hash resolves in Stellar Expert
- low-budget run demonstrates step skipping
- final narrated video is exported and reviewed

## Security and Publishing Hygiene

Before pushing to GitHub:

1. Do not commit `.env` or wallet secrets.
2. Rotate any key that was ever exposed in terminal logs or screenshots.
3. Keep only `.env.example` in version control.
4. Review staged files with `git status` and `git diff --staged`.
5. Verify no private keys are present in docs, recordings, or commits.

This repo includes:

- strict secret-ignore defaults in `.gitignore`
- a GitHub Actions secret scan workflow (`.github/workflows/secret-scan.yml`)
- a dedicated security policy (`SECURITY.md`)

## Project Structure

```text
src/
  agents/
    orchestrator.js
    registry.js
    services.js
  stellar/
    wallet.js
  config.js
  server.js
  demo.js
  demo-preflight.js
  setup-wallets.js
  setup-usdc.js
  record-demo-video.js
  generate-demo-voiceover.js
  render-narrated-demo.js
public/
  index.html                    # Semantic HTML shell
  assets/
    css/
      variables.css            # Design tokens & reset
      sidebar.css              # Navigation UI
      layout.css               # Page structure & responsive
      components.css           # Reusable UI elements
      pages.css                # Page-specific styles
    js/
      navigation.js            # Page routing
      budget.js                # Budget slider
      agents.js                # Agent registry
      wallet.js                # Wallet data
      sse.js                   # Real-time events
      rendering.js             # Result display
      orchestration.js         # Task execution
      pages.js                 # Page loading
      init.js                  # App startup
```

### Frontend Architecture

The UI has been refactored from a monolithic 1,300-line HTML file into a modular structure:

- **HTML**: Semantic markup only (~150 lines)
- **CSS**: 5 organized modules (~1,060 lines) organized by concern
- **JavaScript**: 9 focused modules (~810 lines) organized by feature

See [FRONTEND_STRUCTURE.md](FRONTEND_STRUCTURE.md) for detailed documentation on:

- CSS organization and design tokens
- JavaScript module dependencies
- API integration points
- Responsive design approach
- Testing and maintenance guidelines

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

MIT. See [LICENSE](LICENSE).

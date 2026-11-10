# StellarMind Repository Map

A guided tour for new contributors. **Closes #48**

## Top-Level Layout

```text
stellarmind/
├── .github/            # CI workflows, issue templates
├── .husky/             # Git hooks (pre-commit checks)
├── docs/               # Project documentation
├── public/             # Static assets and entry HTML
│   ├── assets/         # CSS, JS, images
│   │   ├── css/        # Stylesheets
│   │   └── js/         # Client-side JavaScript
│   └── index.html      # Main entry point
├── src/                # Application source code
│   ├── agents/         # AI agent orchestration modules
│   ├── middleware/     # Express middleware (auth, validation)
│   ├── routes/         # REST API route handlers
│   ├── stellar/        # Stellar wallet integration
│   └── storage/        # Run history persistence
├── tests/              # Automated unit & integration test suites (node --test)
├── package.json        # Node.js dependencies and scripts
├── eslint.config.js    # ESLint configuration
├── CONTRIBUTING.md     # Contribution guidelines
├── SECURITY.md         # Security policy
└── README.md           # Project overview
```

## Core Source Code (`src/`)

| Directory/File             | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `src/agents/`              | Agent orchestration, registry, budgeting, settlement                    |
| `src/middleware/`          | Auth, error handling, rate limiting                                     |
| `src/routes/`              | REST API route modules (`premium-routes.js`, `orchestration-routes.js`) |
| `src/stellar/`             | Stellar wallet and blockchain integration                               |
| `src/storage/`             | Run history and persistence layer (`run-history.js`)                    |
| `src/app.js`               | Express app factory (`createApp`)                                       |
| `src/config.js`            | Application configuration and network profiles                          |
| `src/logger.js`            | Structured logging                                                      |
| `src/pricing.config.js`    | Centralized endpoint pricing (single source of truth)                   |
| `src/pricing.validator.js` | Startup validator matching pricing config against registry              |
| `src/requestValidation.js` | Query and body validation middleware                                    |
| `src/server.js`            | HTTP server entry point and x402 payment middleware wiring              |

### Key Directories

#### `src/agents/`

Each agent module handles a specific AI task. Agents communicate through the orchestrator. Key
files:

- `orchestrator.js` — Central coordination module that dispatches tasks
- `registry.js` — Agent definitions and metadata
- `services.js` — Service functions for each agent
- `budget.js` — Budget tracking and enforcement
- `amount.js` — Exact asset amount calculations (zero drift)

#### `src/routes/`

Express route handlers (`src/routes/premium-routes.js` and `src/routes/orchestration-routes.js`),
wired by `createApp()` in `src/app.js`.

#### `src/pricing.config.js` & `src/pricing.validator.js`

Centralized x402 route pricing configuration and startup validation ensuring every priced route
matches its agent definition in `src/agents/registry.js`.

#### `src/stellar/`

Stellar blockchain integration for wallet management and payment settlement.

## Frontend (`public/`)

| Directory/File       | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `public/assets/css/` | Stylesheets (layout, pages, sidebar, components)         |
| `public/assets/js/`  | Client-side scripts (SSE, wallet, agents, orchestration) |
| `public/index.html`  | Main entry point                                         |

## Documentation (`docs/`)

| File                           | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `docs/architecture.md`         | System architecture overview           |
| `docs/API_EXAMPLES.md`         | REST API usage examples                |
| `docs/ASSET_AMOUNTS.md`        | Asset amount precision and accounting  |
| `docs/DOCKER_DEPLOYMENT.md`    | Docker and container deployment guide  |
| `docs/repository-map.md`       | This file — repository structure guide |
| `docs/issue-task-checklist.md` | Checklist for implementing issues      |

## Configuration Files

| File               | Purpose                        |
| ------------------ | ------------------------------ |
| `.env.example`     | Environment variables template |
| `package.json`     | Dependencies and scripts       |
| `eslint.config.js` | Linting rules                  |

## Tests (`tests/`)

- `tests/*.test.js` — Unit and integration test suites executed via `npm test` or
  `node tests/<file>.test.js`. No external API keys or network access required.
- `tests/smoke.test.js` — Local HTTP smoke check (`npm run smoke`) against a running server.
- `src/demo-preflight.js` — Live Stellar network & wallet readiness check (`npm run preflight`).

## Quick Start (New Contributors)

1. **Read**: `CONTRIBUTING.md` and this repository map
2. **Setup**: `nvm use && npm install`
3. **Configure**: `cp .env.example .env` — configure environment
4. **Prepare**: `npm run setup` and `npm run setup:usdc` — generate wallets (optional for offline
   tests)
5. **Develop**: `npm run dev` — starts the development server at `http://localhost:3402`
6. **Test**: `npm test` — runs the full automated unit and integration test suite
7. **Lint**: `npm run lint` and `npm run lint:md` — checks code and markdown style
8. **Submit**: Open a PR following the PR template

## Common Workflows

| Task                      | Command                                                        |
| ------------------------- | -------------------------------------------------------------- |
| Start dev server          | `npm run dev`                                                  |
| Run all tests             | `npm test`                                                     |
| Run a targeted test suite | `npm run test:premium` (or `node --test tests/<file>.test.js`) |
| Run CLI demo              | `npm run demo`                                                 |
| Run local HTTP smoke test | `npm run smoke`                                                |
| Run Stellar preflight     | `npm run preflight`                                            |
| Lint code                 | `npm run lint`                                                 |
| Fix lint issues           | `npm run lint:fix`                                             |
| Lint Markdown docs        | `npm run lint:md`                                              |
| Format code               | `npm run format`                                               |

## Common Tasks

- **Adding a new agent**: Add pricing in `src/pricing.config.js`, add catalog metadata in
  `src/agents/registry.js`, implement the service in `src/agents/services.js`, add query validation
  in `src/requestValidation.js`, register the handler in `src/routes/premium-routes.js`, and wire
  dispatch in `src/agents/orchestrator.js` (see `CONTRIBUTING.md` for full walkthrough)
- **Adding a new API endpoint**: Register route handlers in `src/routes/premium-routes.js`,
  `src/routes/orchestration-routes.js`, or `src/app.js`
- **Modifying the UI**: See `public/assets/js/` and `public/assets/css/`
- **Testing**: `npm test`
- **Understanding payment flow**: See `CONTRIBUTING.md` and `docs/architecture.md`

## Architecture Overview

StellarMind uses an **orchestrator pattern** where a central coordination module dispatches tasks to
specialized AI agents. Agents are stateless; state is managed at the orchestrator level and
persisted via the API layer.

### Payment Flow

```text
User → Orchestrator (Claude plans tasks)
         ↓
    Orchestrator → GET /api/premium/{agent}
         ↓
    Server returns 402 Payment Required
         ↓
    wrapFetchWithPayment (from @x402/fetch) auto-signs Stellar USDC tx
         ↓
    Retries with X-PAYMENT header → Facilitator verifies → settles on-chain
         ↓
    Server returns 200 + Claude response
```

For detailed architecture, see `docs/architecture.md` and the inline documentation in
`src/agents/orchestrator.js`.

---

Last updated: 2026-10-16 — Generated for Stellar Wave bounty #48

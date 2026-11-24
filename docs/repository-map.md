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
├── tests/              # Test suites
│   └── load/           # Load test scenarios (k6, Artillery)
├── package.json        # Node.js dependencies and scripts
├── vercel.json         # Vercel deployment configuration
├── CONTRIBUTING.md     # Contribution guidelines
├── SECURITY.md         # Security policy
└── README.md           # Project overview
```

## Core Source Code (`src/`)

| Directory/File          | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `src/agents/`           | Agent orchestration, registry, budgeting, settlement |
| `src/middleware/`       | Auth, error handling, rate limiting                  |
| `src/routes/`           | REST API route handlers                              |
| `src/stellar/`          | Stellar wallet and blockchain integration            |
| `src/storage/`          | Run history and persistence layer                    |
| `src/config.js`         | Application configuration                            |
| `src/logger.js`         | Structured logging                                   |
| `src/pricing.config.js` | Pricing model configuration                          |
| `src/server.js`         | Express server entry point                           |

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

Express route handlers. New endpoints should be registered here and follow REST conventions. Each
route file exports a router.

#### `src/pricing/`

The pricing engine that calculates costs based on agent usage, token consumption, and plan tiers.
See `PRICING_INDEX.md` for business logic.

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
| `docs/repository-map.md`       | This file — repository structure guide |
| `docs/issue-task-checklist.md` | Checklist for implementing issues      |

## Configuration Files

| File               | Purpose                        |
| ------------------ | ------------------------------ |
| `.env.example`     | Environment variables template |
| `package.json`     | Dependencies and scripts       |
| `eslint.config.js` | Linting rules                  |
| `vercel.json`      | Deployment configuration       |

## Tests (`tests/`)

1. `cp .env.example .env` — configure environment
2. `npm install` — install dependencies
3. `npm run dev` — start development server
4. Visit `http://localhost:3001`

- `*.test.js` — Unit and integration tests (Jest)
- `load/` — Performance and load tests (k6, Artillery)

## Quick Start (New Contributors)

1. **Read**: `CONTRIBUTING.md` and this repository map
2. **Setup**: `nvm use && npm install`
3. **Configure**: `cp .env.example .env` — configure environment
4. **Prepare**: `npm run setup` and `npm run setup:usdc` — generate wallets
5. **Develop**: `npm run dev` — starts the development server at `http://localhost:3001`
6. **Test**: `npm test` — runs the full test suite
7. **Lint**: `npm run lint` — checks code style
8. **Submit**: Open a PR following the PR template

## Common Workflows

| Task                 | Command                 |
| -------------------- | ----------------------- |
| Start dev server     | `npm run dev`           |
| Run all tests        | `npm test`              |
| Run single test      | `npx jest path/to/test` |
| Lint code            | `npm run lint`          |
| Fix lint issues      | `npm run lint:fix`      |
| Format code          | `npm run format`        |
| Build for production | `npm run build`         |

## Common Tasks

- **Adding a new agent**: See `src/agents/registry.js`, then add service in `src/agents/services.js`
- **Adding a new API endpoint**: Create route handler in `src/routes/` or add to `src/server.js`
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

# Stellarmind Repository Map — Closes #48

A guided tour for new contributors.

## Top-Level Layout

```
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
│   ├── api/            # REST API route handlers
│   ├── middleware/      # Express middleware (auth, validation)
│   ├── pricing/        # Pricing engine and calculators
│   ├── orchestrator/   # Multi-agent coordination logic
│   └── utils/          # Shared utilities and helpers
├── tests/              # Test suites
│   └── load/           # Load test scenarios (k6, Artillery)
├── package.json        # Node.js dependencies and scripts
├── vercel.json         # Vercel deployment configuration
├── CONTRIBUTING.md     # Contribution guidelines
├── SECURITY.md         # Security policy
└── README.md           # Project overview
```

## Key Directories

### `src/agents/`
Each agent module handles a specific AI task. Agents communicate through the
orchestrator. See `src/orchestrator/` for the coordination layer.

### `src/api/`
Express route handlers. New endpoints should be registered here and follow
REST conventions. Each route file exports a router.

### `src/pricing/`
The pricing engine that calculates costs based on agent usage, token
consumption, and plan tiers. See `PRICING_INDEX.md` for business logic.

### `tests/`
- `*.test.js` — Unit and integration tests (Jest)
- `load/` — Performance and load tests (k6, Artillery)

## Quick Start (New Contributors)

1. **Read**: `CONTRIBUTING.md` and this repository map
2. **Setup**: `nvm use && npm install`
3. **Develop**: `npm run dev` starts the development server
4. **Test**: `npm test` runs the full test suite
5. **Lint**: `npm run lint` checks code style
6. **Submit**: Open a PR following the PR template

## Common Workflows

| Task | Command |
|------|---------|
| Start dev server | `npm run dev` |
| Run all tests | `npm test` |
| Run single test | `npx jest path/to/test` |
| Lint code | `npm run lint` |
| Build for production | `npm run build` |

## Architecture Overview

Stellarmind uses an **orchestrator pattern** where a central coordination
module dispatches tasks to specialized AI agents. Agents are stateless;
state is managed at the orchestrator level and persisted via the API layer.

For detailed architecture, see `FRONTEND_STRUCTURE.md` and the inline
documentation in `src/orchestrator/`.

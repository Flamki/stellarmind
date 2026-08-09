# StellarMind Repository Map

## For New Contributors

Welcome! Here's where to find everything:

### Core Source Code (`src/`)
| Directory/File | Purpose |
|---------------|---------|
| `src/agents/` | Agent orchestration, registry, budgeting, settlement |
| `src/middleware/` | Auth, error handling, rate limiting |
| `src/config.js` | Application configuration |
| `src/logger.js` | Structured logging |
| `src/pricing.config.js` | Pricing model configuration |

### Frontend (`public/`)
| Directory/File | Purpose |
|---------------|---------|
| `public/assets/css/` | Stylesheets (layout, pages, sidebar, components) |
| `public/assets/js/` | Client-side scripts (SSE, wallet, agents, orchestration) |
| `public/index.html` | Main entry point |

### Documentation (`docs/`)
| File | Purpose |
|------|---------|
| `docs/architecture.md` | System architecture overview |
| `docs/API_EXAMPLES.md` | REST API usage examples |

### Configuration
| File | Purpose |
|------|---------|
| `.env.example` | Environment variables template |
| `package.json` | Dependencies and scripts |
| `eslint.config.js` | Linting rules |

### Quick Start
1. `cp .env.example .env` — configure environment
2. `npm install` — install dependencies
3. `npm run dev` — start development server
4. Visit `http://localhost:3000`

## Common Tasks
- **Adding a new agent**: See `src/agents/registry.js`
- **Adding a new API endpoint**: See `src/agents/services.js`
- **Modifying the UI**: See `public/assets/js/` and `public/assets/css/`
- **Testing**: `npm test`

_Last updated: 2026-08-09 — Generated for Stellar Wave bounty #48_

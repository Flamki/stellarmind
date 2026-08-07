# Contributing to StellarMind

## Architecture Overview

StellarMind uses a layered architecture where AI agents operate as autonomous services that charge
for their work via the x402 payment protocol on Stellar.

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

### Key Design Decisions

1. **x402 over custom payments**: We use the official `@x402/express` middleware and `@x402/fetch`
   client rather than building custom payment verification. This ensures compatibility with the x402
   ecosystem.

2. **Budget enforcement in the orchestrator**: The orchestrator checks `totalSpent + cost > budget`
   before each agent call. If exceeded, the agent is skipped. This demonstrates programmable
   spending policies.

3. **Dual payment mode**: The system attempts x402 USDC payments first, then falls back to XLM
   direct transfers. Both produce real, verifiable on-chain transactions.

4. **SSE for real-time updates**: Server-Sent Events stream every orchestration event to the
   dashboard, giving users real-time visibility into agent activity and payments.

### Adding a New Agent

1. Add the agent definition in `src/agents/registry.js`
2. Add the service function in `src/agents/services.js`
3. Add the premium endpoint in `src/server.js` (both middleware config and route handler)
4. Map the agent ID to its endpoint in `src/agents/orchestrator.js`

### Running Tests

```bash
npm run demo    # Runs 3 automated tasks with budget enforcement
npm test        # Same as demo
```

### Security Hygiene

- Never commit `.env` or generated wallet secrets.
- Use placeholders only in `.env.example`.
- Before every push, run `git diff --staged` and verify no keys are present.
- If a secret is exposed, rotate it immediately.

### Formatting and linting

This project uses ESLint and Prettier to keep code and docs consistent. Before opening a PR, run:

```bash
npm run lint
npm run lint:fix
npm run format
```

### Environment Setup

```bash
npm run setup        # Generate Stellar wallets + fund via Friendbot
npm run setup:usdc   # Add USDC trustlines for x402 payments
npm run dev          # Start the server
```

---

## Contributor workflow

### Node version

Use the Node version pinned in `.nvmrc` before installing dependencies. This keeps local development
aligned with the runtime expectations of the Stellar SDK, ESLint, and CI.

macOS/Linux with `nvm`:

```bash
nvm install
nvm use
npm install
```

Windows alternatives:

```powershell
# nvm-windows
nvm install 20.19.0
nvm use 20.19.0
npm install

# Volta
volta install node@20.19.0
npm install
```

### 1. Claim an issue

Before writing any code, comment on the issue you want to work on:

> "I'd like to work on this — claiming it."

Wait for a maintainer to assign it to you. This prevents two people solving the same thing at once.

### 2. Fork and clone

Fork the repo on GitHub, then clone your fork locally:

```bash
git clone https://github.com/YOUR_USERNAME/stellarmind.git
cd stellarmind
```

Add the original repo as `upstream`:

```bash
git remote add upstream https://github.com/Flamki/stellarmind.git
```

### 3. Create a branch

Never work directly on `master`. Name your branch after your issue:

```text
docs/issue-44-contributor-workflow
fix/issue-12-short-description
feat/issue-27-short-description
```

```bash
git checkout -b feat/issue-27-short-description
```

### 4. Make your changes

Keep changes focused on the issue you claimed. Run locally to verify nothing breaks:

```bash
npm install
npm run lint
npm run format
npm run dev
```

### 5. Commit your work

Include `Closes #<number>` so GitHub auto-closes the issue on merge:

```bash
git commit -m "Your change description

Closes #44"
```

### 6. Push and open a PR

```bash
git push origin your-branch-name
```

Go to your fork on GitHub, click **"Compare & pull request"**, then fill in:

- **Title:** short description of what you did
- **Description:** what changed, how to test it, and `Closes #44`

## Pre-Commit Hooks

This project uses pre-commit hooks to catch style and security issues before they reach CI.

### What runs on commit

- **Lint & format** — runs the project's existing linter/formatter on staged files only
- **Secret scan** — blocks commits containing common credential patterns (API keys, private keys,
  tokens)

### Setup

After cloning, hooks are installed automatically via `npm install`.

### Bypassing hooks (emergency use only)

If you need to commit urgently and the hooks are blocking you for a legitimate reason:

```bash
git commit --no-verify -m "your message"
```

Use `--no-verify` sparingly. It disables **all** hooks. Document why you bypassed in the PR
description so reviewers are aware.

## Repository Map

Quick reference for new contributors — "where things live":

### Core Source (`src/`)

| Path | Purpose |
|------|---------|
| `src/server.js` | Express server, premium endpoints, SSE stream |
| `src/agents/orchestrator.js` | Claude-powered task planner and agent dispatcher |
| `src/agents/registry.js` | Agent definitions and metadata |
| `src/agents/services.js` | Agent service implementations |
| `src/x402/` | x402 payment protocol integration (middleware, client) |
| `src/stellar/` | Stellar SDK wrappers, key management, transaction helpers |
| `src/db/` | SQLite persistence layer for events and state |

### Frontend (`src/`)

| Path | Purpose |
|------|---------|
| `src/pages/` | Next.js page routes (dashboard, history) |
| `src/components/` | Reusable React components |
| `src/hooks/` | Custom React hooks (SSE subscription, wallet state) |
| `src/lib/` | Shared utilities, API client, types |

### Configuration & Tooling

| Path | Purpose |
|------|---------|
| `.env.example` | Required environment variables template |
| `.nvmrc` | Pinned Node.js version (20.19.0) |
| `vercel.json` | Vercel deployment configuration |
| `package.json` | Dependencies and scripts |
| `eslint.config.js` | Linting rules |

### Documentation & Process

| Path | Purpose |
|------|---------|
| `docs/architecture.md` | Deep architectural walkthrough |
| `docs/API_EXAMPLES.md` | Premium endpoint usage examples |
| `CONTRIBUTING.md` | This guide — how to contribute |
| `SECURITY.md` | Vulnerability reporting and security policy |
| `.github/pull_request_template.md` | PR description template |
| `tests/` | Test suite and demo automation |

### CI/CD (`.github/workflows/`)

| Path | Purpose |
|------|---------|
| `ci.yml` | Main CI pipeline (lint, test, build) |
| `vercel-deploy.yml` | Automated Vercel deployment on PR merge |

## Task Checklist Template

When opening a new issue or PR, copy the relevant checklist below to help reviewers
understand what's been done and what remains.

### Feature / Enhancement

```markdown
## Setup
- [ ] Local environment configured (`.env` based on `.env.example`)
- [ ] Dependencies installed (`npm install`)
- [ ] Related issues linked

## Implementation
- [ ] Core logic implemented
- [ ] Edge cases handled
- [ ] x402 payment flow verified (if applicable)
- [ ] SSE stream remains functional (if orchestrator changes)

## Tests
- [ ] `npm run demo` passes
- [ ] Manual test steps documented
- [ ] On-chain transactions verified on Stellar Testnet

## Documentation
- [ ] `README.md` updated if public API changed
- [ ] `docs/architecture.md` updated if flow changed
- [ ] PR description includes acceptance criteria evidence
```

### Bug Fix

```markdown
- [ ] Bug reproduced before fix
- [ ] Root cause identified
- [ ] Fix implemented with minimal scope
- [ ] Regression test added or manual test documented
- [ ] No new lint errors introduced
```

### Documentation

```markdown
- [ ] Content accurate for current codebase
- [ ] Links verified
- [ ] No secrets or private keys in examples
- [ ] Screenshots/logs sanitized
```

### Security

```markdown
- [ ] No `.env` or private keys committed
- [ ] No sensitive data in screenshots or logs
- [ ] Private keys/codes generated on Stellar Testnet only
- [ ] Vulnerability reported privately per `SECURITY.md`
```

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

2. **Budget enforcement with exact asset accounting**: The orchestrator checks
   `totalSpent + cost > budget` before each agent call using integer base units (`AssetAmount` in
   [`src/agents/amount.js`](src/agents/amount.js)), with strict precision admission and zero
   floating-point drift (see [`docs/ASSET_AMOUNTS.md`](docs/ASSET_AMOUNTS.md)). If exceeded, the
   agent is skipped. This demonstrates programmable spending policies with exact financial
   accounting.

3. **Dual payment mode**: The system attempts x402 USDC payments first, then falls back to XLM
   direct transfers. Both produce real, verifiable on-chain transactions.

4. **SSE for real-time updates**: Server-Sent Events stream every orchestration event to the
   dashboard, giving users real-time visibility into agent activity and payments.

### Adding a New Agent

To add a new specialist agent (for example, `translate-bot` at `/api/premium/translate`), update the
pricing, registry, service, validation, route, and orchestrator modules in lockstep:

1. **Add endpoint pricing in [`src/pricing.config.js`](src/pricing.config.js)**: Add the route entry
   (e.g., `'GET /api/premium/translate'`) in `pricingConfig.endpoints` with its `price` (such as
   `'$0.02'`), `agent` (`'translate-bot'`), `description`, and `emoji`. Startup validation in
   [`src/pricing.validator.js`](src/pricing.validator.js) enforces that every priced endpoint maps
   to a registered agent with a valid price.
2. **Add the catalog entry in [`src/agents/registry.js`](src/agents/registry.js)**: Add the agent
   object to `AGENTS` with matching `id`, `name`, `description`, `endpoint` (e.g.,
   `'/api/translate'`), numeric `price` (`'0.02'`), `currency` (`'USDC'`), `capability`, `model`,
   and `provider`.
3. **Add the service implementation in [`src/agents/services.js`](src/agents/services.js)**:
   Register the model identifier in `AGENT_MODELS` and `MODEL_LABELS`, add a deterministic offline
   fallback in `FALLBACKS`, and export the service function (e.g., `runTranslate(input, options)`)
   using `callClaude()`.
4. **Validate query input in [`src/requestValidation.js`](src/requestValidation.js)**: Add query
   parameter validation for the new `/api/premium/{agent}` path inside `validatePremiumQuery()`.
5. **Register the premium route in [`src/routes/premium-routes.js`](src/routes/premium-routes.js)**:
   `src/routes/premium-routes.js` is the sole owner of `/api/premium/*` handlers (wired once by
   `createApp()` in [`src/app.js`](src/app.js); never register duplicate handlers in
   [`src/server.js`](src/server.js)). Read the route price via
   `pricingConfig.getPrice('GET /api/premium/...')` so responses stay consistent with the catalog.
   If you also expose a free internal route (`/api/{agent}`), wire it in [`src/app.js`](src/app.js).
6. **Connect orchestrator dispatch in [`src/agents/orchestrator.js`](src/agents/orchestrator.js)**:
   Map the agent ID to its service function in `SERVICE_MAP` and to its URL builder in
   `PREMIUM_ENDPOINT_MAP`.

Verify that pricing, catalog metadata, and premium routes remain aligned:

```bash
node -e "
import('./src/pricing.config.js').then(async ({ pricingConfig }) => {
  const { validatePricingStartup } = await import('./src/pricing.validator.js');
  validatePricingStartup(pricingConfig);
});
"
npm run test:premium
```

### Running Tests and Verification Commands

All unit and integration test suites run offline with deterministic mocks/fallbacks and do **not**
require `ANTHROPIC_API_KEY`, funded Stellar keys, or external network access.

| Command                      | Purpose                                                                                                                                   | External Keys / Network Required?                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm test`                   | Run the full unit and integration test suite                                                                                              | **No** — runs completely offline                                               |
| `npm run test:validation`    | Run request validation unit tests (`tests/api.validation.test.js`)                                                                        | **No**                                                                         |
| `npm run test:parser`        | Run x402 settlement header parser unit tests (`src/agents/settlement-header.test.js`)                                                     | **No**                                                                         |
| `npm run test:budget`        | Run budget enforcement & exact asset math tests (`tests/orchestrator.budget.test.js`)                                                     | **No**                                                                         |
| `npm run test:usage`         | Run provider token usage accounting tests (`tests/usage-tracking.test.js`)                                                                | **No**                                                                         |
| `npm run test:premium`       | Run premium route & ownership integration tests (`tests/premium-endpoints.integration.test.js`, `tests/premium-routes-ownership.test.js`) | **No**                                                                         |
| `npm run test:normalization` | Run Claude content block normalization tests (`tests/response-normalization.test.js`)                                                     | **No**                                                                         |
| `npm run test:recovery`      | Run interrupted run history recovery tests (`tests/run-history-recovery.test.js`)                                                         | **No**                                                                         |
| `npm run test:queue`         | Run orchestration admission queue tests (`tests/admission-queue.test.js`, `tests/admission-queue.integration.test.js`)                    | **No**                                                                         |
| `npm run smoke`              | Run HTTP smoke checks against a running local server (`tests/smoke.test.js`)                                                              | Local server required (`http://localhost:3402`); no external API keys required |
| `npm run demo`               | Run 3 automated orchestration tasks in the CLI (`src/demo.js`, also aliased as `npm run test:demo`)                                       | Optional — uses fallback responses offline; uses Claude + Stellar when set     |
| `npm run preflight`          | Verify Stellar RPC/Horizon reachability, wallets, and USDC trustlines (`src/demo-preflight.js`)                                           | **Yes** — requires Stellar network access and configured wallet addresses      |

To run a single test file directly:

```bash
node tests/premium-endpoints.integration.test.js
```

### Security Hygiene

- Never commit `.env` or generated wallet secrets.
- Use placeholders only in `.env.example`.
- Before every push, run `git diff --staged` and verify no keys are present.
- If a secret is exposed, rotate it immediately.

See [SECURITY.md](SECURITY.md) for the full secret-handling policy and how to report a vulnerability
privately.

### Security checklist before push

Run these four commands before every `git push`. They take seconds and catch the mistakes that are
expensive to undo.

```bash
# 1. Confirm only the files you intend to ship are staged
git status

# 2. Read the staged content line by line — this is what actually leaves your machine
git diff --staged

# 3. Grep the staged diff for common credential shapes
git diff --staged | grep -nEi \
  'S[A-Z2-7]{55}|sk-ant-|AKIA[0-9A-Z]{16}|ghp_|xox[baprs]-|BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|secret|password|token)[[:space:]]*[:=]'

# 4. Confirm no env file slipped into the commit
git diff --staged --name-only | grep -E '^\.env' || echo 'OK: no .env files staged'
```

Step 3 prints nothing when the diff is clean. Any hit is a stop sign — unstage the file, remove the
value, and re-run.

Then confirm:

- [ ] Only intended files are staged (no `.env`, wallets, logs, recordings, or screenshots).
- [ ] Secrets are referenced via `process.env`, never as literals — `.env.example` holds
      placeholders only.
- [ ] Screenshots, demo videos, and pasted terminal output contain no private key material.
- [ ] Nothing was committed with `--no-verify`; if it was, say why in the PR description.

The pre-commit hook ([`.husky/check-secrets.sh`](.husky/check-secrets.sh)) and the gitleaks CI job
run the same class of checks, but they are a backstop — not a substitute for reading your own diff.

If a secret was already pushed, treat it as compromised: rotate it immediately, then follow
[SECURITY.md](SECURITY.md). Deleting the commit does not un-leak it.

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
npm test
npm run lint
npm run lint:md
npm run format:check
npm run dev
```

### 5. Commit your work

Include `Closes #<number>` so GitHub auto-closes the issue on merge:

```bash
git commit -m "Your change description

Closes #44"
```

### 6. Push and open a PR

Run the [security checklist before push](#security-checklist-before-push) first, then:

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

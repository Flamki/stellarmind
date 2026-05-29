# Contributing to StellarMind

## Architecture Overview

StellarMind uses a layered architecture where AI agents operate as autonomous services that charge for their work via the x402 payment protocol on Stellar.

### Payment Flow

```
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

1. **x402 over custom payments**: We use the official `@x402/express` middleware and `@x402/fetch` client rather than building custom payment verification. This ensures compatibility with the x402 ecosystem.

2. **Budget enforcement in the orchestrator**: The orchestrator checks `totalSpent + cost > budget` before each agent call. If exceeded, the agent is skipped. This demonstrates programmable spending policies.

3. **Dual payment mode**: The system attempts x402 USDC payments first, then falls back to XLM direct transfers. Both produce real, verifiable on-chain transactions.

4. **SSE for real-time updates**: Server-Sent Events stream every orchestration event to the dashboard, giving users real-time visibility into agent activity and payments.

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

### Environment Setup

```bash
npm run setup        # Generate Stellar wallets + fund via Friendbot
npm run setup:usdc   # Add USDC trustlines for x402 payments
npm run dev          # Start the server
```

---

## Contributor workflow

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

```
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

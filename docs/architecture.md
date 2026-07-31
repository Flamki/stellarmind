# StellarMind Architecture

This document gives a standalone, at-a-glance view of how StellarMind is put together: the runtime
components, and the three flows that matter most — **request**, **payment**, and **orchestration**.

It complements the high-level summary in the [README](../README.md) and the design rationale in
[CONTRIBUTING.md](../CONTRIBUTING.md), and reflects the current implementation under
[`src/`](../src).

## At a Glance

StellarMind is a single Express service that exposes a marketplace of Claude-powered AI agents.
Premium agent endpoints are protected by the [`x402`](https://www.x402.org) payment protocol, an
orchestrator decomposes tasks and hires agents under a spending budget, and every paid step settles
as a real, verifiable transaction on the Stellar testnet.

```text
                         ┌──────────────────────────────────────┐
                         │  Web Dashboard (public/index.html)     │
                         │  fetch() + EventSource (SSE)           │
                         └───────────────┬────────────────────────┘
                                         │ HTTP / SSE
                                         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Express server (src/server.js)                                             │
│  cors → json → static → requestId → routes → errorHandler                   │
│                                                                             │
│  health:    GET /healthz, GET /readyz                                       │
│  events:    GET /api/events                 (SSE broadcast hub)             │
│  paywall:   @x402/express  ── guards ──▶     GET /api/premium/*  (paid)      │
│  free:      GET /api/research|summarize|analyze|code   (internal/demo)      │
│  control:   POST /api/orchestrate   (rate-limited) ─▶ Orchestrator          │
│  meta:      GET /api/agents, /api/wallet/*, /api/status, /api/config/apikey  │
└───────┬───────────────────────────┬───────────────────────────┬────────────┘
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐        ┌─────────────────────┐        ┌──────────────────────┐
│ Agent registry│        │ Agent services       │        │ Orchestrator          │
│ registry.js   │        │ services.js          │        │ orchestrator.js       │
│ 4 priced bots │        │ Claude SDK + retries │        │ plan → budget → pay   │
└───────────────┘        │ + demo fallbacks     │        └──────────┬───────────┘
                         └─────────────────────┘                   │
        ┌───────────────────────────────────────────────┐         │
        │ Pricing config (single source of truth)         │         │
        │ pricing.config.js → validated at startup        │         │
        │ → drives x402 middleware + /api/status          │         │
        └───────────────────────────────────────────────┘         │
                                                                    ▼
                  ┌──────────────────────┐        ┌────────────────────────────┐
                  │ Stellar wallet        │        │ x402 client + facilitator   │
                  │ stellar/wallet.js     │◀──────▶│ @x402/fetch, @x402/stellar  │
                  │ Horizon testnet:      │        │ HTTPFacilitatorClient        │
                  │ balances, pay, txns   │        │ settlement-header.js parse  │
                  └──────────────────────┘        └────────────────────────────┘
                                  │                            │
                                  ▼                            ▼
                       Stellar Testnet (Horizon)      stellar.expert explorer links
```

### Components

| Component         | File                                                                    | Responsibility                                                   |
| ----------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| HTTP server       | [`src/server.js`](../src/server.js)                                     | Routes, SSE hub, health checks, mounts the x402 paywall          |
| Config            | [`src/config.js`](../src/config.js)                                     | Env-driven config (network, wallets, Anthropic, rate limits)     |
| Pricing config    | [`src/pricing.config.js`](../src/pricing.config.js)                     | Single source of truth for premium prices; generates x402 config |
| Pricing validator | [`src/pricing.validator.js`](../src/pricing.validator.js)               | Fails startup fast on invalid pricing                            |
| Agent registry    | [`src/agents/registry.js`](../src/agents/registry.js)                   | Catalog of the 4 priced agents + discovery helpers               |
| Agent services    | [`src/agents/services.js`](../src/agents/services.js)                   | Claude calls with timeout/retry, model fallback, demo fallbacks  |
| Orchestrator      | [`src/agents/orchestrator.js`](../src/agents/orchestrator.js)           | Task planning, budget enforcement, paid agent calls              |
| Settlement header | [`src/agents/settlement-header.js`](../src/agents/settlement-header.js) | Decodes the x402 settlement header → transaction hash            |
| Stellar wallet    | [`src/stellar/wallet.js`](../src/stellar/wallet.js)                     | Horizon testnet balances, payments, transaction history          |
| Middleware        | [`src/middleware/`](../src/middleware)                                  | `requestId`, centralized `errorHandler`, rate limiters           |
| Dashboard         | [`public/index.html`](../public/index.html)                             | Browser UI; calls the API and subscribes to the SSE stream       |

## Request Flow

The lifecycle of any HTTP request through the server. Every request gets a `requestId`, and all
errors are normalized by a single error handler into a `{ code, message, requestId }` envelope.

```text
Browser / Client                       Express app (src/server.js)
     │                                       │
     │  HTTP request                         ▼
     ├──────────────────────────▶  cors → express.json → express.static(public/)
     │                                       │
     │                                       ▼
     │                              requestId  (tag req with a UUID)
     │                                       │
     │                                       ▼
     │                         ┌─ matching route ───────────────────────────┐
     │                         │  /healthz, /readyz        liveness/readiness │
     │                         │  /api/events              open SSE stream    │
     │                         │  /api/premium/*           x402 paywall first │
     │                         │  /api/orchestrate         rate-limit → run   │
     │                         │  /api/agents|wallet|status meta/reads        │
     │                         └────────────────────┬───────────────────────┘
     │                                              │ ok            │ throws
     │                                              ▼               ▼
     │   200 JSON  ◀───────────────────────  res.json(...)    errorHandler
     │   error JSON ◀──────────────────────────────────────  { code, message, requestId }
```

Notes:

- The x402 paywall middleware only guards `/api/premium/*`; all other routes are free. If
  `SERVER_STELLAR_ADDRESS` is unset, the paywall is disabled and premium endpoints respond without
  payment (useful for local demos).
- `/api/orchestrate` and `/api/config/apikey` sit behind in-memory fixed-window rate limiters
  ([`rateLimiter.js`](../src/middleware/rateLimiter.js)).
- `GET /api/events` is the SSE hub: the orchestrator and premium routes `broadcast()` live events
  (`agent_call`, `agent_response`, `payment`, …) to every connected dashboard.

## Payment Flow

How a paid premium call is settled with x402. This is the `402 → sign → settle → 200` path; if x402
is unavailable, the orchestrator falls back to a direct XLM transfer that is still a real on-chain
transaction.

```text
Caller (orchestrator x402Fetch — @x402/fetch + ExactStellarScheme + Ed25519 signer)
   │
   │ 1. GET /api/premium/research?topic=...        (no payment yet)
   ▼
@x402/express paywall (pricing from pricing.config.js)
   │
   │ 2. 402 Payment Required  +  "accepts": { scheme: exact, price, payTo, network }
   ▼
@x402/fetch
   │ 3. signs the USDC "exact" payment, retries the request with an X-PAYMENT header
   ▼
@x402/express paywall
   │ 4. forwards X-PAYMENT to the facilitator (FACILITATOR_URL via HTTPFacilitatorClient)
   ▼
Facilitator
   │ 5. verifies + settles the USDC payment on Stellar testnet
   ▼
Premium route handler (src/server.js)
   │ 6. runs the Claude agent, returns 200 + PAYMENT-RESPONSE header (settlement / tx hash)
   ▼
settlement-header.js
   │ 7. parse PAYMENT-RESPONSE → extract tx hash → build stellar.expert explorer link
   ▼
Result: { result, paidVia: "x402", txHash, explorerUrl }

   ┌─ Fallback path (x402 not configured, 4xx/5xx, or settlement failure) ──────────┐
   │  orchestrator → stellar/wallet.js sendPayment()  (direct XLM, Horizon testnet) │
   │  → real on-chain tx → paidVia: "stellar-xlm-direct"                             │
   └─────────────────────────────────────────────────────────────────────────────┘
```

Notes:

- Prices live only in [`pricing.config.js`](../src/pricing.config.js). It is validated at startup
  and generates both the x402 middleware config and the `/api/status` output, so pricing never
  drifts between layers.
- The orchestrator's x402 client requires `ORCHESTRATOR_STELLAR_SECRET` plus a funded USDC
  trustline; readiness is checked at boot and surfaced via `x402WalletReady` / `x402WalletHint`.
- A 200 without a decodable settlement header is treated as an _unverified_ success (flagged via a
  `warning`), not a failure.

## Orchestration Flow

How `POST /api/orchestrate { task, budget }` turns one task into a budget-bounded, multi-agent
workflow. The default budget is `0.15` USDC.

```text
POST /api/orchestrate { task, budget }          (orchestrateLimiter → rate limit)
   │
   ▼
orchestrate(task, budget, broadcast)  — src/agents/orchestrator.js
   │
   │ 1. PLAN
   │      Claude Haiku decomposes the task into 2–3 subtasks
   │      → [{ agentId, input, cost }, ...]
   │      └─ on parse/API failure: deterministic, budget-aware fallback plan
   │
   │ 2. EXECUTE  (for each subtask, in order)
   │      ┌──────────────────────────────────────────────────────────────┐
   │      │ budget guard:  if totalSpent + cost > budget → skip            │
   │      │                (emit budget_limit; record skipped + reason)    │
   │      │ context relay: feed the previous agent's output as context     │
   │      │                into the next agent's input                     │
   │      │ pay + run:     callAgentViaX402(agent, input)                  │
   │      │                  ├─ x402 paid call  → /api/premium/* (Payment Flow) │
   │      │                  └─ fallback        → direct XLM payment       │
   │      │ broadcast:     agent_call → agent_response → payment (SSE)      │
   │      └──────────────────────────────────────────────────────────────┘
   │
   │ 3. SUMMARIZE
   │      totalSpent, agentsUsed / agentsSkipped, budgetExhausted,
   │      paymentProtocol (x402 | stellar-xlm | mixed | none), txCount,
   │      per-agent results with txHash + explorerUrl
   ▼
JSON response  +  orchestrator_complete (SSE)
```

### Agent Catalog

The orchestrator hires from a fixed catalog defined in [`registry.js`](../src/agents/registry.js);
prices are enforced by [`pricing.config.js`](../src/pricing.config.js).

| Agent       | ID             | Price (USDC) | Model                          |
| ----------- | -------------- | ------------ | ------------------------------ |
| 🔬 Research | `research-bot` | 0.01         | Claude Haiku                   |
| 📝 Summary  | `summary-bot`  | 0.01         | Claude Haiku                   |
| 📊 Analysis | `analyst-bot`  | 0.05         | Claude Sonnet (Haiku fallback) |
| 💻 Code     | `code-bot`     | 0.03         | Claude Haiku                   |

## Key Configuration

Driven by environment variables (see [`.env.example`](../.env.example) and
[`src/config.js`](../src/config.js)):

| Variable                                   | Purpose                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                        | Enables live Claude calls; without it, demo fallbacks are used |
| `SERVER_STELLAR_ADDRESS` / `_SECRET`       | Receives payments; presence enables the x402 paywall           |
| `ORCHESTRATOR_STELLAR_ADDRESS` / `_SECRET` | Pays for agent calls (x402 + XLM fallback)                     |
| `NETWORK`                                  | Stellar network (default `stellar:testnet`)                    |
| `FACILITATOR_URL`                          | x402 facilitator that verifies and settles payments            |
| `INTERNAL_BASE_URL`                        | Origin the orchestrator uses to reach `/api/premium/*`         |

## Related

- [README](../README.md) — overview, quick start, and operational health checks
- [CONTRIBUTING.md](../CONTRIBUTING.md) — design decisions and how to add a new agent

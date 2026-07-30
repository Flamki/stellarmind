# API Examples

Request and response samples for every StellarMind API endpoint. Use these as a reference when
testing, developing, or integrating with the marketplace.

> **Base URL:** `http://localhost:3001` (local dev) or your deployed origin.
>
> **Note:** Response snippets are trimmed and use placeholder values. Real responses will contain
> actual Stellar addresses, transaction hashes, and agent outputs.

---

## Table of Contents

- [Health & Readiness](#health--readiness)
  - [`GET /healthz`](#get-healthz)
  - [`GET /readyz`](#get-readyz)
- [System Status](#system-status)
  - [`GET /api/status`](#get-apistatus)
- [Event Stream](#event-stream)
  - [`GET /api/events` (SSE)](#get-apievents-sse)
- [Agent Registry](#agent-registry)
  - [`GET /api/agents`](#get-apiagents)
  - [`GET /api/agents/:id`](#get-apiagentsid)
  - [`GET /api/agents/discover/:capability`](#get-apiagentsdiscovercapability)
- [Free Agent Endpoints](#free-agent-endpoints)
  - [`GET /api/research`](#get-apiresearch)
  - [`GET /api/summarize`](#get-apisummarize)
  - [`GET /api/analyze`](#get-apianalyze)
  - [`GET /api/code`](#get-apicode)
- [Premium Agent Endpoints (x402-protected)](#premium-agent-endpoints-x402-protected)
  - [`GET /api/premium/research`](#get-apipremiumresearch)
  - [`GET /api/premium/summarize`](#get-apipremiumsummarize)
  - [`GET /api/premium/analyze`](#get-apipremiumanalyze)
  - [`GET /api/premium/code`](#get-apipremiumcode)
- [Orchestrator](#orchestrator)
  - [`POST /api/orchestrate`](#post-apiorchestrate)
  - [`GET /api/orchestrate`](#get-apiorchestrate)
- [Run History](#run-history)
  - [`GET /api/runs`](#get-apiruns)
- [Wallet](#wallet)
  - [`GET /api/wallet/balances`](#get-apiwalletbalances)
  - [`GET /api/wallet/transactions`](#get-apiwallettransactions)
- [API Key Configuration](#api-key-configuration)
  - [`GET /api/config/apikey`](#get-apiconfigapikey)
  - [`POST /api/config/apikey`](#post-apiconfigapikey)

---

## Health & Readiness

### `GET /healthz`

Lightweight liveness probe for load balancers and deployment tooling. No external dependency checks
are performed.

**Request:**

```bash
curl -s http://localhost:3001/healthz | jq
```

**Response `200 OK`:**

```json
{
  "status": "ok",
  "uptime": 842.31,
  "timestamp": "2026-07-30T12:00:00.000Z"
}
```

### `GET /readyz`

Readiness probe that checks whether configured critical components are operational. Returns `200`
when ready, `503` when dependencies are missing.

**Request:**

```bash
curl -s http://localhost:3001/readyz | jq
```

**Response `200 OK` (fully configured):**

```json
{
  "status": "ready",
  "ready": true,
  "timestamp": "2026-07-30T12:00:00.000Z",
  "components": {
    "app": {
      "ready": true,
      "description": "Core HTTP server initialized"
    },
    "anthropic": {
      "configured": true,
      "ready": true,
      "description": "Anthropic API key is configured for Claude-powered agents"
    },
    "x402": {
      "enabled": true,
      "ready": true,
      "description": "x402 payment middleware initialized"
    }
  }
}
```

**Response `503` (missing API key):**

```json
{
  "status": "not_ready",
  "ready": false,
  "timestamp": "2026-07-30T12:00:00.000Z",
  "components": {
    "app": {
      "ready": true,
      "description": "Core HTTP server initialized"
    },
    "anthropic": {
      "configured": false,
      "ready": false,
      "description": "Missing Anthropic API key; demo fallback responses are available"
    },
    "x402": {
      "enabled": true,
      "ready": false,
      "description": "x402 is enabled but middleware initialization failed"
    }
  }
}
```

---

## System Status

### `GET /api/status`

Full system overview including network, wallet state, agent count, pricing, and x402 configuration.

**Request:**

```bash
curl -s http://localhost:3001/api/status | jq
```

**Response `200 OK`:**

```json
{
  "name": "StellarMind",
  "version": "1.0.0",
  "description": "AI Agent Marketplace with x402 Micropayments on Stellar",
  "status": "online",
  "network": "stellar:testnet",
  "facilitator": "https://www.x402.org/facilitator",
  "agents": 4,
  "x402": {
    "enabled": true,
    "middleware": "@x402/express (paymentMiddlewareFromConfig)",
    "client": "@x402/fetch (wrapFetchWithPayment + ExactStellarScheme)",
    "premiumEndpoints": [
      "GET /api/premium/research ($0.01)",
      "GET /api/premium/summarize ($0.01)",
      "GET /api/premium/analyze ($0.05)",
      "GET /api/premium/code ($0.03)"
    ],
    "pricing": [
      {
        "endpoint": "GET /api/premium/research",
        "price": "$0.01",
        "agent": "research-bot",
        "description": "Research Agent - Web research and information gathering",
        "emoji": "🔬"
      },
      {
        "endpoint": "GET /api/premium/summarize",
        "price": "$0.01",
        "agent": "summary-bot",
        "description": "Summary Agent - Text summarization and condensing",
        "emoji": "📝"
      },
      {
        "endpoint": "GET /api/premium/analyze",
        "price": "$0.05",
        "agent": "analyst-bot",
        "description": "Analysis Agent - Deep analysis and insights",
        "emoji": "📊"
      },
      {
        "endpoint": "GET /api/premium/code",
        "price": "$0.03",
        "agent": "code-bot",
        "description": "Code Agent - Code generation and debugging",
        "emoji": "💻"
      }
    ],
    "flow": "402 → wrapFetchWithPayment signs USDC tx → retry with X-PAYMENT → facilitator settles on-chain → 200"
  },
  "wallets": {
    "server": "$SERVER_STELLAR_PUBLIC_KEY",
    "orchestrator": "$ORCHESTRATOR_STELLAR_PUBLIC_KEY",
    "buyer": "$BUYER_STELLAR_PUBLIC_KEY"
  },
  "claudeEnabled": true,
  "runHistory": {
    "storage": "file",
    "file": "./data/run-history.json",
    "maxRuns": 200
  }
}
```

---

## Event Stream

### `GET /api/events` (SSE)

Server-Sent Events stream that broadcasts real-time agent calls, responses, payments, and
orchestrator lifecycle events. Connect once and listen for continuous updates.

**Request:**

```bash
curl -N http://localhost:3001/api/events
```

**Stream output (each line is a separate event):**

```text
data: {"type":"connected","timestamp":"2026-07-30T12:00:00.000Z"}

data: {"type":"agent_call","agent":"🔬 Research Agent","agentId":"research-bot","input":"What is the future of AI payments?","cost":"0.01","timestamp":"2026-07-30T12:00:01.000Z"}

data: {"type":"agent_response","agent":"🔬 Research Agent","agentId":"research-bot","resultPreview":"The global AI-powered payments market is projected to exceed $40B by 2027...","cost":"0.01","timestamp":"2026-07-30T12:00:03.000Z"}
```

---

## Agent Registry

### `GET /api/agents`

List all registered agents with their capabilities, pricing, and status.

**Request:**

```bash
curl -s http://localhost:3001/api/agents | jq
```

**Response `200 OK`:**

```json
[
  {
    "id": "research-bot",
    "name": "🔬 Research Agent",
    "endpoint": "/api/research",
    "price": "0.01",
    "currency": "USDC",
    "model": "claude-haiku-4-5-20251001",
    "capability": "Deep web research and fact-finding on any topic",
    "description": "Uses Claude Haiku for fast, accurate research synthesis. Returns well-sourced analysis.",
    "status": "online"
  },
  {
    "id": "summary-bot",
    "name": "📝 Summary Agent",
    "endpoint": "/api/summarize",
    "price": "0.01",
    "currency": "USDC",
    "model": "claude-haiku-4-5-20251001",
    "capability": "Text summarization and key insight extraction",
    "description": "Condenses long texts into concise, actionable summaries powered by Claude Haiku.",
    "status": "online"
  },
  {
    "id": "analyst-bot",
    "name": "📊 Analysis Agent",
    "endpoint": "/api/analyze",
    "price": "0.05",
    "currency": "USDC",
    "model": "claude-sonnet-4-5-20250929 (fallback: claude-haiku-4-5-20251001)",
    "capability": "Deep strategic analysis with structured insights",
    "description": "Uses Claude Sonnet for premium-tier analysis with automatic Haiku fallback when needed.",
    "status": "online"
  },
  {
    "id": "code-bot",
    "name": "💻 Code Agent",
    "endpoint": "/api/code",
    "price": "0.03",
    "currency": "USDC",
    "model": "claude-haiku-4-5-20251001",
    "capability": "Code generation, review, and debugging",
    "description": "Generates, reviews, and debugs code across multiple languages.",
    "status": "online"
  }
]
```

### `GET /api/agents/:id`

Get a single agent by its ID.

**Request:**

```bash
curl -s http://localhost:3001/api/agents/analyst-bot | jq
```

**Response `200 OK`:**

```json
{
  "id": "analyst-bot",
  "name": "📊 Analysis Agent",
  "endpoint": "/api/analyze",
  "price": "0.05",
  "currency": "USDC",
  "model": "claude-sonnet-4-5-20250929 (fallback: claude-haiku-4-5-20251001)",
  "capability": "Deep strategic analysis with structured insights",
  "description": "Uses Claude Sonnet for premium-tier analysis with automatic Haiku fallback when needed.",
  "status": "online"
}
```

**Response `404 Not Found`:**

```json
{
  "error": {
    "status": 404,
    "code": "NOT_FOUND",
    "message": "Agent not found"
  }
}
```

### `GET /api/agents/discover/:capability`

Search for agents by a capability keyword. Matching is case-insensitive and checks agent name, id,
and capability description.

**Request:**

```bash
curl -s http://localhost:3001/api/agents/discover/code | jq
```

**Response `200 OK`:**

```json
[
  {
    "id": "code-bot",
    "name": "💻 Code Agent",
    "endpoint": "/api/code",
    "price": "0.03",
    "currency": "USDC",
    "model": "claude-haiku-4-5-20251001",
    "capability": "Code generation, review, and debugging",
    "description": "Generates, reviews, and debugs code across multiple languages.",
    "status": "online"
  }
]
```

---

## Free Agent Endpoints

Free endpoints run Claude agents on the server side and do not require x402 payment. They accept
input via query parameters.

### `GET /api/research`

Run a web research task.

**Request:**

```bash
curl -s "http://localhost:3001/api/research?topic=Stellar+blockchain+micropayments" | jq
```

**Response `200 OK`:**

```json
{
  "agent": "research-bot",
  "topic": "Stellar blockchain micropayments",
  "result": "[Research Agent — Powered by Claude Haiku]\n\nResearch findings on \"Stellar blockchain micropayments\":\n\n• Stellar's x402 protocol enables HTTP-native micropayments, allowing AI agents to autonomously pay for API services without human intervention — settlement occurs in ~5 seconds with fees under $0.001.\n• The global AI-powered payments market is projected to exceed $40B by 2027, driven by the convergence of machine learning and blockchain settlement layers.\n• Key players include Anthropic (Claude), OpenAI, and emerging agent frameworks like AutoGPT, which are exploring on-chain payment rails for agent-to-agent commerce.\n\nSources: Stellar Development Foundation, x402 Protocol Specification, Anthropic Research 2025.",
  "model": "claude-haiku-4-5-20251001",
  "cost": "0.01 USDC"
}
```

### `GET /api/summarize`

Summarize a block of text.

**Request:**

```bash
curl -s "http://localhost:3001/api/summarize?text=x402+enables+HTTP+402+%22Payment+Required%22+flows+where+agents+can+discover+service+pricing,+sign+transactions,+and+receive+responses+without+human+intervention" | jq
```

**Response `200 OK`:**

```json
{
  "agent": "summary-bot",
  "result": "[Summary Agent — Powered by Claude Haiku]\n\nKey Takeaway: x402 enables HTTP 402 \"Payment Required\" flows where agents can discover se...\n\nThe core insight is that autonomous AI agents require programmable payment infrastructure to operate at scale. Stellar's x402 protocol provides this by enabling HTTP 402 \"Payment Required\" flows where agents can discover service pricing, sign transactions, and receive responses — all without human intervention. This represents a fundamental shift from subscription-based API access to per-call micropayment models.",
  "model": "claude-haiku-4-5-20251001",
  "cost": "0.01 USDC"
}
```

### `GET /api/analyze`

Run a deep strategic analysis.

**Request:**

```bash
curl -s "http://localhost:3001/api/analyze?topic=AI+agent+economies" | jq
```

**Response `200 OK`:**

```json
{
  "agent": "analyst-bot",
  "topic": "AI agent economies",
  "result": "[Analysis Agent — Powered by Claude Sonnet]\n\nStrategic Analysis: \"AI agent economies\"\n\n**Key Findings:**\n• Agent-to-agent payment systems are an emerging category with significant first-mover advantage potential\n• The x402 protocol on Stellar provides sub-5-second settlement and near-zero fees, making per-call micropayments economically viable\n• Budget enforcement (spending policies) is a critical differentiator for enterprise adoption\n\n**Risks:**\n• Claude API latency (1-3s per call) may limit real-time agent workflows\n• Testnet-to-mainnet migration requires USDC liquidity and regulatory considerations\n\n**Opportunities:**\n• First-mover advantage in the AI agent marketplace vertical on Stellar\n• Soroban smart contracts could enable on-chain spending policies",
  "model": "claude-sonnet-4-5-20250929 (fallback: claude-haiku-4-5-20251001)",
  "cost": "0.05 USDC"
}
```

### `GET /api/code`

Generate or debug code.

**Request:**

```bash
curl -s "http://localhost:3001/api/code?prompt=Write+a+Stellar+payment+function+in+JavaScript" | jq
```

**Response `200 OK`:**

````json
{
  "agent": "code-bot",
  "result": "[Code Agent — Powered by Claude Haiku]\n\n```javascript\nimport { Keypair, Networks, TransactionBuilder, Operation, Asset } from '@stellar/stellar-sdk';\n\nasync function executeAgentPayment(senderSecret, recipientPublic, amount) {\n  const keypair = Keypair.fromSecret(senderSecret);\n  const server = new Horizon.Server('https://horizon-testnet.stellar.org');\n  const account = await server.loadAccount(keypair.publicKey());\n\n  const tx = new TransactionBuilder(account, {\n    fee: '100',\n    networkPassphrase: Networks.TESTNET,\n  })\n    .addOperation(Operation.payment({\n      destination: recipientPublic,\n      asset: Asset.native(),\n      amount: String(amount),\n    }))\n    .setTimeout(30)\n    .build();\n\n  tx.sign(keypair);\n  return await server.submitTransaction(tx);\n}\n```\n\nThis function handles a basic Stellar payment operation suitable for agent-to-agent micropayments.",
  "model": "claude-haiku-4-5-20251001",
  "cost": "0.03 USDC"
}
````

---

## Premium Agent Endpoints (x402-protected)

Premium endpoints are protected by the x402 payment middleware. Each endpoint requires a
two-step flow:
1. **Initial challenge probe** — A plain HTTP request returns `402 Payment Required` with a
   payment challenge in the response headers.
2. **Client-side retry** — The client signs the challenge and retries with the `X-PAYMENT`
   header. The server settles the payment via the facilitator and returns `200 OK`.

The examples below demonstrate both steps for each premium endpoint.

### `GET /api/premium/research`

Premium research with x402 payment enforcement. Cost: **$0.01 USDC**.

**Step 1 — Initial challenge probe (returns `402 Payment Required`):**

```bash
curl -s "http://localhost:3001/api/premium/research?topic=x402+protocol+scalability" | jq
```

This plain curl request hits the x402 middleware and returns a `402` status with a payment
challenge payload in the `X-Payment` response header.

**Step 2 — Client-side retry with `X-PAYMENT` (returns `200 OK`):**

Save the following as `premium-client.js` and run it with `node premium-client.js`:

```javascript
import { ExactStellarScheme, createEd25519Signer } from '@x402/stellar';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';

const STELLAR_SECRET_KEY = process.env.STELLAR_SECRET_KEY;
const NETWORK = 'stellar:testnet';
const URL = 'http://localhost:3001/api/premium/research?topic=x402+protocol+scalability';

const signer = createEd25519Signer(STELLAR_SECRET_KEY, NETWORK);
const scheme = new ExactStellarScheme(signer);
const client = new x402Client().register('stellar:*', scheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

const response = await paidFetch(URL);
const data = await response.json();
console.log(JSON.stringify(data, null, 2));
```

> **How it works:** The `wrapFetchWithPayment` wrapper detects the `402` response, extracts the
> payment challenge, signs a USDC transfer authorization with your secret key, attaches it as
> the `X-PAYMENT` header, and retries. On settlement, the server returns `200 OK`.

**Response `200 OK` (after successful x402 payment):**

```json
{
  "agent": "research-bot",
  "topic": "x402 protocol scalability",
  "result": "[Research Agent — Powered by Claude Haiku]\n\nResearch findings on \"x402 protocol scalability\":\n\n• The x402 protocol on Stellar Testnet achieves sub-5-second settlement times with near-zero fees, making it viable for high-frequency agent-to-agent micropayments.\n• Horizon-based transaction submission scales horizontally, and Soroban smart contracts add programmability for complex settlement logic.\n• Current throughput limits are bound by Stellar's network consensus (thousands of operations per second), which is sufficient for agent marketplace volumes.\n\nSources: Stellar Development Foundation, x402 Protocol Specification.",
  "model": "claude-haiku-4-5-20251001",
  "cost": "0.01 USDC",
  "paidVia": "x402"
}
```

### `GET /api/premium/summarize`

Premium summarization with x402 payment enforcement. Cost: **$0.01 USDC**.

**Step 1 — Initial challenge probe (returns `402 Payment Required`):**

```bash
curl -s "http://localhost:3001/api/premium/summarize?text=Autonomous+AI+agents+require+programmable+payment+infrastructure+to+operate+at+scale" | jq
```

**Step 2 — Client-side retry with `X-PAYMENT` (returns `200 OK`):**

Use the same `wrapFetchWithPayment` approach shown above, replacing the URL with the premium
summarize endpoint. See the [research example](#get-apipremiumresearch) for the full client code.

**Response `200 OK` (after successful x402 payment):**

```json
{
  "agent": "summary-bot",
  "result": "[Summary Agent — Powered by Claude Haiku]\n\nThe core insight is that autonomous AI agents require programmable payment infrastructure to operate at scale. Stellar's x402 protocol provides this by enabling per-call micropayment models without human intervention.",
  "model": "claude-haiku-4-5-20251001",
  "cost": "0.01 USDC",
  "paidVia": "x402"
}
```

### `GET /api/premium/analyze`

Premium strategic analysis. Cost: **$0.05 USDC**.

**Step 1 — Initial challenge probe (returns `402 Payment Required`):**

```bash
curl -s "http://localhost:3001/api/premium/analyze?topic=Tokenized+agent+marketplaces" | jq
```

**Step 2 — Client-side retry with `X-PAYMENT` (returns `200 OK`):**

Use the same `wrapFetchWithPayment` approach shown above, replacing the URL with the premium
analyze endpoint. See the [research example](#get-apipremiumresearch) for the full client code.

**Response `200 OK` (after successful x402 payment):**

```json
{
  "agent": "analyst-bot",
  "topic": "Tokenized agent marketplaces",
  "result": "[Analysis Agent — Powered by Claude Sonnet]\n\nStrategic Analysis: \"Tokenized agent marketplaces\"\n\n**Key Findings:**\n• Tokenized marketplaces for AI agents represent a greenfield opportunity at the intersection of crypto and AI\n• x402 on Stellar provides the payment rail, while Soroban contracts could enable on-chain reputation and dispute resolution\n\n**Risks:**\n• Regulatory uncertainty around tokenized AI services\n• Dependence on centralized AI model providers creates potential single points of failure\n\n**Opportunities:**\n• First-mover advantage in a rapidly growing niche\n• Multi-model support would widen marketplace appeal beyond Claude",
  "model": "claude-sonnet-4-5-20250929 (fallback: claude-haiku-4-5-20251001)",
  "cost": "0.05 USDC",
  "paidVia": "x402"
}
```

### `GET /api/premium/code`

Premium code generation with x402 payment enforcement. Cost: **$0.03 USDC**.

**Step 1 — Initial challenge probe (returns `402 Payment Required`):**

```bash
curl -s "http://localhost:3001/api/premium/code?prompt=Create+an+x402+payment+wrapper+for+fetch" | jq
```

**Step 2 — Client-side retry with `X-PAYMENT` (returns `200 OK`):**

Use the same `wrapFetchWithPayment` approach shown above, replacing the URL with the premium
code endpoint. See the [research example](#get-apipremiumresearch) for the full client code.

**Response `200 OK` (after successful x402 payment):**

````json
{
  "agent": "code-bot",
  "prompt": "Create an x402 payment wrapper for fetch",
  "result": "[Code Agent — Powered by Claude Haiku]\n\n```javascript\nimport { ExactStellarScheme, createEd25519Signer } from '@x402/stellar';\nimport { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';\n\nexport function createPaidFetch(secretKey, network) {\n  const signer = createEd25519Signer(secretKey, network);\n  const scheme = new ExactStellarScheme(signer);\n  const client = x402Client.fromConfig({\n    schemes: [{ network, client: scheme }],\n  });\n  const httpClient = new x402HTTPClient(client);\n  return wrapFetchWithPayment(fetch, httpClient);\n}\n```",
  "model": "claude-haiku-4-5-20251001",
  "cost": "0.03 USDC",
  "paidVia": "x402"
}
````

---

## Orchestrator

The orchestrator decomposes a task into subtasks, assigns them to specialized agents, and enforces
spending limits. Supports both `POST` (JSON body) and `GET` (query parameters).

### `POST /api/orchestrate`

**Request:**

```bash
curl -s -X POST http://localhost:3001/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"task":"Explain why x402 on Stellar matters for AI agents.","budget":0.15}' | jq
```

**Response `200 OK`:**

````json
{
  "task": "Explain why x402 on Stellar matters for AI agents.",
  "plan": "Multi-agent workflow: research-bot → summary-bot → analyst-bot → code-bot (4 agents, 0.15 USDC budget)",
  "budget": 0.15,
  "totalSpent": "0.1000",
  "budgetExhausted": false,
  "agentsUsed": 4,
  "agentsSkipped": 0,
  "paymentProtocol": "x402",
  "x402PaymentCount": 2,
  "xlmFallbackCount": 2,
  "unpaidCount": 0,
  "x402Configured": true,
  "x402WalletReady": true,
  "x402WalletHint": null,
  "results": [
    {
      "agentId": "research-bot",
      "agentName": "🔬 Research Agent",
      "model": "claude-haiku-4-5-20251001",
      "input": "Explain why x402 on Stellar matters for AI agents.",
      "output": "[Research Agent — Powered by Claude Haiku]\n\nResearch findings on \"x402 on Stellar for AI agents\":\n\n• x402 provides HTTP-native micropayments that allow AI agents to autonomously pay for services without human intervention...",
      "cost": "0.01",
      "currency": "USDC",
      "paidVia": "x402",
      "paymentSuccess": true,
      "txHash": "abc123def456...",
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123def456..."
    },
    {
      "agentId": "summary-bot",
      "agentName": "📝 Summary Agent",
      "model": "claude-haiku-4-5-20251001",
      "input": "Summarize findings about: Explain why x402 on Stellar matters for AI agents.",
      "output": "[Summary Agent — Powered by Claude Haiku]\n\nThe core insight is that autonomous AI agents require programmable payment infrastructure...",
      "cost": "0.01",
      "currency": "USDC",
      "paidVia": "x402",
      "paymentSuccess": true,
      "txHash": "ghi789jkl012...",
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/ghi789jkl012..."
    },
    {
      "agentId": "analyst-bot",
      "agentName": "📊 Analysis Agent",
      "model": "claude-sonnet-4-5-20250929 (fallback: claude-haiku-4-5-20251001)",
      "input": "Explain why x402 on Stellar matters for AI agents.",
      "output": "[Analysis Agent — Powered by Claude Sonnet]\n\nStrategic Analysis: \"Explain why x402 on Stellar matters for AI agents.\"\n\n**Key Findings:**\n• Agent-to-agent payment systems are an emerging category with significant first-mover advantage potential...",
      "cost": "0.05",
      "currency": "USDC",
      "paidVia": "stellar-xlm-direct",
      "paymentSuccess": true,
      "txHash": "mno345pqr678...",
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/mno345pqr678..."
    },
    {
      "agentId": "code-bot",
      "agentName": "💻 Code Agent",
      "model": "claude-haiku-4-5-20251001",
      "input": "Write an implementation related to: Explain why x402 on Stellar matters for AI agents.",
      "output": "[Code Agent — Powered by Claude Haiku]\n\n```javascript\n// Stellar x402 payment wrapper...\n```",
      "cost": "0.03",
      "currency": "USDC",
      "paidVia": "stellar-xlm-direct",
      "paymentSuccess": true,
      "txHash": "stu901vwx234...",
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/stu901vwx234..."
    }
  ],
  "payments": [
    {
      "result": "...",
      "paymentMethod": "x402",
      "paymentSuccess": true,
      "paidVia": "x402",
      "txHash": "abc123def456...",
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123def456..."
    }
  ],
  "txCount": 4,
  "runId": "run_1722345600000_abc123",
  "elapsed": "12453ms"
}
````

### `GET /api/orchestrate`

Same as `POST`, but parameters are passed as query strings. Useful for quick testing.

**Request:**

```bash
curl -s "http://localhost:3001/api/orchestrate?task=Summarize+the+benefits+of+x402&budget=0.10" | jq
```

**Response `200 OK`:**

Same shape as the `POST /api/orchestrate` response above.

> **Note:** The `runId` in the response comes from the run history store and is unique per
> invocation.

---

## Run History

### `GET /api/runs`

List recent orchestration runs with their task, budget, spend, and audit trail.

**Request:**

```bash
curl -s "http://localhost:3001/api/runs?limit=5" | jq
```

**Response `200 OK`:**

```json
{
  "storage": "file",
  "file": "./data/run-history.json",
  "count": 2,
  "runs": [
    {
      "id": "run_1722345600000_abc123",
      "task": "Explain why x402 on Stellar matters for AI agents.",
      "budget": 0.15,
      "totalSpent": "0.1000",
      "status": "completed",
      "agentCount": 4,
      "source": "POST /api/orchestrate",
      "createdAt": "2026-07-30T12:00:00.000Z",
      "completedAt": "2026-07-30T12:00:12.453Z",
      "plan": "Multi-agent workflow: research-bot → summary-bot → analyst-bot → code-bot",
      "events": []
    },
    {
      "id": "run_1722345600000_def456",
      "task": "Summarize the benefits of x402",
      "budget": 0.1,
      "totalSpent": "0.0200",
      "status": "completed",
      "agentCount": 2,
      "source": "GET /api/orchestrate",
      "createdAt": "2026-07-30T11:55:00.000Z",
      "completedAt": "2026-07-30T11:55:08.210Z",
      "plan": "Multi-agent workflow: research-bot → summary-bot",
      "events": []
    }
  ]
}
```

---

## Wallet

### `GET /api/wallet/balances`

Retrieve USDC and XLM balances for configured wallets.

**Request:**

```bash
curl -s http://localhost:3001/api/wallet/balances | jq
```

> **Note:** The addresses below are placeholders. Replace each `$WALLET_PUBLIC_KEY` with a real
> Stellar testnet address funded via [Stellar Lab's Friendbot](https://lab.stellar.org/account/fund).
> The USDC issuer for Stellar testnet is
> `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (per the [x402 Quickstart Guide](https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide)).

**Response `200 OK`:**

```json
{
  "server": {
    "address": "$SERVER_STELLAR_PUBLIC_KEY",
    "balances": [
      {
        "asset": "XLM",
        "balance": "9999.9999900",
        "issuer": null
      },
      {
        "asset": "USDC",
        "balance": "100.0000000",
        "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
      }
    ]
  },
  "orchestrator": {
    "address": "$ORCHESTRATOR_STELLAR_PUBLIC_KEY",
    "balances": [
      {
        "asset": "XLM",
        "balance": "5000.0000000",
        "issuer": null
      },
      {
        "asset": "USDC",
        "balance": "50.0000000",
        "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
      }
    ]
  },
  "buyer": {
    "address": "$BUYER_STELLAR_PUBLIC_KEY",
    "balances": [
      {
        "asset": "XLM",
        "balance": "10000.0000000",
        "issuer": null
      },
      {
        "asset": "USDC",
        "balance": "200.0000000",
        "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
      }
    ]
  }
}
```

When wallets are not configured, missing entries are omitted.

### `GET /api/wallet/transactions`

Fetch recent transactions for a wallet address with pagination support.

**Query Parameters:**

| Parameter | Type   | Default | Description                                                    |
| --------- | ------ | ------- | -------------------------------------------------------------- |
| `address` | string | (auto)  | Stellar public key. Defaults to orchestrator or server address |
| `limit`   | int    | 20      | Number of transactions (max 200)                               |
| `order`   | string | `desc`  | Sort order: `asc` or `desc`                                    |
| `cursor`  | string | —       | Paging token for cursor-based pagination                       |

**Request:**

```bash
curl -s "http://localhost:3001/api/wallet/transactions?address=\$STELLAR_PUBLIC_KEY&limit=2&order=desc" | jq
```

**Response `200 OK`:**

```json
[
  {
    "hash": "abc123def4567890abc123def4567890abc123def4567890abc123def4567890",
    "paging_token": "1234567890123456789-0",
    "ledger": 1234567,
    "createdAt": "2026-07-30T11:59:59Z",
    "created_at": "2026-07-30T11:59:59Z",
    "memo": "pay:research-bot",
    "memo_type": "text",
    "feeCharged": "100",
    "operationCount": 1,
    "operation_count": 1,
    "successful": true,
    "operations": [
      {
        "id": "1234567890123456789",
        "type": "payment",
        "amount": "0.0100000",
        "asset_code": "XLM",
        "from": "$SENDER_STELLAR_PUBLIC_KEY",
        "to": "$RECIPIENT_STELLAR_PUBLIC_KEY"
      }
    ],
    "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123def4567890abc123def4567890abc123def4567890abc123def4567890"
  }
]
```

---

## API Key Configuration

### `GET /api/config/apikey`

Check whether an Anthropic API key is currently configured.

**Request:**

```bash
curl -s http://localhost:3001/api/config/apikey | jq
```

**Response `200 OK` (configured):**

```json
{
  "configured": true,
  "masked": "sk-ant-...abcdef"
}
```

**Response `200 OK` (not configured):**

```json
{
  "configured": false,
  "masked": null
}
```

### `POST /api/config/apikey`

Update the Anthropic API key at runtime (ephemeral — key is stored in memory only and lost on
restart). Requires an `ADMIN_TOKEN` environment variable for authorization.

**Request:**

```bash
curl -s -X POST http://localhost:3001/api/config/apikey \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-admin-token" \
  -d '{"apiKey":"sk-ant-your-api-key-here"}' | jq
```

**Response `200 OK`:**

```json
{
  "success": true,
  "masked": "sk-ant-...yhere"
}
```

**Response `400 Bad Request` (invalid key):**

```json
{
  "error": {
    "status": 400,
    "code": "INVALID_API_KEY",
    "message": "Invalid API key. Must start with sk-ant-"
  }
}
```

---

## Error Format

All errors follow a consistent structure:

```json
{
  "error": {
    "status": 400,
    "code": "INVALID_INPUT",
    "message": "Invalid request query parameters",
    "details": [
      {
        "field": "topic",
        "reason": "Must be no more than 500 characters",
        "received": "..."
      }
    ]
  }
}
```

Common error codes:

| HTTP Status | Code                | Description                      |
| ----------- | ------------------- | -------------------------------- |
| `400`       | `INVALID_INPUT`     | Invalid query parameters or body |
| `400`       | `INVALID_API_KEY`   | Malformed Anthropic API key      |
| `400`       | `INVALID_LIMIT`     | Invalid `limit` parameter        |
| `400`       | `INVALID_DIRECTION` | Invalid `order`/`direction`      |
| `400`       | `INVALID_CURSOR`    | Invalid cursor/page token        |
| `404`       | `NOT_FOUND`         | Resource not found (agent, etc.) |
| `408`       | `ANTHROPIC_TIMEOUT` | Claude API request timed out     |
| `429`       | `RATE_LIMITED`      | Too many requests                |
| `500`       | `INTERNAL_ERROR`    | Unexpected server error          |

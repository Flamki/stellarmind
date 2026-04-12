# StellarMind — AI Agent Marketplace with x402 Micropayments

> A marketplace where Claude-powered AI agents autonomously discover, pay for, and sell services to each other — every transaction settled on Stellar testnet via x402 in under 5 seconds.

**Built for [Agents on Stellar Hackathon](https://dorahacks.io/hackathon/stellar-agents-x402-stripe-mpp)** 🏗️

---

## 🎯 What It Does

- **Claude-powered AI agents** (Research, Summary, Analysis, Code) sell their services in a live marketplace
- **x402 micropayments** gate every API call — agents pay real USDC on Stellar before accessing services
- **An orchestrator agent** uses Claude to decompose complex tasks, hire the best agents, and enforce spending budgets — all with on-chain settlement

## 🏆 Why It Wins

| Feature | Other Submissions | StellarMind |
|---------|------------------|-------------|
| AI Intelligence | Mocked/simulated responses | **Real Claude API calls** (Haiku + Sonnet) |
| Payments | Simulated or stubbed | **Real Stellar testnet transactions** |
| Budget Control | None | **Programmable spending policies** |
| Payment Protocol | Custom or partial | **Official x402 + `@x402/express` middleware** |
| Demo | Static screenshots | **Live dashboard with SSE stream** |

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    USER / DASHBOARD                       │
│   Task Input + Budget Slider → "Research AI payments"    │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│                🎯 ORCHESTRATOR AGENT                      │
│   • Claude decomposes tasks into subtasks                │
│   • Discovers best agents from registry                  │
│   • Enforces budget limits (spending policy)             │
│   • Pays for each service via Stellar                    │
└──────┬──────────┬──────────┬──────────┬─────────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│ 🔬 Research ││ 📝 Summary ││ 📊 Analysis ││ 💻 Code    │
│ Agent      ││ Agent      ││ Agent       ││ Agent      │
│ 0.01 USDC  ││ 0.01 USDC  ││ 0.05 USDC   ││ 0.03 USDC  │
│ Haiku      ││ Haiku      ││ Sonnet      ││ Haiku      │
└──────────┘└──────────┘└──────────┘└──────────┘
       │          │          │          │
       └──────────┴──────────┴──────────┘
                       │
                       ▼
          ┌─────────────────────┐
          │   STELLAR TESTNET   │
          │   x402 USDC/XLM     │
          │   ~5s Settlement    │
          │   ~$0.00001 Fee     │
          └─────────────────────┘
```

### x402 Payment Flow (Orchestrator → Paywalled Agents)

```
Orchestrator ──GET /api/premium/research──▶ Server (x402 middleware)
Orchestrator ◀──402 Payment Required──────  Server
              {price: "$0.01", network: "stellar:testnet", payTo: "GBYN..."}

wrapFetchWithPayment auto-signs Stellar USDC tx via ExactStellarScheme
Orchestrator ──Retries with X-PAYMENT header──▶ Server
              Facilitator verifies + settles USDC on-chain (~5s)
Orchestrator ◀──200 OK + Claude response──────  Server
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm
- [Anthropic API key](https://console.anthropic.com)

### 1. Clone & Install

```bash
git clone https://github.com/Flamki/stellarmind.git
cd stellarmind
npm install
```

### 2. Setup Wallets (automatic)

```bash
npm run setup
```

This generates 3 Stellar testnet keypairs, funds them via Friendbot, and creates your `.env` file.

### 3. Add Your API Key

Edit `.env` and add your Anthropic API key:

```env
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### 4. Setup USDC for x402 Payments

The x402 protocol uses USDC for micropayments. Run the automated setup:

```bash
npm run setup:usdc   # Adds USDC trustlines to all wallets
```

Then get free testnet USDC from Circle:
1. Go to [faucet.circle.com](https://faucet.circle.com)
2. Select **Stellar Testnet**
3. Paste your orchestrator address (from `.env`: `ORCHESTRATOR_STELLAR_ADDRESS`)
4. Request USDC — you'll receive 10 testnet USDC

> **Note:** Without USDC, the system automatically falls back to XLM direct payments on Stellar testnet. Both produce real, verifiable on-chain transactions.

### 5. Start the Server

```bash
npm run dev
```

### 6. Open Dashboard

Visit **http://localhost:3001** — submit a task, set a budget, and watch agents work!

### 7. Run Recording Preflight (required)

Before recording your demo, run:

```bash
npm run preflight
```

This is a strict go/no-go check that validates:
- local server health
- x402 middleware enabled
- wallet trustlines and spendable USDC
- model access
- live x402 smoke task + on-chain transaction verification

If preflight fails, fix blockers before recording.

### 8. Run the CLI Demo

```bash
npm run demo
```

Runs 3 automated tasks including a budget-enforcement test. Prints all Stellar Expert links.

## 🎬 Winning Demo Runbook

Use the polished recording script in:

- [DEMO_RECORDING_SCRIPT.md](./DEMO_RECORDING_SCRIPT.md)

It includes:
- exact shot list and timing
- human-style voiceover beats
- tx-click proof flow for judges
- recovery steps if something breaks mid-recording

## 💎 Real Stellar Transactions

> Every agent-to-agent payment is a real Stellar testnet transaction. Click to verify on Stellar Expert.

| # | Transaction Hash | Task | Stellar Expert Link |
|---|-----------------|------|---------------------|
| 1 | `8b9a638a9710...` | AI payments research | [View TX ↗](https://stellar.expert/explorer/testnet/tx/8b9a638a971083eb0817135bbc8cd3dd79d6fd219bc6feff70b7f23c4767388c) |
| 2 | `c74c0b38f2dc...` | AI payments summary | [View TX ↗](https://stellar.expert/explorer/testnet/tx/c74c0b38f2dc60a219c6ce530c8f6901e5aeccaaea52595b5f951044c361c6c7) |
| 3 | `7b66835aae23...` | AI payments analysis | [View TX ↗](https://stellar.expert/explorer/testnet/tx/7b66835aae23e9e08abdaff1953b7e1d19c95c71beec8085ff2086a3e8d6e76e) |
| 4 | `03b173f731a9...` | Agent marketplace research | [View TX ↗](https://stellar.expert/explorer/testnet/tx/03b173f731a956e9e5218cbf5fd888e16c1817451a80e97448f167f669110247) |
| 5 | `95e6198efc4f...` | Agent marketplace summary | [View TX ↗](https://stellar.expert/explorer/testnet/tx/95e6198efc4f82169d25b53da8d51971c9d83d8a048d9ca091c3df068d1df20a) |
| 6 | `148acd3d0466...` | Agent marketplace analysis | [View TX ↗](https://stellar.expert/explorer/testnet/tx/148acd3d0466df49b20d2ac69b39db129a5427626d756c0308f691fedb506df0) |
| 7 | `b70dca84ca79...` | Quantum cryptography research | [View TX ↗](https://stellar.expert/explorer/testnet/tx/b70dca84ca793871d64b36b772363106c87eb6b172004fdf1c9d7305a97d8aa7) |
| 8 | `71362065946768...` | Quantum cryptography summary | [View TX ↗](https://stellar.expert/explorer/testnet/tx/71362065946768751c5f822581d2f46cacb6eb5f8f8e156f3f84cf162ad6502e) |

*30+ total Stellar testnet transactions generated across demo runs. All verified on [Stellar Expert](https://stellar.expert/explorer/testnet).*

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Payment Protocol | `@x402/express`, `@x402/stellar` | HTTP 402 paywall middleware |
| Blockchain | `@stellar/stellar-sdk` | Wallet management, XLM payments |
| AI | `@anthropic-ai/sdk` | Claude Haiku (speed) + Sonnet (depth) |
| Backend | Express.js (Node.js) | API server + SSE event stream |
| Frontend | Vanilla HTML/CSS/JS | Real-time dashboard with budget controls |
| Network | Stellar Testnet | USDC + XLM micropayments |
| Facilitator | x402.org | Payment verification + settlement |

## 📁 Project Structure

```
stellarmind/
├── src/
│   ├── server.js              ← Express app + x402 middleware + SSE
│   ├── config.js              ← Environment configuration
│   ├── setup-wallets.js       ← Auto wallet generation + funding
│   ├── demo.js                ← CLI demo script
│   ├── agents/
│   │   ├── registry.js        ← Agent service catalog
│   │   ├── orchestrator.js    ← Claude-powered task decomposition
│   │   └── services.js        ← Real Anthropic API service endpoints
│   └── stellar/
│       └── wallet.js          ← Stellar SDK wrapper
├── public/
│   └── index.html             ← Real-time dashboard
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## 🔑 Key Features

### 🧠 Real AI Intelligence
Every agent uses real Anthropic Claude API calls — not mocked responses. The orchestrator uses Claude to plan which agents to hire and assembles their outputs into coherent results.

### 💰 x402 Payment Protocol  
Uses the official `@x402/express` middleware from the Stellar x402 quickstart. Premium endpoints return HTTP 402 with payment instructions. Clients sign Stellar transactions and retry with payment proof.

### 📊 Spending Policy (Budget Slider)
The dashboard includes a budget slider. The orchestrator respects the budget limit — if a subtask would exceed the remaining budget, it's skipped. This demonstrates **programmable guardrails** for agent spending.

### 📡 Real-Time Dashboard
Server-Sent Events (SSE) stream agent activity to the dashboard in real-time. Watch agents activate, payments settle, and results appear — all live.

### 🔗 Stellar Explorer Links
Every payment generates a clickable link to [stellar.expert](https://stellar.expert/explorer/testnet) where judges can verify the real on-chain transaction.

## ⚠️ Known Limitations

- **Testnet only** — not deployed to Stellar mainnet
- **Claude API latency** — real API calls take 1-3 seconds per agent (not instant)
- **No Soroban contracts** — spending policies are enforced server-side, not on-chain
- **No persistent storage** — transaction history resets on server restart
- **USDC trustline required** — for full x402 flow, wallets need USDC trustline setup

## 🔮 What's Next

- **Soroban spending contracts** — on-chain budget enforcement
- **MPP integration** — Machine Payments Protocol for streaming payments
- **Agent reputation** — on-chain quality scores based on service history
- **Mainnet deployment** — real USDC payments for production agent marketplace
- **Multi-model support** — GPT-4, Gemini, and open-source models as agent backends

## 📄 License

MIT — Built with ⚡ for the Agents on Stellar Hackathon

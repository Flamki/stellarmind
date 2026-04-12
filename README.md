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

### x402 Payment Flow

```
Client ──GET /api/premium/research──▶ Server
Client ◀──402 Payment Required──── Server
         {price: "$0.01", network: "stellar:testnet"}

Client ──Signs Stellar tx, retries with X-PAYMENT header──▶ Server
         Facilitator verifies + settles on-chain
Client ◀──200 OK + Claude response──── Server
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm
- [Anthropic API key](https://console.anthropic.com)

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/stellarmind.git
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

### 4. (Optional) Get Testnet USDC

For full x402 USDC payments:
1. Create a USDC trustline at [lab.stellar.org/account/fund](https://lab.stellar.org/account/fund)
2. Get testnet USDC from [faucet.circle.com](https://faucet.circle.com) (select Stellar Testnet)

### 5. Start the Server

```bash
npm run dev
```

### 6. Open Dashboard

Visit **http://localhost:3001** — submit a task, set a budget, and watch agents work!

### 7. Run the CLI Demo

```bash
npm run demo
```

Runs 3 automated tasks including a budget-enforcement test. Prints all Stellar Expert links.

## 💎 Real Stellar Transactions

> Every agent-to-agent payment is a real Stellar testnet transaction. Click to verify on Stellar Expert.

| # | Transaction Hash | Stellar Expert Link |
|---|-----------------|---------------------|
| 1 | `b0a4836daae9...021cbe` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/b0a4836daae9729ed993b056fa9550fda3655f13fc1720dd42c08bdaaf021cbe) |
| 2 | `44871745407d...68114d` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/44871745407d52251a17ae134158c38162d922bc85b2e482120ad2fbf468114d) |
| 3 | `a18fa781b969...56b187` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/a18fa781b9692264c5af29bc82a14acb768dd1ca3851b368a8e10eca5556b187) |
| 4 | `d9bca02556b1...18758a` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/d9bca02556b1d557d2d7586846c1f05b2ca498b6a9da3960d820859cea18758a) |
| 5 | `abb47eb05074...dcddba` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/abb47eb05074c67874dcb693109b302b0495d16ca2e288a778638a62efdcddba) |
| 6 | `848742135a66...e8810` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/848742135a667ef537054452b234b21f664c915734c1e20fedba1256ddfe8810) |
| 7 | `d1658729bd0a...b3c2c2` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/d1658729bd0a983230b6ef9e3318e5c818d6e6ebfd3271fce1b288106eb3c2c2) |
| 8 | `da10d74bd694...03fb99` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/da10d74bd694baa5dffc696268117192bfbfa7c9e00112c7e2376672b903fb99) |
| 9 | `64284d3a7184...311149` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/64284d3a718441a6daaa0a9f3d366451497995bd971a3f684ec8da33c7311149) |
| 10 | `b24bb75b7bd4...4775be` | [View on Explorer](https://stellar.expert/explorer/testnet/tx/b24bb75b7bd435a284714dffb3d047f56273cf3646266484ebe2ee2e504775be) |

*13 total real Stellar testnet transactions generated across demo runs.*

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

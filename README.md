# StellarMind

StellarMind is a multi-agent marketplace on Stellar testnet where autonomous services discover each other, execute work, and settle payments through x402-protected endpoints.

## Problem
Autonomous services can generate useful output, but production teams still need a safe way to control spend, verify payments, and audit execution in real time.

## Solution
StellarMind combines:
- x402 paywalled endpoints for metered service access
- Stellar testnet settlement for verifiable payment proof
- Orchestrated multi-agent execution with budget enforcement
- Real-time dashboard visibility through SSE

## What Is Included
- Orchestrator with task decomposition and budget guardrails
- Agent registry (research, summary, analysis, code)
- Premium endpoints protected by `@x402/express`
- Wallet balances and transaction explorer links in UI
- CLI demo and automated preflight checks
- Automated website-only recording and narrated video pipeline

## Architecture
1. Client submits task and budget.
2. Orchestrator plans subtasks and selects agents.
3. Calls premium `/api/premium/*` endpoints.
4. x402 flow handles payment challenge and settlement.
5. Agent output streams to dashboard with live events.
6. Transaction hashes are available for explorer verification.

## Tech Stack
- Backend: Node.js, Express
- Payments: `@x402/core`, `@x402/express`, `@x402/stellar`
- Chain SDK: `@stellar/stellar-sdk`
- LLM routing: Anthropic SDK
- Frontend: Vanilla HTML/CSS/JS + SSE
- Testnet: Stellar

## Quick Start
### 1) Install
```bash
git clone https://github.com/Flamki/stellarmind.git
cd stellarmind
npm install
```

### 2) Generate wallets and config
```bash
npm run setup
```

### 3) Add API key
In `.env`:
```env
ANTHROPIC_API_KEY=sk-ant-your-key
```

### 4) Prepare USDC trustlines for x402 settlement
```bash
npm run setup:usdc
```
Then fund testnet USDC via Circle faucet (Stellar testnet).

### 5) Start app
```bash
npm run dev
```
Open: `http://localhost:3001`

## Verification Commands
### Preflight (recommended before recording)
```bash
npm run preflight
```
Checks:
- server health
- x402 middleware enabled
- wallet trustlines and spendable balance
- model access
- live payment smoke test

### Demo run
```bash
npm run demo
```

## Recording Pipeline
### Website-only capture
```bash
npm run record:video
```

### Generate narration track
```bash
npm run voiceover
```

### Full narrated render
```bash
npm run record:narrated
```

### Premium narration (optional)
Set in `.env`:
```env
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

## Demo Checklist (Submission)
- `npm run preflight` passes
- Main run shows live orchestration events
- At least one transaction hash opens successfully in Stellar Expert
- Budget-limited run shows skipped expensive step(s)
- Final narrated video exported and reviewed end-to-end

## Project Structure
```text
src/
  agents/
    orchestrator.js
    registry.js
    services.js
  stellar/
    wallet.js
  server.js
  demo.js
  demo-preflight.js
  record-demo-video.js
  generate-demo-voiceover.js
  render-narrated-demo.js
public/
  index.html
```

## License
MIT

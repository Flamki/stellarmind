# StellarMind Winning Demo Script (2:30 to 3:30)

This runbook is designed for judges, not developers. It is paced, human, and proof-first.

## 1) Before You Hit Record (mandatory)

Open terminal A:

```bash
npm run dev
```

Open terminal B:

```bash
npm run preflight
```

Do not record until `npm run preflight` ends with:

```text
READY  Demo is recording-ready for judges.
```

If preflight fails, fix the blocker first. The most common blocker is zero USDC in orchestrator wallet.

## 2) Video Structure (exact shot list)

### Scene 1 - Credibility in 20 seconds
- Show terminal B `preflight` output.
- Pause on:
  - `x402 middleware reports enabled`
  - `Live task settled via x402`
  - `On-chain verified: <hash>`

Voiceover line:
"Before demoing UI, I run a strict preflight that checks live x402 settlement and verifies transaction hashes directly on Horizon."

### Scene 2 - Dashboard + wallets (15 seconds)
- Open `http://localhost:3001`.
- Stay on `Orchestrator` page.
- Point at wallet balances and budget slider.

Voiceover line:
"This is a live multi-agent marketplace on Stellar testnet. Payments are metered per agent call, with budget limits enforced per task."

### Scene 3 - Main orchestration run (60 to 80 seconds)
- Task input:
  - `Research practical enterprise use cases for x402 micropayments and recommend go-to-market strategy.`
- Budget:
  - `0.15`
- Click `Run Orchestration`.
- Keep cursor still and let SSE stream events naturally.
- Wait until result panel renders.

What to highlight live:
- `orchestrator_plan`
- `agent_call` and `agent_response`
- `payment` events
- Result chips showing spend and tx count

Voiceover line:
"Claude plans the workflow, hires specialist agents, and each premium call triggers payment settlement. All events are streamed in real time."

### Scene 4 - Hard proof: click transaction hashes (40 seconds)
- In result panel, click first `TX` link.
- In Stellar Expert tab, show:
  - full tx hash
  - successful status
  - ledger / timestamp
- Go back and open another tx link.
- Repeat quickly.

Voiceover line:
"These are live on-chain proofs, not simulated IDs. Every hash in the UI is clickable and independently verifiable on Stellar Expert."

### Scene 5 - Budget guardrail test (35 seconds)
- Back in app, set task:
  - `Analyze post-quantum migration strategy for fintech payment rails.`
- Set budget:
  - `0.02`
- Run again.
- Show that only low-cost agents run and expensive ones are skipped or capped by budget.

Voiceover line:
"This second run shows deterministic spend control. The orchestrator enforces budget in-loop and stops hiring when remaining funds are insufficient."

### Scene 6 - API status + architecture close (20 seconds)
- Go to `API Status` page.
- Briefly show premium endpoint list and payment flow card.
- End on `Transactions` page where hashes are listed and clickable.

Voiceover line:
"So this is production-shaped architecture: x402 paywalled endpoints, real-time orchestration, and on-chain verifiability end-to-end."

## 3) What Judges Must See (non-negotiable)

- A successful preflight run.
- At least one task with `x402` payment protocol, not only fallback.
- At least one clicked tx hash on Stellar Expert with successful transaction details.
- A budget-constrained second run.
- No dead time, no debugging on camera.

## 4) Recording Notes (to sound natural, not robotic)

- Speak in short lines while actions are visible.
- Avoid saying "trust me" or "should work".
- Say concrete facts with evidence: "Here is the hash", "Here is successful status", "Here is spend."
- Keep energy calm and confident.

## 5) Fast Recovery Plan If Something Breaks Mid-Recording

1. Stop recording immediately.
2. Run `npm run preflight`.
3. If USDC balance is zero, fund orchestrator wallet via `https://faucet.circle.com`.
4. Re-run preflight and only restart recording after green status.

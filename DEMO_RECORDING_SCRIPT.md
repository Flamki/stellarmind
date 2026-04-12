# StellarMind Winning Demo Script (2:30 to 3:00)

This is the judge-facing runbook: problem first, evidence second, architecture close.

## 1) Core Narrative (say this in plain English)

- Problem: AI agents can reason, but they cannot safely pay each other per request.
- Approach: x402 paywalled endpoints on Stellar + Claude orchestration + strict budget guardrails.
- Proof: clickable on-chain transaction hashes during the demo.

## 2) Exact Scene Order (website-only capture)

1. Orchestrator intro (10s): show task box, budget slider, wallet balances.
2. Agent Registry (15s): show all 4 agents, model and price tiers.
3. API Status (20s): show premium endpoint list and payment flow surface.
4. Main run (60-80s): run task with 0.15 budget and let SSE stream events.
5. Proof click 1 (12s): click TX from result chips and show Stellar Expert details.
6. Budget guardrail run (35-45s): run second task with 0.02 budget.
7. Proof click 2 (12s): open Transactions page, click first hash, show it resolves.
8. Close (10s): return to API Status then Transactions to reinforce architecture + proof.

Note:
- The recorder now keeps proof clicks in the same browser tab (no pop-out tab switching).

## 3) Voiceover Script Source

- Narration text file: `DEMO_VOICEOVER.txt`
- The automation uses this file to generate AI voice audio.
- Edit wording there if you want your own tone before rendering.

## 4) One-Command Narrated Output

```bash
npm run record:narrated
```

This performs:

1. local server start
2. strict preflight (`x402` + on-chain verify)
3. website-only scripted recording
4. AI voice generation
5. final MP4 mux

Final output path is printed and also saved in `recordings/latest-narrated.txt`.

## 5) Non-Negotiable Judge Proof Checklist

- `npm run preflight` reaches `READY`.
- Main run reports real `x402` settlement events.
- At least one transaction hash is clicked and shown on Stellar Expert.
- Second run demonstrates budget-limited behavior.
- No debug detours in the final submitted video.

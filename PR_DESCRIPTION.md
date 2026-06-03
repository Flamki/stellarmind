# docs: add architecture-at-a-glance doc with flow diagrams

Closes #49

## What changed

- Added `docs/architecture.md` — a standalone architecture doc with an
  at-a-glance component map and concise text diagrams for the **request**,
  **payment**, and **orchestration** flows. Content reflects the current
  implementation under `src/` (Express server, x402 paywall, pricing config,
  agent registry/services, orchestrator, Stellar wallet, settlement header).
- Linked the new doc from `README.md` under the high-level architecture section.

## How to verify

- `npm test` passes (settlement-header parser tests).
- All relative links in `docs/architecture.md` resolve to existing files.
- README renders a working link to `docs/architecture.md`.

## Definition of Done

- [x] New doc exists and reflects current implementation
- [x] README links to the new architecture doc

Docs-only change — no source or runtime behavior is affected. Related: #36

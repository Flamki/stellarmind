# docs: add architecture-at-a-glance doc with flow diagrams

Closes #49

## What changed

- Added `docs/architecture.md` — a standalone architecture doc with an at-a-glance component map and
  concise text diagrams for the **request**, **payment**, and **orchestration** flows. Content
  reflects the current implementation under `src/` (Express server, x402 paywall, pricing config,
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

---

## feat: add pre-commit hooks for linting and secret scanning

### What changed

- **Configured Husky & lint-staged:** Added a pre-commit framework to ensure code quality before
  pushing. `lint-staged` is configured to run the project's existing ESLint and Prettier setups
  automatically on staged `.js`, `.ts`, `.md`, and `.yml` files.
- **Added Secret Pattern Scanner:** Implemented a lightweight bash script
  (`.husky/check-secrets.sh`) that rapidly scans staged files for common credential patterns (AWS,
  Google, GitHub, Slack tokens, private keys, hardcoded passwords).
- **Updated Documentation:** Added a dedicated `## Pre-Commit Hooks` section to `CONTRIBUTING.md`
  detailing the hook behaviors, automatic setup via `npm install`, and instructions on how to bypass
  them (`--no-verify`) in emergencies.

### How to verify

1. **Lint/Format test:**
   - Modify a tracked `.js` or `.md` file to contain a minor formatting issue.
   - Stage the file (`git add <file>`) and commit. The file should be auto-formatted by Prettier and
     linted by ESLint before the commit succeeds.
2. **Secret Scan test:**
   - Create a dummy file or edit a tracked file and add `password="secret_value_123"`.
   - Stage the file and attempt to commit. The commit should be aborted with a `❌ SECRET DETECTED`
     error message.
3. **Bypass test:**
   - Run `git commit --no-verify -m "test bypass"` to confirm the emergency bypass functionality
     works as documented.

### Definition of Done

- [x] Hooks execute quickly (under 5 seconds)
- [x] Only staged files are scanned
- [x] Does not introduce any new heavy dependencies or external tools beyond Husky and lint-staged
- [x] New behaviors and bypasses are properly documented in `CONTRIBUTING.md`
